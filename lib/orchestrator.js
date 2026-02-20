const { v4: uuidv4 } = require("uuid");

const store = require("./store");
const logger = require("./logger");

const config = require("./agents/agentConfig");
const createAuthorAgent = require("./agents/authorAgent");
const createPsychologistAgent = require("./agents/psychologistAgent");
const createEditorAgent = require("./agents/editorAgent");
const createIllustratorAgent = require("./agents/illustratorAgent");
const createMarketerAgent = require("./agents/marketerAgent");
const createNarrationAgent = require("./agents/narrationAgent");

const researchTool = require("./tools/researchTool");
const readabilityTool = require("./tools/readabilityTool");
const grammarTool = require("./tools/grammarTool");
const illustrationTool = require("./tools/illustrationTool");
const publishTool = require("./tools/publishTool");

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }

    await new Promise((resolve) => {
      this.queue.push(resolve);
    });
    this.current += 1;
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

class Orchestrator {
  constructor(options = {}) {
    this.maxConcurrentTools = Number(options.maxConcurrentTools || process.env.MAX_CONCURRENT_TOOLS || 3);
    this.stepTimeoutMs = Number(options.stepTimeoutMs || process.env.STEP_TIMEOUT_MS || 30000);
    this.runningStories = new Map();
  }

  async _withStepTimeout(promise, stepId) {
    const timeoutMs = Math.max(1000, Number(this.stepTimeoutMs) || 30000);
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Step '${stepId}' timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  _buildSteps() {
    return [
      { id: "plan", agent: config.orchestrator.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "author-draft", agent: config.author.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "psychology-review", agent: config.psychologist.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "editor-polish", agent: config.editor.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "illustration-meta", agent: config.illustrator.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "marketing-package", agent: config.marketer.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "narration-notes", agent: config.narrator.name, status: "queued", startedAt: null, endedAt: null, error: null },
      { id: "publish", agent: config.orchestrator.name, status: "queued", startedAt: null, endedAt: null, error: null }
    ];
  }

  _createStoryRecord(input) {
    const id = uuidv4();
    const now = new Date().toISOString();

    return {
      id,
      title: input.title,
      ageGroup: input.ageGroup,
      lengthTarget: input.lengthTarget,
      tone: input.tone,
      status: "queued",
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      steps: this._buildSteps(),
      artifacts: {
        plan: null,
        author: null,
        psychology: null,
        editor: null,
        illustrations: [],
        marketing: null,
        narration: null,
        finalPackage: null,
        publish: null
      }
    };
  }

  _storyByIdOrThrow(storyId) {
    const story = store.getStory(storyId);
    if (!story) {
      const err = new Error("Story not found");
      err.statusCode = 404;
      throw err;
    }
    return story;
  }

  _updateStep(storyId, stepId, patch) {
    return store.updateStory(storyId, (story) => {
      const steps = story.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
      return { ...story, steps, updatedAt: new Date().toISOString() };
    });
  }

  _emit(storyId, eventType, payload) {
    store.emitStoryEvent(storyId, eventType, payload);
  }

  _log(entry) {
    const rec = logger.log(entry);
    if (rec.storyId) {
      store.appendStoryLog(rec.storyId, rec);
    }
    return rec;
  }

  async _runTool({ storyId, semaphore, agent, step, toolName, input, handler }) {
    await semaphore.acquire();
    const started = Date.now();
    this._emit(storyId, "tool.started", { agent, step, tool: toolName, input });
    this._log({
      storyId,
      agent,
      step,
      tool: toolName,
      input,
      outputSummary: null,
      durationMs: 0,
      status: "running"
    });

    try {
      const output = await handler(input);
      const durationMs = Date.now() - started;
      const outputSummary = typeof output === "object" ? JSON.stringify(output).slice(0, 400) : String(output);

      this._emit(storyId, "tool.finished", { agent, step, tool: toolName, durationMs, outputSummary });
      this._log({
        storyId,
        agent,
        step,
        tool: toolName,
        input,
        outputSummary,
        durationMs,
        status: "succeeded"
      });

      return output;
    } catch (error) {
      const durationMs = Date.now() - started;
      this._emit(storyId, "tool.failed", { agent, step, tool: toolName, error: error.message, durationMs });
      this._log({
        storyId,
        agent,
        step,
        tool: toolName,
        input,
        outputSummary: error.message,
        durationMs,
        status: "failed"
      });
      throw error;
    } finally {
      semaphore.release();
    }
  }

  _invalidateFromStep(storyId, stepId) {
    return store.updateStory(storyId, (story) => {
      const idx = story.steps.findIndex((s) => s.id === stepId);
      if (idx < 0) return story;

      const nextSteps = story.steps.map((step, i) => {
        if (i >= idx) {
          return {
            ...step,
            status: "queued",
            startedAt: null,
            endedAt: null,
            error: null
          };
        }
        return step;
      });

      const nextArtifacts = { ...story.artifacts };
      if (idx <= 1) nextArtifacts.author = null;
      if (idx <= 2) nextArtifacts.psychology = null;
      if (idx <= 3) nextArtifacts.editor = null;
      if (idx <= 4) nextArtifacts.illustrations = [];
      if (idx <= 5) nextArtifacts.marketing = null;
      if (idx <= 6) nextArtifacts.narration = null;
      if (idx <= 7) {
        nextArtifacts.finalPackage = null;
        nextArtifacts.publish = null;
      }

      return {
        ...story,
        status: "queued",
        artifacts: nextArtifacts,
        updatedAt: new Date().toISOString()
      };
    });
  }

  _canRun(story) {
    return !TERMINAL_STATUSES.has(story.status) || story.status === "failed";
  }

  async _waitForStoryIdle(storyId, timeoutMs = 15000) {
    const started = Date.now();
    while (this.runningStories.get(storyId)) {
      if (Date.now() - started > timeoutMs) {
        const err = new Error("Story is still running. Try rerun/retry again in a moment.");
        err.statusCode = 409;
        throw err;
      }
      await sleep(25);
    }
  }

  _buildAgentSet(storyId, semaphore, memory) {
    const tools = {
      researchTool: (input, step, agent) => this._runTool({
        storyId,
        semaphore,
        agent,
        step,
        toolName: "researchTool",
        input,
        handler: researchTool
      }),
      readabilityTool: (input, step, agent) => this._runTool({
        storyId,
        semaphore,
        agent,
        step,
        toolName: "readabilityTool",
        input,
        handler: readabilityTool
      }),
      grammarTool: (input, step, agent) => this._runTool({
        storyId,
        semaphore,
        agent,
        step,
        toolName: "grammarTool",
        input,
        handler: grammarTool
      }),
      illustrationTool: (input, step, agent) => this._runTool({
        storyId,
        semaphore,
        agent,
        step,
        toolName: "illustrationTool",
        input,
        handler: illustrationTool
      })
    };

    const author = createAuthorAgent({
      config: config.author,
      tools: {
        researchTool: (input) => tools.researchTool(input, "author-draft", config.author.name),
        readabilityTool: (input) => tools.readabilityTool(input, "author-draft", config.author.name)
      },
      memory: memory.author
    });

    const psychologist = createPsychologistAgent({
      config: config.psychologist,
      memory: memory.psychologist
    });

    const editor = createEditorAgent({
      config: config.editor,
      tools: {
        grammarTool: (input) => tools.grammarTool(input, "editor-polish", config.editor.name),
        readabilityTool: (input) => tools.readabilityTool(input, "editor-polish", config.editor.name)
      },
      memory: memory.editor
    });

    const illustrator = createIllustratorAgent({
      config: config.illustrator,
      tools: {
        illustrationTool: (input) => tools.illustrationTool(input, "illustration-meta", config.illustrator.name)
      },
      memory: memory.illustrator
    });

    const marketer = createMarketerAgent({
      config: config.marketer,
      tools: {
        researchTool: (input) => tools.researchTool(input, "marketing-package", config.marketer.name)
      },
      memory: memory.marketer
    });

    const narrator = createNarrationAgent({
      config: config.narrator,
      memory: memory.narrator
    });

    return {
      author,
      psychologist,
      editor,
      illustrator,
      marketer,
      narrator,
      publish: (storyPackage) => this._runTool({
        storyId,
        semaphore,
        agent: config.orchestrator.name,
        step: "publish",
        toolName: "publishTool",
        input: { id: storyPackage.id, title: storyPackage.title },
        handler: () => publishTool({
          storyPackage,
          persistStory: (id) => store.persistStoryToFile(id)
        })
      })
    };
  }

  async _executeStep(storyId, stepId, executeFn) {
    const story = this._storyByIdOrThrow(storyId);
    if (story.cancelRequested) {
      throw new Error("Story canceled");
    }

    const step = story.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Unknown step: ${stepId}`);
    }
    if (step.status === "succeeded") {
      return;
    }

    const startTime = new Date().toISOString();
    this._updateStep(storyId, stepId, { status: "running", startedAt: startTime, error: null });
    this._emit(storyId, "agent.started", { stepId, agent: step.agent });
    this._log({
      storyId,
      agent: step.agent,
      step: stepId,
      tool: null,
      input: null,
      outputSummary: null,
      durationMs: 0,
      status: "running"
    });

    const started = Date.now();
    try {
      const details = await this._withStepTimeout(executeFn(), stepId);
      const durationMs = Date.now() - started;
      const provider = details?.provider || null;
      const model = details?.model || null;
      const completionSummary = provider ? `completed via ${provider}${model ? ` (${model})` : ""}` : "completed";
      this._updateStep(storyId, stepId, { status: "succeeded", endedAt: new Date().toISOString(), error: null });
      this._emit(storyId, "agent.finished", { stepId, agent: step.agent, durationMs, provider, model });
      this._log({
        storyId,
        agent: step.agent,
        step: stepId,
        tool: null,
        input: null,
        outputSummary: completionSummary,
        durationMs,
        status: "succeeded"
      });
    } catch (error) {
      const durationMs = Date.now() - started;
      this._updateStep(storyId, stepId, { status: "failed", endedAt: new Date().toISOString(), error: error.message });
      this._emit(storyId, "agent.failed", { stepId, agent: step.agent, error: error.message, durationMs });
      this._log({
        storyId,
        agent: step.agent,
        step: stepId,
        tool: null,
        input: null,
        outputSummary: error.message,
        durationMs,
        status: "failed"
      });
      throw error;
    }
  }

  async runStory(storyId, { fromStepId = null } = {}) {
    const existingRun = this.runningStories.get(storyId);
    if (existingRun) {
      return;
    }

    const semaphore = new Semaphore(this.maxConcurrentTools);
    const memory = {
      author: {}, psychologist: {}, editor: {}, illustrator: {}, marketer: {}, narrator: {}
    };
    const agents = this._buildAgentSet(storyId, semaphore, memory);

    this.runningStories.set(storyId, true);
    try {
      store.updateStory(storyId, (story) => ({ ...story, status: "running", updatedAt: new Date().toISOString() }));
      this._emit(storyId, "story.started", { storyId });

      const story = this._storyByIdOrThrow(storyId);
      const steps = story.steps.map((s) => s.id);
      const startIdx = fromStepId ? Math.max(0, steps.indexOf(fromStepId)) : 0;

      const executePlan = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const plan = {
          brief: {
            title: current.title,
            ageGroup: current.ageGroup,
            lengthTarget: current.lengthTarget,
            tone: current.tone
          },
          world: [
            "Sunny hill town with breezy skies",
            "Tim's cozy home and practice field",
            "Friendly animal neighbors"
          ],
          characters: [
            "Tim the dog: brave, kind, determined",
            "Lila the bird: tiny, clever, encouraging"
          ],
          plotBeats: [
            "Tim dreams of flying",
            "Practice setbacks",
            "Kind rescue moment",
            "Successful glide and shared joy"
          ]
        };

        store.updateStory(storyId, (s) => ({
          ...s,
          artifacts: { ...s.artifacts, plan },
          updatedAt: new Date().toISOString()
        }));
        this._emit(storyId, "plan.created", plan);
      };

      const executeAuthor = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const authorOut = await agents.author.run({
          storyId,
          brief: {
            title: current.title,
            ageGroup: current.ageGroup,
            tone: current.tone,
            lengthTarget: current.lengthTarget
          },
          characterSheet: current.artifacts.plan?.characters || [],
          plotOutline: current.artifacts.plan?.plotBeats || [],
          previousDraft: current.artifacts.author?.sceneDrafts || []
        });

        store.updateStory(storyId, (s) => ({
          ...s,
          artifacts: { ...s.artifacts, author: authorOut },
          updatedAt: new Date().toISOString()
        }));

        return {
          provider: authorOut?._agentMeta?.provider || null,
          model: authorOut?._agentMeta?.model || null
        };
      };

      const executePsychology = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const text = (current.artifacts.author?.sceneDrafts || []).join("\n\n");
        const out = await agents.psychologist.run({ text });
        store.updateStory(storyId, (s) => ({ ...s, artifacts: { ...s.artifacts, psychology: out }, updatedAt: new Date().toISOString() }));
        if (!out.safe) {
          throw new Error("Psychology review failed safety check");
        }

        return {
          provider: out?._agentMeta?.provider || null,
          model: out?._agentMeta?.model || null
        };
      };

      const executeEditor = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const text = (current.artifacts.author?.sceneDrafts || []).join("\n\n");
        const out = await agents.editor.run({ text, ageGroup: current.ageGroup });
        store.updateStory(storyId, (s) => ({ ...s, artifacts: { ...s.artifacts, editor: out }, updatedAt: new Date().toISOString() }));
        return {
          provider: out?._agentMeta?.provider || null,
          model: out?._agentMeta?.model || null
        };
      };

      const executeIllustrations = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const scenes = current.artifacts.author?.sceneDrafts || [];
        const items = [];
        for (let i = 0; i < scenes.length; i += 1) {
          const item = await agents.illustrator.run({ sceneDescription: scenes[i], sceneIndex: i + 1 });
          items.push(item);
        }
        store.updateStory(storyId, (s) => ({ ...s, artifacts: { ...s.artifacts, illustrations: items }, updatedAt: new Date().toISOString() }));
        const lastMeta = items[items.length - 1]?._agentMeta || null;
        return {
          provider: lastMeta?.provider || null,
          model: lastMeta?.model || null
        };
      };

      const executeMarketing = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const out = await agents.marketer.run({ title: current.title, ageGroup: current.ageGroup });
        store.updateStory(storyId, (s) => ({ ...s, artifacts: { ...s.artifacts, marketing: out }, updatedAt: new Date().toISOString() }));
        return {
          provider: out?._agentMeta?.provider || null,
          model: out?._agentMeta?.model || null
        };
      };

      const executeNarration = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const text = current.artifacts.editor?.editedText || "";
        const out = await agents.narrator.run({ text });
        store.updateStory(storyId, (s) => ({ ...s, artifacts: { ...s.artifacts, narration: out }, updatedAt: new Date().toISOString() }));
      };

      const executePublish = async () => {
        const current = this._storyByIdOrThrow(storyId);
        const finalText = current.artifacts.editor?.editedText || "";

        const storyPackage = {
          id: current.id,
          title: current.title,
          ageGroup: current.ageGroup,
          tone: current.tone,
          lengthTarget: current.lengthTarget,
          text: finalText,
          artifacts: {
            plan: current.artifacts.plan,
            sceneDrafts: current.artifacts.author?.sceneDrafts || [],
            psychology: current.artifacts.psychology,
            illustrations: current.artifacts.illustrations,
            marketing: current.artifacts.marketing,
            narration: current.artifacts.narration
          }
        };

        const published = await agents.publish(storyPackage);

        store.updateStory(storyId, (s) => ({
          ...s,
          artifacts: {
            ...s.artifacts,
            finalPackage: storyPackage,
            publish: published
          },
          status: "completed",
          updatedAt: new Date().toISOString()
        }));
      };

      const stepExecutors = {
        plan: executePlan,
        "author-draft": executeAuthor,
        "psychology-review": executePsychology,
        "editor-polish": executeEditor,
        "illustration-meta": executeIllustrations,
        "marketing-package": executeMarketing,
        "narration-notes": executeNarration,
        publish: executePublish
      };

      for (let i = startIdx; i < steps.length; i += 1) {
        const current = this._storyByIdOrThrow(storyId);
        if (current.cancelRequested) {
          store.updateStory(storyId, (s) => ({ ...s, status: "canceled", updatedAt: new Date().toISOString() }));
          this._emit(storyId, "story.canceled", { storyId });
          return;
        }

        const stepId = steps[i];
        await this._executeStep(storyId, stepId, stepExecutors[stepId]);
        await sleep(30);
      }

      const after = this._storyByIdOrThrow(storyId);
      if (after.status !== "canceled") {
        store.updateStory(storyId, (s) => ({ ...s, status: "completed", updatedAt: new Date().toISOString() }));
        this._emit(storyId, "story.completed", { storyId, publish: after.artifacts.publish });
      }
    } catch (error) {
      store.updateStory(storyId, (story) => ({
        ...story,
        status: story.cancelRequested ? "canceled" : "failed",
        updatedAt: new Date().toISOString()
      }));
      this._emit(storyId, "story.failed", { storyId, error: error.message });
      this._log({
        storyId,
        agent: config.orchestrator.name,
        step: "story-run",
        tool: null,
        input: null,
        outputSummary: error.message,
        durationMs: 0,
        status: "failed"
      });
    } finally {
      this.runningStories.delete(storyId);
    }
  }

  async startStory(input) {
    const story = this._createStoryRecord(input);
    store.createStory(story);

    this.runStory(story.id).catch(() => {
      // errors are handled inside runStory and logged
    });

    return {
      id: story.id,
      streamUrl: `/stories/${story.id}/stream`
    };
  }

  getStoryStatus(storyId) {
    return this._storyByIdOrThrow(storyId);
  }

  listStories() {
    return store.listStories();
  }

  getStoryLogs(storyId, { page, pageSize } = {}) {
    const items = store.getStoryLogs(storyId);
    const safePage = Math.max(1, Number(page || 1));
    const safePageSize = Math.max(1, Math.min(500, Number(pageSize || 200)));
    const start = (safePage - 1) * safePageSize;
    const sliced = items.slice(start, start + safePageSize);

    return {
      page: safePage,
      pageSize: safePageSize,
      total: items.length,
      items: sliced
    };
  }

  getAdminLogs({ storyId, page, pageSize } = {}) {
    return logger.getLogs({ storyId, page, pageSize });
  }

  getStoryResult(storyId) {
    const story = this._storyByIdOrThrow(storyId);
    if (!story.artifacts.finalPackage) {
      const err = new Error("Story result not ready");
      err.statusCode = 409;
      throw err;
    }

    return {
      id: story.id,
      status: story.status,
      package: story.artifacts.finalPackage,
      publish: story.artifacts.publish
    };
  }

  cancelStory(storyId) {
    const story = this._storyByIdOrThrow(storyId);
    if (TERMINAL_STATUSES.has(story.status)) {
      return story;
    }

    const updated = store.updateStory(storyId, (s) => ({
      ...s,
      cancelRequested: true,
      updatedAt: new Date().toISOString()
    }));
    this._emit(storyId, "story.cancel-requested", { storyId });
    return updated;
  }

  async retryStep(storyId, stepId) {
    await this._waitForStoryIdle(storyId);
    const story = this._storyByIdOrThrow(storyId);
    const step = story.steps.find((s) => s.id === stepId);
    if (!step) {
      const err = new Error("Step not found");
      err.statusCode = 404;
      throw err;
    }
    if (step.status !== "failed") {
      const err = new Error("Only failed steps can be retried");
      err.statusCode = 400;
      throw err;
    }

    this._invalidateFromStep(storyId, stepId);
    this._emit(storyId, "step.retry-requested", { storyId, stepId });
    await this.runStory(storyId, { fromStepId: stepId });
    return this._storyByIdOrThrow(storyId);
  }

  async rerunStep(storyId, stepId) {
    await this._waitForStoryIdle(storyId);
    this._storyByIdOrThrow(storyId);
    this._invalidateFromStep(storyId, stepId);
    this._emit(storyId, "step.rerun-requested", { storyId, stepId });
    await this.runStory(storyId, { fromStepId: stepId });
    return this._storyByIdOrThrow(storyId);
  }
}

module.exports = new Orchestrator();

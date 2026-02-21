/*
  Centralized wrapper for @openai/agents integration.
  If SDK details vary, keep the same method signature and swap internals here.
*/

function createOpenAIAgentClient() {
  let mode = (process.env.AGENT_MODE || "mock").toLowerCase();
  let model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  let enabled = Boolean(process.env.OPENAI_API_KEY);
  let timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 60000);
  let maxTurns = Number(process.env.AGENT_MAX_TURNS || 25);
  let allowMockFallback = String(process.env.OPENAI_ALLOW_MOCK_FALLBACK || "true").toLowerCase() === "true";
  let sdkCache = null;
  let runnerCache = null;
  let warned = false;

  function refreshFromEnv() {
    enabled = Boolean(process.env.OPENAI_API_KEY);
    model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 60000);
    maxTurns = Number(process.env.AGENT_MAX_TURNS || 25);
    allowMockFallback = String(process.env.OPENAI_ALLOW_MOCK_FALLBACK || "true").toLowerCase() === "true";
  }

  function getSupportedModes() {
    return ["mock", "openai"];
  }

  function getMode() {
    return mode;
  }

  function setMode(nextModeRaw) {
    const nextMode = String(nextModeRaw || "").toLowerCase();
    if (!getSupportedModes().includes(nextMode)) {
      throw new Error(`Unsupported mode: ${nextModeRaw}. Supported modes: ${getSupportedModes().join(", ")}`);
    }
    mode = nextMode;
    return mode;
  }

  function ensureOpenAIModeReady() {
    if (mode !== "openai") return;
    if (!enabled) {
      throw new Error("AGENT_MODE=openai requires OPENAI_API_KEY to be set.");
    }
  }

  function loadSdk() {
    if (sdkCache) return sdkCache;
    try {
      sdkCache = require("@openai/agents");
      return sdkCache;
    } catch (_error) {
      throw new Error("AGENT_MODE=openai requires @openai/agents to be installed. Run `npm install @openai/agents`.");
    }
  }

  function getRunner(sdk) {
    if (runnerCache) return runnerCache;
    if (typeof sdk?.Runner === "function") {
      runnerCache = new sdk.Runner();
    }
    return runnerCache;
  }

  function createRunnerWithTools(sdk, sdkTools) {
    if (typeof sdk?.Runner !== "function") return null;
    try {
      return new sdk.Runner({ tools: sdkTools });
    } catch (_e) {
      return getRunner(sdk);
    }
  }

  async function withTimeout(promise, label) {
    const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 60000);
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `${label} timed out after ${safeTimeoutMs}ms. Set AGENT_TIMEOUT_MS to adjust, or switch to AGENT_MODE=mock.`
              )
            );
          }, safeTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function extractJsonObjectFromText(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_e) {
      // continue
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const slice = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(slice);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (_e) {
        return null;
      }
    }

    return null;
  }

  function extractTextCandidates(value, bucket = [], depth = 0) {
    if (depth > 5 || value == null) return bucket;
    if (typeof value === "string") {
      if (value.trim()) bucket.push(value);
      return bucket;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        extractTextCandidates(item, bucket, depth + 1);
      }
      return bucket;
    }

    if (typeof value === "object") {
      const preferredKeys = ["text", "output_text", "finalOutput", "output", "content", "message"];
      for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          extractTextCandidates(value[key], bucket, depth + 1);
        }
      }
      for (const next of Object.values(value)) {
        extractTextCandidates(next, bucket, depth + 1);
      }
    }

    return bucket;
  }

  function coerceSdkOutput(response) {
    if (!response) return null;

    const directCandidates = [
      response.output,
      response.finalOutput,
      response.final_output,
      response.lastAgentOutput,
      response
    ];

    for (const candidate of directCandidates) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate;
      }
      if (typeof candidate === "string") {
        const parsed = extractJsonObjectFromText(candidate);
        if (parsed) return parsed;
      }
    }

    const textCandidates = extractTextCandidates(response);
    for (const text of textCandidates) {
      const parsed = extractJsonObjectFromText(text);
      if (parsed) return parsed;
    }

    return null;
  }

  function buildJsonInstruction(baseInstruction) {
    return `${baseInstruction}\n\nReturn ONLY a valid JSON object. Do not include markdown, code fences, or extra prose.`;
  }

  function buildNoToolsInstruction(baseInstruction) {
    return `${buildJsonInstruction(baseInstruction)}\nDo not call any tools. Produce the final JSON answer directly.`;
  }

  function buildModelSettings() {
    return { response_format: { type: "json_object" } };
  }

  function getSafeMaxTurns() {
    return Math.max(1, Number(maxTurns) || 25);
  }

  function isMaxTurnsError(error) {
    const message = String(error?.message || "").toLowerCase();
    return message.includes("max turns") || message.includes("maxturnsexceeded");
  }

  async function runNoToolsRetry({ sdk, agentName, systemInstruction, input }) {
    const noToolsTurns = Math.min(4, getSafeMaxTurns());

    if (typeof sdk.runAgent === "function") {
      const response = await withTimeout(
        sdk.runAgent({
          name: agentName,
          model,
          modelSettings: buildModelSettings(),
          instructions: buildNoToolsInstruction(systemInstruction),
          input,
          maxTurns: noToolsTurns,
          tools: []
        }),
        `OpenAI no-tools retry (${agentName})`
      );
      return { response, executionPath: "runAgent(no-tools-retry)" };
    }

    if (typeof sdk.Agent === "function" && typeof sdk.run === "function") {
      const agent = new sdk.Agent({
        name: agentName,
        instructions: buildNoToolsInstruction(systemInstruction),
        model,
        modelSettings: buildModelSettings(),
        tools: []
      });

      const runner = getRunner(sdk);
      const runInput = typeof input === "string" ? input : JSON.stringify(input);
      const runOptions = { maxTurns: noToolsTurns };
      const runPromise = runner ? runner.run(agent, runInput, runOptions) : sdk.run(agent, runInput, runOptions);
      const response = await withTimeout(runPromise, `OpenAI no-tools retry (${agentName})`);
      return {
        response,
        executionPath: runner ? "Runner.run(no-tools-retry)" : "run(no-tools-retry)"
      };
    }

    return null;
  }

  function normalizeToolsForSdk(rawTools, sdk) {
    if (!Array.isArray(rawTools) || rawTools.length === 0) return [];

    const normalized = [];
    for (const item of rawTools) {
      if (!item || typeof item === "string") {
        continue;
      }

      if (typeof sdk.FunctionTool === "function" && item instanceof sdk.FunctionTool) {
        normalized.push(item);
        continue;
      }

      if (
        item &&
        typeof item === "object" &&
        item.name &&
        typeof sdk.tool === "function" &&
        (typeof item.execute === "function" || typeof item.handler === "function")
      ) {
        const parameters = item.parameters || item.schema || {
          type: "object",
          properties: {},
          additionalProperties: true
        };
        const execute = item.execute || (async (_ctx, args) => item.handler(_ctx, args));

        normalized.push(
          sdk.tool({
            name: item.name,
            description: item.description || `Function tool for ${item.name}`,
            parameters,
            execute
          })
        );
      }
    }

    return normalized;
  }

  async function fallbackOrThrow({ reason, mockHandler, agentName, systemInstruction, input, tools, provider }) {
    if (!allowMockFallback || typeof mockHandler !== "function") {
      throw new Error(`${reason} Set OPENAI_ALLOW_MOCK_FALLBACK=true to allow schema-safe mock fallback in openai mode.`);
    }

    if (!warned) {
      warned = true;
      console.warn(`${reason} Falling back to deterministic mock handler because OPENAI_ALLOW_MOCK_FALLBACK=true.`);
    }

    const fallback = await mockHandler({ agentName, systemInstruction, input, tools });
    return {
      ...fallback,
      meta: {
        ...(fallback.meta || {}),
        provider,
        mode: "openai",
        model,
        usedTools: tools || []
      }
    };
  }

  async function runAgent({ agentName, systemInstruction, input, tools, mockHandler }) {
    refreshFromEnv();
    ensureOpenAIModeReady();

    if (mode === "mock") {
      if (typeof mockHandler === "function") {
        return mockHandler({ agentName, systemInstruction, input, tools });
      }

      return {
        output: { note: `Stubbed response from ${agentName}`, inputEcho: input },
        meta: { provider: "stub", mode: "mock", usedTools: tools || [] }
      };
    }

    const sdk = loadSdk();
    const sdkTools = normalizeToolsForSdk(tools, sdk);

    if (typeof sdk.runAgent === "function") {
      try {
        const response = await withTimeout(
          sdk.runAgent({
            name: agentName,
            model,
            modelSettings: buildModelSettings(),
            instructions: buildJsonInstruction(systemInstruction),
            input,
            maxTurns: getSafeMaxTurns(),
            tools: sdkTools
          }),
          `OpenAI agent run (${agentName})`
        );

        const coercedOutput = coerceSdkOutput(response);
        if (!coercedOutput) {
          try {
            const retried = await runNoToolsRetry({ sdk, agentName, systemInstruction, input });
            const retriedOutput = coerceSdkOutput(retried?.response);
            if (retriedOutput) {
              return {
                output: retriedOutput,
                meta: {
                  provider: "@openai/agents",
                  mode: "openai",
                  model,
                  executionPath: retried.executionPath,
                  usedTools: []
                }
              };
            }
          } catch (_retryError) {
            // fall through to existing fallback path
          }

          return fallbackOrThrow({
            reason: "OpenAI runAgent returned non-JSON output.",
            mockHandler,
            agentName,
            systemInstruction,
            input,
            tools,
            provider: "openai-runAgent+mock-normalizer"
          });
        }

        return {
          output: coercedOutput ?? (response.output ?? response),
          meta: {
            provider: "@openai/agents",
            mode: "openai",
            model,
            executionPath: "runAgent",
            usedTools: tools || []
          }
        };
      } catch (error) {
        if (isMaxTurnsError(error)) {
          try {
            const retried = await runNoToolsRetry({ sdk, agentName, systemInstruction, input });
            const retriedOutput = coerceSdkOutput(retried?.response);
            if (retriedOutput) {
              return {
                output: retriedOutput,
                meta: {
                  provider: "@openai/agents",
                  mode: "openai",
                  model,
                  executionPath: retried.executionPath,
                  usedTools: []
                }
              };
            }
          } catch (_retryError) {
            // fall through to existing fallback path
          }
        }

        return fallbackOrThrow({
          reason: `OpenAI SDK call failed (${error.message}).`,
          mockHandler,
          agentName,
          systemInstruction,
          input,
          tools,
          provider: "fallback-mock"
        });
      }
    }

    if (typeof sdk.Agent === "function" && typeof sdk.run === "function") {
      try {
        const agent = new sdk.Agent({
          name: agentName,
          instructions: buildJsonInstruction(systemInstruction),
          model,
          modelSettings: buildModelSettings(),
          tools: sdkTools
        });

        const runner = createRunnerWithTools(sdk, sdkTools);
        const runInput = typeof input === "string" ? input : JSON.stringify(input);
        const runOptions = { maxTurns: getSafeMaxTurns() };
        const runPromise = runner ? runner.run(agent, runInput, runOptions) : sdk.run(agent, runInput, runOptions);
        const response = await withTimeout(runPromise, `OpenAI agent run (${agentName})`);

        const coercedOutput = coerceSdkOutput(response);
        if (!coercedOutput) {
          try {
            const retried = await runNoToolsRetry({ sdk, agentName, systemInstruction, input });
            const retriedOutput = coerceSdkOutput(retried?.response);
            if (retriedOutput) {
              return {
                output: retriedOutput,
                meta: {
                  provider: "@openai/agents",
                  mode: "openai",
                  model,
                  executionPath: retried.executionPath,
                  usedTools: []
                }
              };
            }
          } catch (_retryError) {
            // fall through to existing fallback path
          }

          return fallbackOrThrow({
            reason: "OpenAI Agent/run returned non-JSON output.",
            mockHandler,
            agentName,
            systemInstruction,
            input,
            tools,
            provider: "openai-AgentRun+mock-normalizer"
          });
        }

        return {
          output: coercedOutput ?? (response.finalOutput ?? response),
          meta: {
            provider: "@openai/agents",
            mode: "openai",
            model,
            executionPath: runner ? "Runner.run(with-tools)" : "run",
            usedTools: tools || []
          }
        };
      } catch (error) {
        if (isMaxTurnsError(error)) {
          try {
            const retried = await runNoToolsRetry({ sdk, agentName, systemInstruction, input });
            const retriedOutput = coerceSdkOutput(retried?.response);
            if (retriedOutput) {
              return {
                output: retriedOutput,
                meta: {
                  provider: "@openai/agents",
                  mode: "openai",
                  model,
                  executionPath: retried.executionPath,
                  usedTools: []
                }
              };
            }
          } catch (_retryError) {
            // fall through to existing fallback path
          }
        }

        return fallbackOrThrow({
          reason: `OpenAI Agent/run failed (${error.message}).`,
          mockHandler,
          agentName,
          systemInstruction,
          input,
          tools,
          provider: "openai-AgentRun+mock-fallback"
        });
      }
    }

    throw new Error("@openai/agents is installed but no supported execution API was found (expected runAgent or Agent+run).");
  }

  return { getSupportedModes, getMode, setMode, runAgent };
}

module.exports = createOpenAIAgentClient();

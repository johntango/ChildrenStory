/*
  Centralized wrapper for @openai/agents integration.
  If SDK details vary, keep the same method signature and swap internals here.
*/

class OpenAIAgentClient {
  constructor() {
    this.mode = (process.env.AGENT_MODE || "mock").toLowerCase();
    this.model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    this.enabled = Boolean(process.env.OPENAI_API_KEY);
    this.timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 20000);
    this.allowMockFallback = String(process.env.OPENAI_ALLOW_MOCK_FALLBACK || "true").toLowerCase() === "true";
    this._sdk = null;
    this._warned = false;
  }

  getSupportedModes() {
    return ["mock", "openai"];
  }

  getMode() {
    return this.mode;
  }

  setMode(mode) {
    const nextMode = String(mode || "").toLowerCase();
    if (!this.getSupportedModes().includes(nextMode)) {
      throw new Error(`Unsupported mode: ${mode}. Supported modes: ${this.getSupportedModes().join(", ")}`);
    }
    this.mode = nextMode;
    return this.mode;
  }

  _ensureOpenAIModeReady() {
    if (this.mode !== "openai") return;
    if (!this.enabled) {
      throw new Error("AGENT_MODE=openai requires OPENAI_API_KEY to be set.");
    }
  }

  _loadSdk() {
    if (this._sdk) return this._sdk;
    try {
      this._sdk = require("@openai/agents");
      return this._sdk;
    } catch (error) {
      throw new Error(
        "AGENT_MODE=openai requires @openai/agents to be installed. Run `npm install @openai/agents`."
      );
    }
  }

  async _withTimeout(promise, label) {
    const timeoutMs = Math.max(1000, Number(this.timeoutMs) || 20000);
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `${label} timed out after ${timeoutMs}ms. Set AGENT_TIMEOUT_MS to adjust, or switch to AGENT_MODE=mock.`
              )
            );
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  _coerceSdkOutput(response) {
    if (!response) return null;
    const candidate = response.output ?? response.finalOutput ?? response;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      return this._extractJsonObjectFromText(candidate);
    }
    return null;
  }

  _extractJsonObjectFromText(text) {
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

  _buildJsonInstruction(baseInstruction) {
    return `${baseInstruction}\n\nReturn ONLY a valid JSON object. Do not include markdown, code fences, or extra prose.`;
  }

  _buildModelSettings() {
    return {
      response_format: {
        type: "json_object"
      }
    };
  }

  async _fallbackOrThrow({ reason, mockHandler, agentName, systemInstruction, input, tools, provider }) {
    if (!this.allowMockFallback || typeof mockHandler !== "function") {
      throw new Error(`${reason} Set OPENAI_ALLOW_MOCK_FALLBACK=true to allow schema-safe mock fallback in openai mode.`);
    }

    if (!this._warned) {
      this._warned = true;
      console.warn(`${reason} Falling back to deterministic mock handler because OPENAI_ALLOW_MOCK_FALLBACK=true.`);
    }

    const fallback = await mockHandler({ agentName, systemInstruction, input, tools });
    return {
      ...fallback,
      meta: {
        ...(fallback.meta || {}),
        provider,
        mode: "openai",
        model: this.model,
        usedTools: tools || []
      }
    };
  }

  async runAgent({ agentName, systemInstruction, input, tools, mockHandler }) {
    this.enabled = Boolean(process.env.OPENAI_API_KEY);
    this.model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    this.timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 20000);
    this.allowMockFallback = String(process.env.OPENAI_ALLOW_MOCK_FALLBACK || "true").toLowerCase() === "true";
    this._ensureOpenAIModeReady();

    if (this.mode === "mock") {
      if (typeof mockHandler === "function") {
        return mockHandler({ agentName, systemInstruction, input, tools });
      }

      return {
        output: {
          note: `Stubbed response from ${agentName}`,
          inputEcho: input
        },
        meta: {
          provider: "stub",
          mode: "mock",
          usedTools: tools || []
        }
      };
    }

    const sdk = this._loadSdk();

    if (typeof sdk.runAgent === "function") {
      try {
        const response = await this._withTimeout(
          sdk.runAgent({
            name: agentName,
            model: this.model,
            modelSettings: this._buildModelSettings(),
            instructions: this._buildJsonInstruction(systemInstruction),
            input,
            tools
          }),
          `OpenAI agent run (${agentName})`
        );

        const coercedOutput = this._coerceSdkOutput(response);
        if (!coercedOutput) {
          return this._fallbackOrThrow({
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
            model: this.model,
            usedTools: tools || []
          }
        };
      } catch (error) {
        return this._fallbackOrThrow({
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
          instructions: this._buildJsonInstruction(systemInstruction),
          model: this.model,
          modelSettings: this._buildModelSettings()
        });

        const response = await this._withTimeout(
          sdk.run(agent, JSON.stringify(input)),
          `OpenAI agent run (${agentName})`
        );

        const coercedOutput = this._coerceSdkOutput(response);
        if (!coercedOutput) {
          return this._fallbackOrThrow({
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
            model: this.model,
            usedTools: tools || []
          }
        };
      } catch (error) {
        return this._fallbackOrThrow({
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
}

module.exports = new OpenAIAgentClient();

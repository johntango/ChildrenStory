/*
  Centralized wrapper for @openai/agents integration.
  If SDK details vary, keep the same method signature and swap internals here.
*/

function createOpenAIAgentClient() {
  let mode = (process.env.AGENT_MODE || "mock").toLowerCase();
  let model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  let enabled = Boolean(process.env.OPENAI_API_KEY);
  let timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 20000);
  let allowMockFallback = String(process.env.OPENAI_ALLOW_MOCK_FALLBACK || "true").toLowerCase() === "true";
  let sdkCache = null;
  let warned = false;

  function refreshFromEnv() {
    enabled = Boolean(process.env.OPENAI_API_KEY);
    model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 20000);
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

  async function withTimeout(promise, label) {
    const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 20000);
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

  function coerceSdkOutput(response) {
    if (!response) return null;
    const candidate = response.output ?? response.finalOutput ?? response;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      return extractJsonObjectFromText(candidate);
    }
    return null;
  }

  function buildJsonInstruction(baseInstruction) {
    return `${baseInstruction}\n\nReturn ONLY a valid JSON object. Do not include markdown, code fences, or extra prose.`;
  }

  function buildModelSettings() {
    return { response_format: { type: "json_object" } };
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

    if (typeof sdk.runAgent === "function") {
      try {
        const response = await withTimeout(
          sdk.runAgent({
            name: agentName,
            model,
            modelSettings: buildModelSettings(),
            instructions: buildJsonInstruction(systemInstruction),
            input,
            tools
          }),
          `OpenAI agent run (${agentName})`
        );

        const coercedOutput = coerceSdkOutput(response);
        if (!coercedOutput) {
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
          meta: { provider: "@openai/agents", mode: "openai", model, usedTools: tools || [] }
        };
      } catch (error) {
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
          modelSettings: buildModelSettings()
        });

        const response = await withTimeout(sdk.run(agent, JSON.stringify(input)), `OpenAI agent run (${agentName})`);

        const coercedOutput = coerceSdkOutput(response);
        if (!coercedOutput) {
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
          meta: { provider: "@openai/agents", mode: "openai", model, usedTools: tools || [] }
        };
      } catch (error) {
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

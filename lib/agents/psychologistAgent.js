const agentClient = require("../openaiAgentClient");

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "safe", "pass", "approved"].includes(normalized)) return true;
    if (["false", "no", "unsafe", "fail", "rejected"].includes(normalized)) return false;
  }
  return null;
}

function normalizeSuggestions(rawSuggestions, fallbackSuggestions) {
  if (Array.isArray(rawSuggestions)) {
    return rawSuggestions.map((item) => String(item)).filter(Boolean);
  }
  if (typeof rawSuggestions === "string" && rawSuggestions.trim()) {
    return [rawSuggestions.trim()];
  }
  return fallbackSuggestions;
}

module.exports = function createPsychologistAgent({ config, memory }) {
  return {
    name: config.name,
    async run(input) {
      /*
        ChildPsychologist behavior
        Input: draft text
        Output: { safe: true|false, suggestions: [...] }
      */
      const text = input.text || "";
      const unsafe = /blood|violent|hate/i.test(text);
      const suggestions = unsafe
        ? ["Replace scary details with gentle stakes and support."]
        : ["Strong emotional safety.", "Add one explicit kindness moment."];

      memory.lastSafetyReview = new Date().toISOString();

      const response = await agentClient.runAgent({
        agentName: config.name,
        systemInstruction: config.role,
        input,
        tools: config.tools,
        mockHandler: async () => ({
          output: {
            safe: !unsafe,
            suggestions
          },
          meta: { provider: "stub" }
        })
      });

      if (response.output && typeof response.output === "object" && !Array.isArray(response.output)) {
        const output = response.output;
        const normalizedSafe =
          coerceBoolean(output.safe) ??
          coerceBoolean(output.isSafe) ??
          coerceBoolean(output.approved) ??
          coerceBoolean(output.safetyStatus);

        return {
          ...output,
          safe: normalizedSafe == null ? !unsafe : normalizedSafe,
          suggestions: normalizeSuggestions(
            output.suggestions ?? output.recommendations ?? output.notes,
            suggestions
          ),
          _agentMeta: response.meta
        };
      }

      return {
        safe: !unsafe,
        suggestions,
        value: response.output,
        _agentMeta: response.meta
      };
    }
  };
};

const agentClient = require("../openaiAgentClient");

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
        return { ...response.output, _agentMeta: response.meta };
      }
      return { value: response.output, _agentMeta: response.meta };
    }
  };
};

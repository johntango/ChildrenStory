const agentClient = require("../openaiAgentClient");

module.exports = function createEditorAgent({ config, tools, memory }) {
  return {
    name: config.name,
    async run(input) {
      /*
        EditorAgent behavior
        Input: draft text
        Output: { editedText, changeLog }
        Calls grammarTool and returns corrected text; logs what changed.
      */
      const grammar = await tools.grammarTool({ text: input.text });
      const changeLog = [...grammar.suggestions];

      memory.lastEditCount = (memory.lastEditCount || 0) + 1;

      const sdkTools = [
        {
          name: "grammarTool",
          description: "Corrects grammar and returns suggestions.",
          schema: {
            type: "object",
            properties: {
              text: { type: "string" }
            },
            required: ["text"],
            additionalProperties: false
          },
          handler: async (_ctx, args) => tools.grammarTool(args)
        }
      ];

      const response = await agentClient.runAgent({
        agentName: config.name,
        systemInstruction: config.role,
        input,
        tools: sdkTools,
        mockHandler: async () => ({
          output: {
            editedText: grammar.correctedText,
            changeLog
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

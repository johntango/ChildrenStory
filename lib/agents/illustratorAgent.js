const agentClient = require("../openaiAgentClient");

module.exports = function createIllustratorAgent({ config, tools, memory }) {
  return {
    name: config.name,
    async run(input) {
      /*
        IllustratorAgent behavior
        Input: scene description
        Output: { illustrationPrompt, illustrationId }
        Calls illustrationTool(illustrationPrompt) and stores returned id.
      */
      const prompt = `Children's book style, bright colors, ${input.sceneDescription}`;
      const result = await tools.illustrationTool({ prompt, sceneIndex: input.sceneIndex });

      memory.lastIllustrationPrompt = prompt;

      const response = await agentClient.runAgent({
        agentName: config.name,
        systemInstruction: config.role,
        input,
        tools: config.tools,
        mockHandler: async () => ({
          output: {
            illustrationPrompt: prompt,
            illustrationId: result.illustrationId,
            metadata: result
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

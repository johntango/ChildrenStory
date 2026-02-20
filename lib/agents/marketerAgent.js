const agentClient = require("../openaiAgentClient");

module.exports = function createMarketerAgent({ config, tools, memory }) {
  return {
    name: config.name,
    async run(input) {
      const research = await tools.researchTool({ query: `Children's book hooks for ${input.title}` });

      memory.lastHook = `${input.title}: A brave leap with a kind heart`;

      const response = await agentClient.runAgent({
        agentName: config.name,
        systemInstruction: config.role,
        input,
        tools: config.tools,
        mockHandler: async () => ({
          output: {
            hook: `${input.title}: A brave leap with a kind heart`,
            blurb: "Tim wants to fly. With practice and kindness, he discovers courage can lift everyone.",
            positioning: "Ages 6-8, read-aloud bedtime and classroom SEL",
            seriesIdeas: ["Tim and the Windy Kite", "Tim and the Moonlight Map"],
            notes: research.notes
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

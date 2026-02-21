const agentClient = require("../openaiAgentClient");

module.exports = function createAuthorAgent({ config, tools, memory }) {
  return {
    name: config.name,
    async run(input) {
      /*
        AuthorAgent behavior
        Input: { storyId, brief: {title, age, tone, lengthTarget}, characterSheet, plotOutline, previousDraft }
        Output: { sceneDrafts: [...], characterNotes }
      */
      const title = input.brief.title;
      const tone = input.brief.tone;
      const toneHints = String(tone || "playful")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3);
      const toneLabel = toneHints.length ? toneHints.join(" / ") : "playful";

      const sceneDrafts = [
        `${title}: In a ${toneLabel} morning, Tim looked at the hill and said, "I can do this!" His paws shook, but he smiled.`,
        `A ${toneHints.includes("adventurous") ? "whooshy" : "soft"} gust lifted Tim's cape. He leaped, flopped, and then glided over the park fence.`,
        `When Tim saw a little bird trapped in string, he landed gently and helped it get free, staying ${toneHints.includes("encouraging") ? "cheery" : "kind"} all the way.`,
        `By sunset, Tim had learned the best trick: brave hearts listen, practice, and help friends.`
      ];

      const characterNotes = {
        protagonist: "Tim, a kind dog who dreams of flying",
        tone,
        lesson: "Courage grows with practice and kindness"
      };

      memory.lastTone = tone;
      memory.lastCharacter = "Tim";

      const sdkTools = [
        {
          name: "researchTool",
          description: "Researches factual or thematic context for story ideas.",
          schema: {
            type: "object",
            properties: {
              query: { type: "string" }
            },
            required: ["query"],
            additionalProperties: false
          },
          handler: async (_ctx, args) => tools.researchTool(args)
        }
      ];

      const response = await agentClient.runAgent({
        agentName: config.name,
        systemInstruction: `${config.role}\nStory constraints:\n- Title: ${title}\n- Target age: ${input.brief.ageGroup || 7}\n- Tone: ${tone || "playful"}\n- Length target: ${input.brief.lengthTarget || 900}\nKeep wording and scene energy aligned with the tone explicitly.`,
        input,
        tools: sdkTools,
        mockHandler: async () => ({
          output: {
            sceneDrafts,
            characterNotes,
            storyHook: `${title} takes one brave leap at a time.`
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

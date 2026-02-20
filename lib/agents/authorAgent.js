const agentClient = require("../openaiAgentClient");

module.exports = function createAuthorAgent({ config, tools, memory }) {
  return {
    name: config.name,
    async run(input) {
      /*
        AuthorAgent behavior
        Input: { storyId, brief: {title, age, tone, lengthTarget}, characterSheet, plotOutline, previousDraft }
        Output: { sceneDrafts: [...], characterNotes }
        Calls readabilityTool on each scene draft and adjusts wording until target grade-level is met.
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

      const adjusted = [];
      for (const scene of sceneDrafts) {
        const score = await tools.readabilityTool({ text: scene, targetAge: input.brief.ageGroup || 7 });
        if (score.estimatedGrade > score.targetGrade + 1) {
          adjusted.push(scene.split(",").join("."));
        } else {
          adjusted.push(scene);
        }
      }

      const characterNotes = {
        protagonist: "Tim, a kind dog who dreams of flying",
        tone,
        lesson: "Courage grows with practice and kindness"
      };

      memory.lastTone = tone;
      memory.lastCharacter = "Tim";

      const response = await agentClient.runAgent({
        agentName: config.name,
        systemInstruction: `${config.role}\nStory constraints:\n- Title: ${title}\n- Target age: ${input.brief.ageGroup || 7}\n- Tone: ${tone || "playful"}\n- Length target: ${input.brief.lengthTarget || 900}\nKeep wording and scene energy aligned with the tone explicitly.`,
        input,
        tools: config.tools,
        mockHandler: async () => ({
          output: {
            sceneDrafts: adjusted,
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

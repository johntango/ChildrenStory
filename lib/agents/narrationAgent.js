module.exports = function createNarrationAgent({ config, memory }) {
  return {
    name: config.name,
    async run(input) {
      memory.lastNarration = new Date().toISOString();
      return {
        performanceNotes: [
          "Pause after Tim's big leap line.",
          "Use a warm, excited tone during dialogue.",
          "Slow down at the ending message for emphasis."
        ],
        readAloudTip: "Invite children to repeat Tim's courage phrase."
      };
    }
  };
};

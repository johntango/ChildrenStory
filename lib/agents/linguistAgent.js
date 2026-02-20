module.exports = function createLinguistAgent({ config, tools, memory }) {
  return {
    name: config.name,
    async run(input) {
      const readability = await tools.readabilityTool({ text: input.text, targetAge: input.ageGroup || 7 });
      memory.lastReadability = readability;
      return {
        targetGrade: readability.targetGrade,
        estimatedGrade: readability.estimatedGrade,
        suggestions: readability.suggestions
      };
    }
  };
};

module.exports = function createDiversityAgent({ config, memory }) {
  return {
    name: config.name,
    async run(input) {
      const text = input.text || "";
      const flagged = /stupid|crazy/i.test(text);
      const suggestions = flagged
        ? ["Replace stigmatizing words with neutral, respectful language."]
        : ["Representation appears inclusive and respectful."];
      memory.lastReview = new Date().toISOString();
      return {
        inclusive: !flagged,
        suggestions
      };
    }
  };
};

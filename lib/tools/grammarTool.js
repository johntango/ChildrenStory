module.exports = async function grammarTool({ text }) {
  const cleaned = (text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\bi\b/g, "I")
    .trim();

  const suggestions = [
    "Standardized spacing and punctuation.",
    "Capitalized first-person pronoun where needed."
  ];

  return {
    correctedText: cleaned,
    suggestions
  };
};

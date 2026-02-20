function estimateGrade(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength = words.length / Math.max(sentences.length, 1);
  const gradeLevel = Math.min(6, Math.max(1, Math.round(avgSentenceLength / 3)));
  return { gradeLevel, avgSentenceLength: Number(avgSentenceLength.toFixed(2)) };
}

module.exports = async function readabilityTool({ text, targetAge = 7 }) {
  const { gradeLevel, avgSentenceLength } = estimateGrade(text || "");
  const targetGrade = targetAge <= 7 ? 2 : 3;
  const suggestions = [];

  if (gradeLevel > targetGrade + 1) {
    suggestions.push("Use shorter sentences and more familiar words.");
  }
  if (avgSentenceLength > 12) {
    suggestions.push("Break long sentences into two shorter ones.");
  }
  if ((text || "").length < 300) {
    suggestions.push("Add more vivid action and dialogue to enrich scene depth.");
  }

  return {
    targetGrade,
    estimatedGrade: gradeLevel,
    avgSentenceLength,
    suggestions
  };
};

module.exports = async function researchTool({ query }) {
  const notes = [
    "Children around age 7 respond well to clear goals and gentle humor.",
    "Stories with repeating motifs help early independent readers.",
    "Mild conflict with kind resolution improves emotional safety."
  ];

  return {
    notes,
    query,
    source: "mock-research-index-v1"
  };
};

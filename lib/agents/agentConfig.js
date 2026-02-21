module.exports = {
  orchestrator: {
    name: "Orchestrator",
    role: "Plan the workflow for creating a children's story and dispatch tasks to specialists."
  },
  author: {
    name: "AuthorAgent",
    role: "Write scenes, dialogue, and draft sections for a 7-year-old audience.",
    tools: ["researchTool"]
  },
  psychologist: {
    name: "ChildPsychologist",
    role: "Check content suitability and suggest learning moments and age-appropriate themes.",
    tools: []
  },
  editor: {
    name: "EditorAgent",
    role: "Polish drafts, fix grammar, improve pacing and reduce wordiness.",
    tools: ["grammarTool"]
  },
  illustrator: {
    name: "IllustratorAgent",
    role: "Produce illustration prompts and metadata for scenes.",
    tools: ["illustrationTool"]
  },
  marketer: {
    name: "MarketerAgent",
    role: "Suggest hook, blurb, series potential and audience positioning",
    tools: ["researchTool"]
  },
  narrator: {
    name: "NarrationCoach",
    role: "Suggest read-aloud rhythm and expressive phrasing for caregivers.",
    tools: []
  }
};

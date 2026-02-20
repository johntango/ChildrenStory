const { v4: uuidv4 } = require("uuid");

module.exports = async function illustrationTool({ prompt, sceneIndex }) {
  return {
    illustrationId: `ill_${uuidv4().slice(0, 8)}`,
    prompt,
    sceneIndex,
    style: "bright-watercolor",
    resolution: "1024x1024",
    provider: "placeholder"
  };
};

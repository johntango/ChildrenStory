module.exports = async function publishTool({ storyPackage, persistStory }) {
  const publishedAt = new Date().toISOString();
  const id = storyPackage.id;
  const filePath = persistStory(id);

  return {
    id,
    publishedAt,
    filePath,
    downloadPath: `/stories/${id}/result`
  };
};

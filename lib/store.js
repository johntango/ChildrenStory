const fs = require("fs");
const path = require("path");

function createStore() {
  const stories = new Map();
  const logsByStory = new Map();
  const eventsByStory = new Map();
  const sequenceByStory = new Map();
  const sseClientsByStory = new Map();

  function createStory(story) {
    stories.set(story.id, story);
    logsByStory.set(story.id, []);
    eventsByStory.set(story.id, []);
    sequenceByStory.set(story.id, 0);
    sseClientsByStory.set(story.id, new Set());
    return story;
  }

  function getStory(id) {
    return stories.get(id);
  }

  function listStories() {
    return Array.from(stories.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function updateStory(id, updater) {
    const current = stories.get(id);
    if (!current) return null;
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    stories.set(id, next);
    return next;
  }

  function appendStoryLog(storyId, logEntry) {
    if (!logsByStory.has(storyId)) {
      logsByStory.set(storyId, []);
    }
    logsByStory.get(storyId).push(logEntry);
  }

  function getStoryLogs(storyId) {
    return logsByStory.get(storyId) || [];
  }

  function addSseClient(storyId, res) {
    if (!sseClientsByStory.has(storyId)) {
      sseClientsByStory.set(storyId, new Set());
    }
    sseClientsByStory.get(storyId).add(res);
  }

  function removeSseClient(storyId, res) {
    const set = sseClientsByStory.get(storyId);
    if (!set) return;
    set.delete(res);
  }

  function emitStoryEvent(storyId, eventType, payload) {
    const nextSequence = (sequenceByStory.get(storyId) || 0) + 1;
    sequenceByStory.set(storyId, nextSequence);

    const event = {
      sequence: nextSequence,
      timestamp: new Date().toISOString(),
      storyId,
      eventType,
      payload
    };

    if (!eventsByStory.has(storyId)) {
      eventsByStory.set(storyId, []);
    }
    eventsByStory.get(storyId).push(event);

    const clients = sseClientsByStory.get(storyId);
    if (clients) {
      for (const client of clients) {
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }

    return event;
  }

  function getEvents(storyId) {
    return eventsByStory.get(storyId) || [];
  }

  function persistStoryToFile(storyId, outputDir = path.join(process.cwd(), "data")) {
    const story = getStory(storyId);
    if (!story) return null;

    fs.mkdirSync(outputDir, { recursive: true });
    const targetPath = path.join(outputDir, `${storyId}.json`);
    fs.writeFileSync(targetPath, JSON.stringify(story, null, 2), "utf8");
    return targetPath;
  }

  return {
    createStory,
    getStory,
    listStories,
    updateStory,
    appendStoryLog,
    getStoryLogs,
    addSseClient,
    removeSseClient,
    emitStoryEvent,
    getEvents,
    persistStoryToFile
  };
}

module.exports = createStore();

const fs = require("fs");
const path = require("path");

class Store {
  constructor() {
    this.stories = new Map();
    this.logsByStory = new Map();
    this.eventsByStory = new Map();
    this.sequenceByStory = new Map();
    this.sseClientsByStory = new Map();
  }

  createStory(story) {
    this.stories.set(story.id, story);
    this.logsByStory.set(story.id, []);
    this.eventsByStory.set(story.id, []);
    this.sequenceByStory.set(story.id, 0);
    this.sseClientsByStory.set(story.id, new Set());
    return story;
  }

  getStory(id) {
    return this.stories.get(id);
  }

  listStories() {
    return Array.from(this.stories.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  updateStory(id, updater) {
    const current = this.stories.get(id);
    if (!current) return null;
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    this.stories.set(id, next);
    return next;
  }

  appendStoryLog(storyId, logEntry) {
    if (!this.logsByStory.has(storyId)) {
      this.logsByStory.set(storyId, []);
    }
    this.logsByStory.get(storyId).push(logEntry);
  }

  getStoryLogs(storyId) {
    return this.logsByStory.get(storyId) || [];
  }

  addSseClient(storyId, res) {
    if (!this.sseClientsByStory.has(storyId)) {
      this.sseClientsByStory.set(storyId, new Set());
    }
    this.sseClientsByStory.get(storyId).add(res);
  }

  removeSseClient(storyId, res) {
    const set = this.sseClientsByStory.get(storyId);
    if (!set) return;
    set.delete(res);
  }

  emitStoryEvent(storyId, eventType, payload) {
    const nextSequence = (this.sequenceByStory.get(storyId) || 0) + 1;
    this.sequenceByStory.set(storyId, nextSequence);

    const event = {
      sequence: nextSequence,
      timestamp: new Date().toISOString(),
      storyId,
      eventType,
      payload
    };

    if (!this.eventsByStory.has(storyId)) {
      this.eventsByStory.set(storyId, []);
    }
    this.eventsByStory.get(storyId).push(event);

    const clients = this.sseClientsByStory.get(storyId);
    if (clients) {
      for (const client of clients) {
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }

    return event;
  }

  getEvents(storyId) {
    return this.eventsByStory.get(storyId) || [];
  }

  persistStoryToFile(storyId, outputDir = path.join(process.cwd(), "data")) {
    const story = this.getStory(storyId);
    if (!story) return null;

    fs.mkdirSync(outputDir, { recursive: true });
    const targetPath = path.join(outputDir, `${storyId}.json`);
    fs.writeFileSync(targetPath, JSON.stringify(story, null, 2), "utf8");
    return targetPath;
  }
}

module.exports = new Store();

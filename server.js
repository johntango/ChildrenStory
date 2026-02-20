const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
require("dotenv").config();

const orchestrator = require("./lib/orchestrator");
const store = require("./lib/store");
const agentClient = require("./lib/openaiAgentClient");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(bodyParser.json({ limit: "1mb" }));
app.use("/ui", express.static(path.join(__dirname, "ui")));

function validateStoryBody(body) {
  const errors = [];
  if (!body || typeof body !== "object") errors.push("Body must be a JSON object.");
  if (!body?.title || typeof body.title !== "string") errors.push("title is required and must be a string.");
  if (typeof body?.ageGroup !== "number") errors.push("ageGroup is required and must be a number.");
  if (typeof body?.lengthTarget !== "number") errors.push("lengthTarget is required and must be a number.");
  if (!body?.tone || typeof body.tone !== "string") errors.push("tone is required and must be a string.");
  return errors;
}

app.get("/", (_req, res) => {
  res.redirect("/ui/index.html");
});

app.post("/stories", async (req, res) => {
  const errors = validateStoryBody(req.body);
  if (errors.length) {
    return res.status(400).json({ errors });
  }

  const out = await orchestrator.startStory(req.body);
  return res.status(202).json(out);
});

app.get("/stories", (_req, res) => {
  return res.json({ items: orchestrator.listStories() });
});

app.get("/stories/:id/status", (req, res) => {
  try {
    const story = orchestrator.getStoryStatus(req.params.id);
    return res.json({
      id: story.id,
      title: story.title,
      status: story.status,
      steps: story.steps,
      updatedAt: story.updatedAt,
      cancelRequested: story.cancelRequested
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get("/stories/:id/logs", (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 200);
    const logs = orchestrator.getStoryLogs(req.params.id, { page, pageSize });
    return res.json(logs);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get("/stories/:id/result", (req, res) => {
  try {
    const result = orchestrator.getStoryResult(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get("/stories/:id/download.txt", (req, res) => {
  try {
    const result = orchestrator.getStoryResult(req.params.id);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=story-${req.params.id}.txt`);
    return res.send(result.package.text || "");
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/stories/:id/cancel", (req, res) => {
  try {
    const story = orchestrator.cancelStory(req.params.id);
    return res.json({ id: story.id, status: story.status, cancelRequested: story.cancelRequested });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/stories/:id/steps/:stepId/retry", async (req, res) => {
  try {
    const story = await orchestrator.retryStep(req.params.id, req.params.stepId);
    return res.json({ id: story.id, status: story.status, steps: story.steps });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/stories/:id/steps/:stepId/rerun", async (req, res) => {
  try {
    const story = await orchestrator.rerunStep(req.params.id, req.params.stepId);
    return res.json({ id: story.id, status: story.status, steps: story.steps });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get("/stories/:id/stream", (req, res) => {
  const storyId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  store.addSseClient(storyId, res);

  const history = store.getEvents(storyId);
  for (const event of history) {
    res.write(`event: ${event.eventType}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  req.on("close", () => {
    store.removeSseClient(storyId, res);
    res.end();
  });
});

app.get("/admin/logs", (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 200);
  const storyId = req.query.storyId || undefined;
  return res.json(orchestrator.getAdminLogs({ storyId, page, pageSize }));
});

app.get("/admin/mode", (_req, res) => {
  return res.json({
    mode: agentClient.getMode(),
    supportedModes: agentClient.getSupportedModes(),
    openAiKeyPresent: Boolean(process.env.OPENAI_API_KEY)
  });
});

app.post("/admin/mode", (req, res) => {
  try {
    const mode = req.body?.mode;
    const updatedMode = agentClient.setMode(mode);
    return res.json({
      mode: updatedMode,
      supportedModes: agentClient.getSupportedModes(),
      openAiKeyPresent: Boolean(process.env.OPENAI_API_KEY)
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

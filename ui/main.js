let selectedStoryId = null;
let stream = null;
let statusPollTimer = null;
let storiesPollTimer = null;

const storyForm = document.getElementById("storyForm");
const storyList = document.getElementById("storyList");
const refreshStoriesBtn = document.getElementById("refreshStories");
const storyMeta = document.getElementById("storyMeta");
const stepsTimeline = document.getElementById("stepsTimeline");
const logsBox = document.getElementById("logs");
const cancelBtn = document.getElementById("cancelBtn");
const downloadBtn = document.getElementById("downloadBtn");
const stepTemplate = document.getElementById("stepTemplate");
const agentModeSelect = document.getElementById("agentModeSelect");
const setModeBtn = document.getElementById("setModeBtn");
const modeMeta = document.getElementById("modeMeta");
const modeWarning = document.getElementById("modeWarning");
const stepActionsHint = document.getElementById("stepActionsHint");
const darkModeToggle = document.getElementById("darkModeToggle");

function appendLog(log) {
  if (!shouldDisplayLog(log)) return;
  const div = document.createElement("div");
  div.className = "log-item";
  div.textContent = `[${new Date().toLocaleTimeString()}] ${formatLog(log)}`;
  logsBox.appendChild(div);
  logsBox.scrollTop = logsBox.scrollHeight;
}

function shouldDisplayLog(log) {
  if (!log) return false;

  if (log.tool && log.status === "running") {
    return false;
  }

  if (log.eventType === "tool.started") {
    return false;
  }

  return true;
}

function formatLog(log) {
  if (log.eventType === "tool.finished") {
    const payload = log.payload || {};
    return `${payload.step} • ${payload.tool} finished (${payload.durationMs ?? 0}ms)`;
  }

  if (log.eventType === "tool.failed") {
    const payload = log.payload || {};
    return `${payload.step} • ${payload.tool} failed: ${payload.error || "unknown error"}`;
  }

  if (log.eventType === "agent.started" || log.eventType === "agent.finished" || log.eventType === "agent.failed") {
    const payload = log.payload || {};
    if (log.eventType === "agent.finished") {
      const provider = payload.provider ? ` • ${payload.provider}` : "";
      const model = payload.model ? ` (${payload.model})` : "";
      return `${log.eventType} • ${payload.stepId || "unknown-step"} • ${payload.agent || "unknown-agent"}${provider}${model}`;
    }
    return `${log.eventType} • ${payload.stepId || "unknown-step"} • ${payload.agent || "unknown-agent"}`;
  }

  if (log.tool) {
    const summary = log.outputSummary ? ` • ${String(log.outputSummary).slice(0, 120)}` : "";
    return `${log.step} • ${log.tool} • ${log.status}${summary}`;
  }

  if (log.agent && log.step) {
    return `${log.step} • ${log.agent} • ${log.status}`;
  }

  return JSON.stringify(log);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.errors?.join(", ") || `Request failed (${response.status})`);
  }
  return body;
}

function renderStories(items) {
  storyList.innerHTML = "";
  for (const story of items) {
    const li = document.createElement("li");
    li.innerHTML = `<div><strong class="story-link">${story.title}</strong></div><div>${story.id}</div><div>Status: ${story.status}</div>`;
    li.querySelector(".story-link").addEventListener("click", () => selectStory(story.id));
    storyList.appendChild(li);
  }
}

function renderSteps(steps, storyStatus) {
  stepsTimeline.innerHTML = "";
  const storyIsRunning = storyStatus === "running";
  stepActionsHint.textContent = storyIsRunning
    ? "Step actions are temporarily disabled while this story is running."
    : "You can re-run any step, or retry failed steps.";

  for (const step of steps) {
    const fragment = stepTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".step-item");
    root.dataset.stepId = step.id;
    fragment.querySelector(".step-id").textContent = step.id;
    const providerText = step.provider ? ` • ${step.provider}` : "";
    const modelText = step.model ? ` (${step.model})` : "";
    fragment.querySelector(".step-agent").textContent = `${step.agent}${providerText}${modelText}`;
    fragment.querySelector(".step-status").textContent = step.status;

    const retryBtn = fragment.querySelector("button[data-action='retry']");
    const rerunBtn = fragment.querySelector("button[data-action='rerun']");

    retryBtn.disabled = !selectedStoryId || storyIsRunning || step.status !== "failed";
    rerunBtn.disabled = !selectedStoryId || storyIsRunning;

    if (storyIsRunning) {
      retryBtn.title = "Disabled while story is running";
      rerunBtn.title = "Disabled while story is running";
    } else if (step.status !== "failed") {
      retryBtn.title = "Retry is only available for failed steps";
      rerunBtn.title = "Re-run this step and downstream steps";
    } else {
      retryBtn.title = "Retry this failed step and downstream steps";
      rerunBtn.title = "Re-run this step and downstream steps";
    }

    retryBtn.addEventListener("click", async () => {
      await requestJson(`/stories/${selectedStoryId}/steps/${step.id}/retry`, { method: "POST" });
      await refreshStatus();
    });

    rerunBtn.addEventListener("click", async () => {
      await requestJson(`/stories/${selectedStoryId}/steps/${step.id}/rerun`, { method: "POST" });
      await refreshStatus();
    });

    stepsTimeline.appendChild(fragment);
  }
}

async function refreshStories() {
  const data = await requestJson("/stories");
  const items = data.items || [];
  renderStories(items);

  const hasRunning = items.some((item) => item.status === "running" || item.status === "queued");
  if (hasRunning) {
    startStoriesPolling();
  } else {
    stopStoriesPolling();
  }
}

function startStoriesPolling() {
  if (storiesPollTimer) return;
  storiesPollTimer = setInterval(() => {
    refreshStories().catch((error) => appendLog({ error: error.message }));
  }, 3000);
}

function stopStoriesPolling() {
  if (!storiesPollTimer) return;
  clearInterval(storiesPollTimer);
  storiesPollTimer = null;
}

function renderModeState(data) {
  if (!data) return;
  if (data.mode) {
    agentModeSelect.value = data.mode;
  }
  const keyState = data.openAiKeyPresent ? "OPENAI_API_KEY present" : "OPENAI_API_KEY missing";
  const modelText = data.model ? ` • model: ${data.model}` : "";
  modeMeta.textContent = `Current mode: ${data.mode}${modelText} • ${keyState}`;

  if (data.mode === "openai" && !data.openAiKeyPresent) {
    modeWarning.textContent = "OpenAI mode is selected, but OPENAI_API_KEY is missing. Story runs will fail until a key is provided.";
    modeWarning.classList.remove("hidden");
  } else {
    modeWarning.textContent = "";
    modeWarning.classList.add("hidden");
  }
}

async function refreshMode() {
  const data = await requestJson("/admin/mode");
  renderModeState(data);
}

async function applyMode() {
  const data = await requestJson("/admin/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: agentModeSelect.value })
  });
  renderModeState(data);
  appendLog({ event: "mode.updated", mode: data.mode, openAiKeyPresent: data.openAiKeyPresent });
}

async function refreshStatus() {
  if (!selectedStoryId) return;
  const status = await requestJson(`/stories/${selectedStoryId}/status`);
  storyMeta.textContent = `${status.title} (${status.id}) — ${status.status}`;
  cancelBtn.disabled = status.status === "completed" || status.status === "failed" || status.status === "canceled";
  downloadBtn.disabled = status.status !== "completed";
  renderSteps(status.steps || [], status.status);

  const logs = await requestJson(`/stories/${selectedStoryId}/logs?page=1&pageSize=200`);
  logsBox.innerHTML = "";
  for (const item of logs.items || []) {
    appendLog(item);
  }

  const isTerminal = ["completed", "failed", "canceled"].includes(status.status);
  if (isTerminal) {
    stopStatusPolling();
  } else {
    startStatusPolling();
  }
}

function startStatusPolling() {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(() => {
    refreshStatus().catch((error) => appendLog({ error: error.message }));
  }, 2000);
}

function stopStatusPolling() {
  if (!statusPollTimer) return;
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function connectStream(storyId) {
  if (stream) {
    stream.close();
    stream = null;
  }

  stream = new EventSource(`/stories/${storyId}/stream`);
  stream.onerror = () => {
    startStatusPolling();
  };
  stream.onmessage = (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch {
      appendLog({ data: event.data });
    }
  };

  stream.addEventListener("tool.finished", (event) => appendLog(JSON.parse(event.data)));
  stream.addEventListener("tool.failed", async (event) => {
    appendLog(JSON.parse(event.data));
    await refreshStatus();
  });
  stream.addEventListener("agent.started", (event) => appendLog(JSON.parse(event.data)));
  stream.addEventListener("agent.finished", (event) => appendLog(JSON.parse(event.data)));
  stream.addEventListener("agent.failed", async (event) => {
    appendLog(JSON.parse(event.data));
    await refreshStatus();
  });
  stream.addEventListener("story.completed", async () => {
    appendLog({ event: "story.completed" });
    await refreshStories();
    await refreshStatus();
  });
  stream.addEventListener("story.failed", async (event) => {
    appendLog(JSON.parse(event.data));
    await refreshStories();
    await refreshStatus();
  });
  stream.addEventListener("story.canceled", async (event) => {
    appendLog(JSON.parse(event.data));
    await refreshStories();
    await refreshStatus();
  });
}

function applyDarkMode(enabled) {
  document.body.classList.toggle("dark-mode", Boolean(enabled));
  darkModeToggle.textContent = enabled ? "AI Light Mode" : "AI Dark Mode";
  localStorage.setItem("ui_dark_mode", enabled ? "1" : "0");
}

function initDarkMode() {
  const saved = localStorage.getItem("ui_dark_mode");
  applyDarkMode(saved === "1");
}

async function selectStory(storyId) {
  selectedStoryId = storyId;
  connectStream(storyId);
  await refreshStatus();
}

storyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    title: document.getElementById("title").value,
    ageGroup: Number(document.getElementById("ageGroup").value),
    lengthTarget: Number(document.getElementById("lengthTarget").value),
    tone: document.getElementById("tone").value
  };

  const created = await requestJson("/stories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  await refreshStories();
  await selectStory(created.id);
});

refreshStoriesBtn.addEventListener("click", refreshStories);

cancelBtn.addEventListener("click", async () => {
  if (!selectedStoryId) return;
  await requestJson(`/stories/${selectedStoryId}/cancel`, { method: "POST" });
  await refreshStatus();
});

downloadBtn.addEventListener("click", () => {
  if (!selectedStoryId) return;
  window.open(`/stories/${selectedStoryId}/download.txt`, "_blank");
});

setModeBtn.addEventListener("click", () => {
  applyMode().catch((error) => appendLog({ error: error.message }));
});

darkModeToggle.addEventListener("click", () => {
  const enabled = !document.body.classList.contains("dark-mode");
  applyDarkMode(enabled);
});

initDarkMode();
Promise.all([refreshStories(), refreshMode()]).catch((error) => appendLog({ error: error.message }));

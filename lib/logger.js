function createLogger() {
  const logs = [];

  function log(entry) {
    const record = {
      timestamp: new Date().toISOString(),
      storyId: entry.storyId ?? null,
      agent: entry.agent ?? null,
      step: entry.step ?? null,
      tool: entry.tool ?? null,
      input: entry.input ?? null,
      outputSummary: entry.outputSummary ?? null,
      durationMs: entry.durationMs ?? 0,
      status: entry.status ?? "running"
    };

    logs.push(record);
    return record;
  }

  function getLogs({ storyId, page = 1, pageSize = 100 } = {}) {
    const source = storyId ? logs.filter((item) => item.storyId === storyId) : logs;
    const start = (Math.max(page, 1) - 1) * Math.max(pageSize, 1);
    const end = start + Math.max(pageSize, 1);

    return {
      page,
      pageSize,
      total: source.length,
      items: source.slice(start, end)
    };
  }

  return { log, getLogs };
}

module.exports = createLogger();

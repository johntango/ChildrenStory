class Logger {
  constructor() {
    this.logs = [];
  }

  log(entry) {
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

    this.logs.push(record);
    return record;
  }

  getLogs({ storyId, page = 1, pageSize = 100 } = {}) {
    const source = storyId ? this.logs.filter((item) => item.storyId === storyId) : this.logs;
    const start = (Math.max(page, 1) - 1) * Math.max(pageSize, 1);
    const end = start + Math.max(pageSize, 1);

    return {
      page,
      pageSize,
      total: source.length,
      items: source.slice(start, end)
    };
  }
}

module.exports = new Logger();

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const orchestrator = require("../lib/orchestrator");

async function waitForCompletion(storyId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = orchestrator.getStoryStatus(storyId);
    if (["completed", "failed", "canceled"].includes(status.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timeout waiting for orchestration completion");
}

async function run() {
  const body = {
    title: "Tim the Flying Dog",
    ageGroup: 7,
    lengthTarget: 1000,
    tone: "playful, encouraging, slightly adventurous"
  };

  const { id } = await orchestrator.startStory(body);
  const finalStatus = await waitForCompletion(id);

  assert.strictEqual(finalStatus.status, "completed", "Story should complete");
  const result = orchestrator.getStoryResult(id);
  assert.ok(result.package, "Final package should exist");
  assert.ok(result.publish, "Publish metadata should exist");

  const dataPath = path.join(process.cwd(), "data", `${id}.json`);
  assert.ok(fs.existsSync(dataPath), "Persisted story JSON file should exist");

  await orchestrator.rerunStep(id, "author-draft");
  const rerunStatus = await waitForCompletion(id);
  assert.strictEqual(rerunStatus.status, "completed", "Story should complete after author rerun");
  const authorStep = rerunStatus.steps.find((s) => s.id === "author-draft");
  assert.ok(authorStep && authorStep.status === "succeeded", "author-draft should succeed after rerun");

  console.log("✅ Orchestrator integration test passed", { id, dataPath });
}

run().catch((error) => {
  console.error("❌ Orchestrator integration test failed", error);
  process.exit(1);
});

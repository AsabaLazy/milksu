import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cancelResearchWorkers } from "./bridge-research-cancel.js";

async function liveRun(t) {
  const root = await mkdtemp(join(tmpdir(), "milksu-research-cancel-"));
  const asyncDir = join(root, "run-1");
  await mkdir(asyncDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, asyncDir };
}

test("cancellation retries a starting worker until its async status receipt arrives", async (t) => {
  const { root, asyncDir } = await liveRun(t);
  let tasks = [{ id: "tool-call-1", status: "start" }];
  let waits = 0;

  const result = await cancelResearchWorkers({
    getTasks: () => tasks,
    workerTaskIDs: new Set(["tool-call-1"]),
    workspace: root,
    retries: 4,
    wait: async () => {
      waits += 1;
      if (waits === 1) {
        tasks = [{ ...tasks[0], status: "running", asyncDir }];
      } else if (waits === 2) {
        await writeFile(join(asyncDir, "status.json"), JSON.stringify({
          state: "completed",
          summary: "worker finished",
        }));
      }
    },
  });

  assert.equal(waits, 2);
  assert.deepEqual(result.unconfirmedTaskIDs, []);
  assert.equal(result.tasks[0].status, "succeeded");
  assert.equal(result.tasks[0].summary, "completed");
});

test("cancellation leaves workers unresolved when asyncDir or status.json is missing", async (t) => {
  const { root, asyncDir } = await liveRun(t);
  const tasks = [
    { id: "tool-call-start", status: "start" },
    { id: "tool-call-running", status: "running", asyncDir },
  ];

  const result = await cancelResearchWorkers({
    getTasks: () => tasks,
    workerTaskIDs: new Set(tasks.map(task => task.id)),
    workspace: root,
    retries: 3,
    wait: async () => undefined,
  });

  assert.deepEqual(result.unconfirmedTaskIDs, ["tool-call-start", "tool-call-running"]);
  assert.deepEqual(result.tasks.map(task => task.status), ["start", "running"]);
});

test("a signal without a terminal status receipt remains stop-unconfirmed", async (t) => {
  const { root, asyncDir } = await liveRun(t);
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ state: "running" }));
  const tasks = [{ id: "tool-call-1", status: "running", asyncDir }];
  let signalAttempts = 0;

  const result = await cancelResearchWorkers({
    getTasks: () => tasks,
    workerTaskIDs: new Set(["tool-call-1"]),
    workspace: root,
    terminate: async () => {
      signalAttempts += 1;
      return [{ id: "tool-call-1", action: "signaled" }];
    },
    retries: 3,
    wait: async () => undefined,
  });

  assert.equal(signalAttempts, 1);
  assert.deepEqual(result.unconfirmedTaskIDs, ["tool-call-1"]);
  assert.equal(result.tasks[0].status, "running");
});

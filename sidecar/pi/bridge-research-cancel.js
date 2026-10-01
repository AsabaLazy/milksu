import { readAsyncSubagentSnapshot } from "./pi-subagents-status.js";
import { terminateConversationSubagents } from "./pi-subagents-stop.js";

const isLive = task => task?.status === "running" || task?.status === "start";
const isTerminalSnapshot = snapshot => (
  snapshot?.status === "failed" || snapshot?.status === "succeeded"
);

export async function cancelResearchWorkers({
  getTasks,
  workerTaskIDs,
  workspace,
  terminate = terminateConversationSubagents,
  readSnapshot = readAsyncSubagentSnapshot,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  retries = 8,
  retryDelayMs = 100,
}) {
  const attempts = Number.isInteger(retries) && retries > 0 ? retries : 8;
  const signaled = new Set();
  const terminalSnapshots = new Map();
  const currentTasks = () => {
    const tasks = getTasks();
    return Array.isArray(tasks) ? tasks : [];
  };
  const trackedLive = task => workerTaskIDs.has(task?.id) && isLive(task);

  for (let pass = 0; pass < attempts; pass += 1) {
    const live = currentTasks().filter(trackedLive);
    if (!live.length) break;
    const candidates = live.filter(task => task.asyncDir && !signaled.has(task.id));
    if (candidates.length) {
      const outcomes = await terminate(candidates, workspace);
      for (const outcome of outcomes) {
        if (outcome.action === "signaled") signaled.add(outcome.id);
      }
    }
    for (const task of live) {
      if (!task.asyncDir) continue;
      const snapshot = readSnapshot(task.asyncDir, workspace);
      if (isTerminalSnapshot(snapshot)) terminalSnapshots.set(task.id, snapshot);
    }

    if (!currentTasks().some(task => trackedLive(task) && !terminalSnapshots.has(task.id))) break;
    if (pass + 1 < attempts) await wait(retryDelayMs);
  }

  const tasks = currentTasks().map((task) => {
    if (!trackedLive(task)) return task;
    const snapshot = terminalSnapshots.get(task.id);
    if (!snapshot) return task;
    return {
      ...task,
      status: snapshot.status,
      summary: snapshot.summary || task.summary,
      transcript: snapshot.transcript || task.transcript,
    };
  });
  const unconfirmedTaskIDs = tasks.filter(trackedLive).map(task => task.id);
  return { tasks, unconfirmedTaskIDs };
}

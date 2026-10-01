import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { isReadOnlySubagent, isPathWithin } from "./bridge-collaboration.js";

export const subagentYieldSchema = "milksu-subagent-yield/v1";

const yieldStatuses = new Set(["succeeded", "failed", "aborted"]);

const secretAssignment = /\b((?:[A-Za-z0-9.-]+[_-])*(?:api[_ -]?key|access[_ -]?key(?:[_ -]?id)?|client[_ -]?secret|private[_ -]?key|credential|signature|authorization|secret|token|password|passwd|relay[_ -]?key|key|sig))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi;
const secretQuery = /([?&;])([^=&#;\s"'<>]+)=([^&#;\s"'<>]*)/gi;
const secretBearer = /(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;
const secretToken = /\b(?:sk[-_]|gsk_|aiza|nss_agent_|tfk_|tokenflux)[a-z0-9._-]{8,}/gi;

function isSensitiveSecretName(value) {
  let name = String(value ?? "").trim().toLowerCase();
  try {
    name = decodeURIComponent(name.replaceAll("+", " "));
  } catch {
    // Keep the encoded name; normalized matching below still catches common keys.
  }
  const normalized = name.replace(/[^a-z0-9]/g, "");
  return normalized === "key"
    || normalized === "sig"
    || normalized === "auth"
    || normalized.includes("apikey")
    || normalized.includes("accesskey")
    || normalized.includes("clientsecret")
    || normalized.includes("privatekey")
    || normalized.includes("credential")
    || normalized.includes("signature")
    || normalized.includes("authorization")
    || normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("secret")
    || normalized.endsWith("token");
}

function redactTextSecrets(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/[^/\s?#:@]+:)[^/@\s]*@/gi, "$1[REDACTED]@")
    .replace(secretAssignment, "$1=[REDACTED]")
    .replace(secretQuery, (match, separator, key) => (
      isSensitiveSecretName(key) ? `${separator}${key}=[REDACTED]` : match
    ));
}

function exactObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, limit) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(secretToken, "[REDACTED]")
    .replace(secretBearer, "$1[REDACTED]")
    .replace(secretAssignment, "$1=[REDACTED]");
  const redacted = redactTextSecrets(text);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function redactSecretValues(text, secrets) {
  let next = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    if (secret.length < 8) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      next = next.replace(
        new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "g"),
        "$1[REDACTED]",
      );
    } else {
      next = next.split(secret).join("[REDACTED]");
    }
  }
  return next;
}

function collectEnvSecrets(environment = process.env, additionalSecrets = []) {
  const explicit = [
    environment.MILKSU_RELAY_KEY,
    environment.TOKENFLUX_API_KEY,
    environment.OPENAI_API_KEY,
    environment.MILKSU_IMAGEGEN_API_KEY,
    environment.MILKSU_CUSTOM_PROVIDER_KEY,
  ];
  const providerEnvironment = Object.entries(environment)
    .filter(([name]) => /(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i.test(name))
    .map(([, value]) => value);
  return [...new Set([...explicit, ...providerEnvironment, ...(additionalSecrets ?? [])])]
    .filter(value => String(value ?? "").trim().length > 0);
}

function redactStructuredSecrets(value, secrets) {
  if (typeof value === "string") {
    const redacted = redactSecretValues(value, secrets)
      .replace(secretToken, "[REDACTED]")
      .replace(secretBearer, "$1[REDACTED]");
    return redactTextSecrets(redacted);
  }
  if (Array.isArray(value)) return value.map(item => redactStructuredSecrets(item, secrets));
  if (exactObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => (
      [key, isSensitiveSecretName(key) ? "[REDACTED]" : redactStructuredSecrets(child, secrets)]
    )));
  }
  return value;
}

export function redactResearchText(value, environment = process.env, additionalSecrets = []) {
  return redactStructuredSecrets(value, collectEnvSecrets(environment, additionalSecrets));
}

export function projectSubagentTaskForRenderer(task, environment = process.env, secrets = []) {
  return redactResearchText({
    id: task?.id,
    role: task?.role,
    status: task?.status,
    durationMs: task?.durationMs,
    exitCode: task?.exitCode,
    yield: task?.yield,
    toolCallId: task?.toolCallId,
    summary: task?.summary,
    transcript: task?.transcript,
  }, environment, secrets);
}

function homePrefixes(homeDirectory = homedir()) {
  const home = String(homeDirectory ?? "").trim();
  if (!home) return [];
  return [home, home.replaceAll("\\", "/")];
}

function stripHomePrefix(value, homeDirectory) {
  let text = String(value ?? "");
  for (const home of homePrefixes(homeDirectory)) {
    if (text === home || text.startsWith(`${home}/`) || text.startsWith(`${home}\\`)) {
      text = text.slice(home.length).replace(/^[/\\]+/, "") || ".";
    }
  }
  return text.replace(/^~[/\\]/, "");
}

function relativizePath(value, roots, homeDirectory) {
  const original = boundedText(value, 800);
  if (!original) return "";
  for (const root of roots) {
    const base = String(root ?? "").trim();
    if (!base) continue;
    try {
      const resolved = isAbsolute(original) ? resolve(original) : resolve(base, original);
      if (isPathWithin(base, resolved)) {
        return relative(base, resolved).replaceAll("\\", "/") || ".";
      }
    } catch {
      // Keep looking for another root.
    }
  }
  return stripHomePrefix(original, homeDirectory)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^[/\\]+/, "") || ".";
}

function uniqueRoots(values) {
  return [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))];
}

function asInteger(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return undefined;
  return numeric;
}

function normalizeFinding(value, roots, homeDirectory) {
  if (typeof value === "string") {
    const path = relativizePath(value, roots, homeDirectory);
    return path ? { path, note: "" } : undefined;
  }
  if (!exactObject(value)) return undefined;
  const path = relativizePath(value.path ?? value.file ?? value.filename, roots, homeDirectory);
  if (!path) return undefined;
  return {
    path,
    note: boundedText(value.note ?? value.detail ?? value.message ?? "", 400),
  };
}

function extractRawYield(raw) {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw[0];
  if (exactObject(raw.yield)) return { ...raw, ...raw.yield };
  if (exactObject(raw.details?.yield)) return { ...raw, ...raw.details.yield };
  if (Array.isArray(raw.details?.yields) && exactObject(raw.details.yields[0])) {
    return { ...raw, ...raw.details.yields[0] };
  }
  if (Array.isArray(raw.details?.results) && exactObject(raw.details.results[0])) {
    return { ...raw, ...raw.details.results[0] };
  }
  if (Array.isArray(raw.results) && exactObject(raw.results[0])) {
    return { ...raw, ...raw.results[0] };
  }
  return exactObject(raw) ? raw : undefined;
}

function parseEmbeddedYield(text) {
  const source = String(text ?? "").trim();
  if (!source) return undefined;
  const block = source.match(/\{[\s\S]*"files"\s*:\s*\[[\s\S]*\}/);
  if (!block) return undefined;
  try {
    const parsed = JSON.parse(block[0]);
    return exactObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveLocation(raw, options) {
  const worktrees = Array.isArray(options.worktrees) ? options.worktrees : [];
  const requestedCwd = String(raw?.cwd ?? options.cwd ?? "").trim();
  const worktreeId = String(raw?.worktreeId ?? raw?.worktree ?? options.worktreeId ?? "").trim();
  const matched = worktrees.find(entry => (
    entry?.id === worktreeId
    || (requestedCwd && entry?.path === requestedCwd)
  ));
  const workspace = String(options.workspace ?? "").trim();
  return {
    cwd: requestedCwd || matched?.path || workspace || ".",
    worktreeId: matched?.id || worktreeId,
    worktreePath: matched?.path || "",
  };
}

function writerPaths(options) {
  const worktrees = Array.isArray(options.worktrees) ? options.worktrees : [];
  return uniqueRoots([
    ...(options.writerWorktreePaths ?? []),
    ...worktrees.map(entry => entry?.path),
  ]);
}

function pathLooksWritten(path, options) {
  const value = String(path ?? "").trim();
  if (!value) return false;
  const normalizedValue = value.replaceAll("\\", "/");
  if (/(?:^|\/)writer-\d+(?:\/|$)/.test(normalizedValue)) return true;
  if (!isAbsolute(value) && !isAbsolute(normalizedValue)) return false;
  for (const root of writerPaths(options)) {
    try {
      if (isPathWithin(root, value) || isPathWithin(root, normalizedValue)) return true;
    } catch {
      // Ignore unresolvable candidates.
    }
  }
  return false;
}

export function validateSubagentYield(value, options = {}) {
  if (!exactObject(value)) {
    throw new Error("Subagent yield must be an object");
  }
  if (!yieldStatuses.has(String(value.status ?? "").trim())) {
    throw new Error("Subagent yield is missing status");
  }
  const cwd = String(value.cwd ?? "").trim();
  const worktreeId = String(value.worktreeId ?? "").trim();
  if (!cwd && !worktreeId) {
    throw new Error("Subagent yield requires cwd or worktreeId");
  }
  if (!Array.isArray(value.files)) {
    throw new Error("Subagent yield is missing files");
  }
  if (!Array.isArray(value.findings)) {
    throw new Error("Subagent yield is missing findings");
  }
  if (!Number.isSafeInteger(value.exitCode)) {
    throw new Error("Subagent yield is missing exitCode");
  }
  const role = String(options.role ?? value.role ?? value.agent ?? "").trim();
  if (isReadOnlySubagent(role)) {
    const written = [
      ...value.files.map(path => String(path ?? "")),
      ...value.findings.map(finding => String(finding?.path ?? "")),
    ].filter(path => pathLooksWritten(path, options));
    if (written.length) {
      throw new Error("Read-only subagent yield cannot include writer worktree paths");
    }
  }
  return value;
}

export function normalizeSubagentYield(raw, options = {}) {
  const extracted = extractRawYield(raw) ?? parseEmbeddedYield(
    Array.isArray(raw?.content)
      ? raw.content.filter(block => block?.type === "text").map(block => block.text).join("\n")
      : raw?.content ?? raw?.stdout ?? raw?.text,
  );
  if (!extracted && raw !== undefined && raw !== null && !exactObject(raw)) {
    throw new Error("Subagent yield must be an object");
  }
  const source = extracted ?? {};
  const location = resolveLocation(source, options);
  const roots = uniqueRoots([
    location.worktreePath,
    options.workspace,
    location.cwd,
    ...(options.worktrees ?? []).map(entry => entry?.path),
  ]);
  const homeDirectory = options.homeDirectory ?? homedir();
  const filesSource = Array.isArray(source.files) ? source.files : undefined;
  const findingsSource = Array.isArray(source.findings) ? source.findings : undefined;
  if (options.requireFields) {
    if (filesSource === undefined || findingsSource === undefined) {
      throw new Error("Subagent yield is missing files or findings");
    }
  }
  const exitCode = asInteger(source.exitCode);
  if (exitCode === undefined && options.requireFields) {
    throw new Error("Subagent yield is missing exitCode");
  }
  const status = yieldStatuses.has(String(source.status ?? "").trim())
    ? String(source.status).trim()
    : exitCode === 0
      ? "succeeded"
      : source.aborted
        ? "aborted"
        : "failed";
  const secrets = collectEnvSecrets(options.environment, options.secrets);
  const role = String(options.role ?? source.agent ?? source.role ?? "").trim();
  const originalPaths = [
    ...(filesSource ?? []).map(entry => (typeof entry === "string" ? entry : entry?.path)),
    ...(findingsSource ?? []).map(entry => (typeof entry === "string" ? entry : entry?.path ?? entry?.file)),
  ].map(path => String(path ?? "").trim()).filter(Boolean);
  if (isReadOnlySubagent(role) && originalPaths.some(path => pathLooksWritten(path, options))) {
    throw new Error("Read-only subagent yield cannot include writer worktree paths");
  }
  const files = (filesSource ?? []).flatMap((entry) => {
    const path = relativizePath(
      redactSecretValues(typeof entry === "string" ? entry : entry?.path, secrets),
      roots,
      homeDirectory,
    );
    return path ? [path] : [];
  });
  const findings = (findingsSource ?? []).flatMap((entry) => {
    const finding = normalizeFinding(
      exactObject(entry)
        ? {
            ...entry,
            path: redactSecretValues(entry.path ?? entry.file, secrets),
            note: redactSecretValues(entry.note ?? entry.detail, secrets),
          }
        : redactSecretValues(entry, secrets),
      roots,
      homeDirectory,
    );
    return finding ? [finding] : [];
  });
  let cwd = location.cwd
    ? relativizePath(location.cwd, roots, homeDirectory)
    : "";
  const worktreeId = location.worktreeId || undefined;
  if (!cwd && !worktreeId) {
    cwd = ".";
  }
  const normalized = {
    status,
    cwd: cwd || undefined,
    worktreeId,
    files,
    findings,
    exitCode: exitCode ?? (status === "succeeded" ? 0 : 1),
  };
  return validateSubagentYield(normalized, {
    ...options,
    role: options.role ?? source.agent ?? source.role,
  });
}

export function formatSubagentYieldLines(value) {
  const lines = [];
  for (const [index, file] of value.files.entries()) {
    lines.push(`files[${index}]=${file}`);
  }
  for (const [index, finding] of value.findings.entries()) {
    lines.push(`findings[${index}].path=${finding.path}`);
    if (finding.note) lines.push(`findings[${index}].note=${finding.note}`);
  }
  lines.push(`exitCode=${value.exitCode}`);
  lines.push(`status=${value.status}`);
  if (value.worktreeId) lines.push(`worktreeId=${value.worktreeId}`);
  else if (value.cwd) lines.push(`cwd=${value.cwd}`);
  return lines.join("\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => block?.type === "text")
    .map(block => String(block.text ?? ""))
    .join("\n");
}

function trailingSubagentDiagnostic(result) {
  const sections = contentText(result?.content).trim().split(/\r?\n\s*\r?\n/);
  const candidate = String(sections.at(-1) ?? "").trim();
  if (
    !candidate
    || candidate.startsWith("{")
    || /^(?:files\[|findings\[|exitCode=|status=|cwd=|worktreeId=)/i.test(candidate)
  ) {
    return "";
  }
  return candidate;
}

function shortSummary(text, secrets = collectEnvSecrets()) {
  const compact = boundedText(
    redactStructuredSecrets(String(text ?? "").replace(/\s+/g, " ").trim(), secrets),
    240,
  );
  return compact;
}

export function readSubagentYieldField(toolResult, path) {
  const yieldValue = exactObject(toolResult?.details?.yield)
    ? toolResult.details.yield
    : Array.isArray(toolResult?.details?.yields)
      ? toolResult.details.yields[0]
      : undefined;
  if (!yieldValue) return undefined;
  const parts = String(path ?? "")
    .replaceAll("[", ".")
    .replaceAll("]", "")
    .split(".")
    .filter(Boolean);
  let current = yieldValue;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

export function isAsyncSubagentReceipt(result) {
  const details = result?.details;
  const text = contentText(result?.content ?? result);
  const asyncDir = typeof details?.asyncDir === "string" ? details.asyncDir.trim() : "";
  const detached = /The async run is detached/.test(text) || /^Async:\s+\S+/m.test(text);
  if (!asyncDir && !detached) return null;
  const headline = text.match(/^Async:\s+(\S+)\s+\[([^\]]+)\]/m);
  return {
    asyncDir,
    runId: String(details?.runId ?? details?.asyncId ?? headline?.[2] ?? "").trim(),
    agent: String(headline?.[1] ?? "").trim(),
    summary: shortSummary(text.split("\n")[0] ?? ""),
  };
}

function taskStubs(input) {
  if (!exactObject(input)) return [];
  if (typeof input.agent === "string" || typeof input.task === "string") {
    return [{ agent: input.agent, cwd: input.cwd, task: input.task }];
  }
  if (Array.isArray(input.tasks) && input.tasks.length) return input.tasks;
  if (Array.isArray(input.chain) && input.chain.length) return input.chain;
  return [];
}

export function formatSubagentToolInput(args, context = {}) {
  const stubs = taskStubs(args);
  if (!stubs.length) return "";
  const worktrees = context.worktrees ?? context.collaboration?.worktrees ?? [];
  return stubs.map((entry) => {
    const role = String(entry?.agent ?? "subagent").trim() || "subagent";
    const cwd = String(entry?.cwd ?? args?.cwd ?? "").trim();
    const worktree = worktrees.find(value => value.path === cwd);
    return worktree?.id ? `${role} · ${worktree.id}` : role;
  }).join(" · ");
}

export function projectSubagentRosterStart(input, context = {}) {
  const stubs = taskStubs(input);
  const toolCallId = String(context.toolCallId ?? "").trim() || "subagent";
  const worktrees = context.worktrees ?? context.collaboration?.worktrees ?? [];
  return stubs.map((entry, index) => {
    const role = String(entry?.agent ?? "subagent").trim() || "subagent";
    const prompt = String(entry?.task ?? "").trim();
    const cwd = String(entry?.cwd ?? input?.cwd ?? context.workspace ?? "").trim();
    const worktree = worktrees.find(value => value.path === cwd);
    const id = stubs.length === 1 ? toolCallId : `${toolCallId}:${index}`;
    return {
      id,
      toolCallId,
      role,
      prompt,
      status: "start",
      cwd: worktree?.id || undefined,
    };
  });
}

export function projectResearchSubagentUpdates(
  tasks,
  baselineIDs = new Set(),
  trackedIDs = new Set(),
  environment = process.env,
  additionalSecrets = [],
) {
  const secrets = collectEnvSecrets(environment, additionalSecrets);
  const updates = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = String(task?.id ?? "").trim();
    if (!id || baselineIDs.has(id)) continue;
    trackedIDs.add(id);
    const result = task.transcript
      || task.summary
      || (task.yield ? JSON.stringify(task.yield) : "");
    updates.push({
      id,
      prompt: boundedText(redactSecretValues(task.prompt, secrets), 16000),
      status: task.status === "start" ? "running" : String(task.status ?? "running"),
      workerId: boundedText(task.runId ?? task.id, 200),
      result: boundedText(redactSecretValues(result, secrets), 8000),
    });
  }
  return updates;
}

export function assignResearchSubagentTaskID(task, context) {
  const workerTaskID = String(task?.id ?? "").trim();
  if (!workerTaskID) return "";
  const existing = context?.workerTaskIDs?.get(workerTaskID);
  if (existing) return existing;
  if (context?.baseline?.has(workerTaskID)) return "";
  const prompt = String(task?.prompt ?? "").trim();
  const pending = context?.pending?.get(prompt);
  if (!pending?.length) return "";
  const taskID = pending.shift();
  if (!pending.length) context.pending.delete(prompt);
  context.workerTaskIDs.set(workerTaskID, taskID);
  context.workerPrompts?.set(workerTaskID, prompt);
  return taskID;
}

export function researchSubagentLaunchBlockReason(input, runContexts = [], toolCallId = "") {
  const contexts = Array.isArray(runContexts) ? runContexts : [];
  const active = contexts
    .filter(context => !context?.cancelled);
  if (!active.length) {
    return contexts.some(context => (
      context?.cancelled
      && (context.workerTaskIDs?.size > 0 || context.pending?.size > 0)
    ))
      ? "Research worker cancellation is in progress; do not launch another subagent yet."
      : "";
  }
  const action = String(input?.action ?? "").trim();
  if (action) {
    return ["list", "status", "get"].includes(action)
      ? ""
      : "During a research run, use cancel_research_run instead of steering or stopping individual workers.";
  }
  if (String(input?.agent ?? "").trim() !== "scout") {
    return "Research runs accept only the bundled read-only scout worker.";
  }
  const prompt = String(input?.task ?? "").trim();
  if (!prompt) {
    return "Research worker launch is missing its registered task prompt.";
  }
  const callID = String(toolCallId ?? "").trim();
  // The start event may consume the pending prompt before the pre-call policy hook runs.
  const alreadyBound = callID && active.some(context => (
    context.workerTaskIDs?.has(callID)
    && context.workerPrompts?.get(callID) === prompt
  ));
  if (!alreadyBound && !active.some(context => context.pending?.get(prompt)?.length)) {
    const pendingPromptLengths = active.flatMap(context => (
      context.pending instanceof Map
        ? [...context.pending.entries()]
          .filter(([, taskIDs]) => taskIDs?.length)
          .map(([registeredPrompt]) => registeredPrompt.length)
        : []
    ));
    const mismatch = pendingPromptLengths.length
      ? `submitted length ${prompt.length}; pending prompt lengths: ${pendingPromptLengths.join(", ")}`
      : "no pending registered prompt is visible";
    return `Research worker launch blocked: ${mismatch}. Reuse the exact taskPrompt returned by register_research_task.`;
  }
  return "";
}

export function projectSubagentRosterEnd(tasks, result, context = {}) {
  if (result?.details?.mode === "management") return Array.isArray(tasks) ? tasks : [];
  const receipt = isAsyncSubagentReceipt(result);
  if (receipt && !context.isError) {
    const list = Array.isArray(tasks) && tasks.length
      ? tasks
      : [{
        id: String(context.toolCallId || receipt.runId || "subagent"),
        toolCallId: context.toolCallId,
        role: receipt.agent || String(context.role ?? "subagent"),
        status: "start",
      }];
    return list.map(task => ({
      ...task,
      status: "running",
      asyncDir: receipt.asyncDir || undefined,
      runId: receipt.runId || undefined,
      summary: receipt.summary || undefined,
    }));
  }
  const yields = projectSubagentYields(result, context);
  const resultRows = Array.isArray(result?.details?.results)
    ? result.details.results
    : Array.isArray(result?.results)
      ? result.results
      : [result];
  const secrets = collectEnvSecrets(context.environment, context.secrets);
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length && yields.length) {
    return yields.map((value, index) => ({
      id: `${context.toolCallId || "subagent"}:${index}`,
      toolCallId: context.toolCallId,
      role: String(context.role ?? "subagent"),
      status: value.status === "succeeded" ? "succeeded" : "failed",
      durationMs: context.durationMs,
      exitCode: value.exitCode,
      yield: value,
    }));
  }
  return list.map((task, index) => {
    const value = yields[index] ?? yields[0];
    const failed = context.isError || !value || value.status !== "succeeded";
    const resultRow = resultRows[index] ?? resultRows[0];
    const diagnostic = [resultRow?.error, resultRow?.message, resultRow?.output]
      .find(item => typeof item === "string" && item.trim());
    const contentDiagnostic = trailingSubagentDiagnostic(result);
    const summary = failed
      ? shortSummary(
        diagnostic
          || contentDiagnostic
          || (value?.exitCode !== undefined ? `Worker exited with code ${value.exitCode}.` : ""),
        secrets,
      ) || task.summary
      : task.summary;
    return {
      ...task,
      status: failed ? "failed" : "succeeded",
      durationMs: context.durationMs,
      exitCode: value?.exitCode,
      yield: value,
      summary,
    };
  });
}

export function projectSubagentYields(raw, context = {}) {
  const results = Array.isArray(raw?.details?.results)
    ? raw.details.results
    : Array.isArray(raw?.results)
      ? raw.results
      : exactObject(raw)
        ? [raw]
        : [];
  if (!results.length) {
    return [normalizeSubagentYield(raw, context)];
  }
  return results.map((entry, index) => normalizeSubagentYield(entry, {
    ...context,
    role: context.roles?.[index] ?? entry?.agent ?? context.role,
    cwd: entry?.cwd ?? context.cwd,
  }));
}

export function projectSubagentToolResult(event, context = {}) {
  const secrets = collectEnvSecrets(context.environment, context.secrets);
  if (event?.details?.mode === "management") {
    return {
      content: redactStructuredSecrets(event?.content, secrets),
      details: redactStructuredSecrets(event?.details, secrets),
    };
  }
  if (isAsyncSubagentReceipt(event)) {
    return {
      content: redactStructuredSecrets(event?.content, secrets),
      details: redactStructuredSecrets(event?.details, secrets),
    };
  }
  const raw = {
    content: event?.content,
    details: event?.details,
    results: event?.results,
    yield: event?.yield,
    input: event?.input ?? event?.args,
    stdout: event?.stdout,
    exitCode: event?.exitCode,
    agent: event?.input?.agent ?? event?.args?.agent,
    cwd: event?.input?.cwd ?? event?.args?.cwd ?? context.cwd,
  };
  const worktrees = context.worktrees ?? context.collaboration?.worktrees ?? [];
  const roles = taskStubs(event?.input ?? event?.args).map(entry => entry.agent);
  const yields = projectSubagentYields({
    ...raw,
    details: event?.details ?? raw.details,
  }, {
    ...context,
    worktrees,
    workspace: context.workspace ?? context.collaboration?.workspace,
    role: roles[0] ?? event?.input?.agent ?? event?.args?.agent,
    roles,
  });
  const primary = yields[0];
  const original = contentText(event?.content);
  const summary = shortSummary(original, secrets);
  const fieldLines = yields.map((value, index) => (
    yields.length > 1
      ? `#${index}\n${formatSubagentYieldLines(value)}`
      : formatSubagentYieldLines(value)
  )).join("\n");
  const jsonBlock = JSON.stringify(yields.length === 1 ? primary : yields);
  const text = [fieldLines, jsonBlock, summary].filter(Boolean).join("\n\n");
  return {
    content: [{ type: "text", text }],
    details: {
      ...(exactObject(event?.details) ? redactStructuredSecrets(event.details, secrets) : {}),
      schema: subagentYieldSchema,
      yield: primary,
      yields,
    },
  };
}

function failedSubagentYield(workspace) {
  return {
    status: "failed",
    cwd: workspace,
    files: [],
    findings: [],
    exitCode: 1,
  };
}

export function createSubagentYieldExtension(getContext) {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (String(event?.toolName ?? "").trim() !== "subagent") return undefined;
      const context = typeof getContext === "function" ? getContext() : getContext;
      try {
        return projectSubagentToolResult(event, context);
      } catch {
        const workspace = String(context?.workspace ?? "").trim() || ".";
        return projectSubagentToolResult({
          toolName: "subagent",
          content: event?.content,
          input: event?.input ?? event?.args,
          details: {
            yield: failedSubagentYield(workspace),
          },
        }, {
          ...context,
          workspace,
        });
      }
    });
  };
}

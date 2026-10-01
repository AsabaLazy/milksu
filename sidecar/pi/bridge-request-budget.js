/**
 * 模型请求的两段式预算：把「一个总闹钟」拆成两个分工的闹钟。
 *
 * 事故（2026-09-29）：Dev Extend 会话（91MB）每次请求都在 ~10s 报
 * "Request timed out."。定因确认：那不是 MilkSU 的 TTFB 闹钟，而是 **undici 默认的
 * 10s 连接超时**（`connect.timeout`）经 OpenAI/Anthropic SDK 包装成
 * `APIConnectionTimeoutError`。它既不随请求体积伸缩，也不看首字节之后有没有数据。
 *
 * 这里定义 MilkSU 自己的两个阶段，每个阶段各有两个闹钟：
 *   1) 首字节阶段（TTFB）：软预算 = base + 体积 × 系数，封顶；请求越大给得越多。
 *   2) 流式阶段（首字节之后）：不再看总时长，只看「多久没有任何 chunk」。
 *
 * 软闹钟到点**不判死**：发一条告警（`onWarn`），把「疑似挂死」交给渲染层的看门狗，
 * 决定权回到读者手里。之后才武装硬闹钟；宽限内没有首字节 / 没有新 chunk，才真正掐死。
 * 事故（2026-09-29）：DeepSeek 读 3.16MB 要 51s 以上才回首个字节，旧的单段预算在
 * 51s 就掐死，而模型 60-80s 后仍可能回话。掐死那刀里有相当一部分是误杀。
 *
 * 阈值集中在这一处，可用环境变量覆盖，便于真机标定与测试。
 */

/**
 * 参考点（2026-10-01）：DeepSeek 上一个 2.78MB 的请求首字节超过 16.9s 才回来。
 * 「4MB ≈ 8.3s」（2026-09-29）那种标定太乐观——服务商有慢日子，余量得留足。
 * 现在 base 20s、每 MB 再加 10s：2.78MB ≈ 48s，4MB = 60s，封顶 300s（#212）。
 */
export const DEFAULT_REQUEST_BUDGET = Object.freeze({
  ttfbBaseMs: 20_000,
  ttfbPerMbMs: 10_000,
  ttfbMaxMs: 300_000,
  stallMs: 30_000,
  /** 软告警之后再等多久才硬掐：实测模型 60-80s 才回话，给到两倍余量。 */
  killGraceMs: 120_000,
  /** 单阶段硬掐的绝对上限：一个 sidecar 服务整个工作区，不能无限占用。
   *  必须 ≥ ttfbMaxMs + killGraceMs：否则软预算已到封顶的请求（≥28MB）宽限归零，
   *  告警和硬掐同刻触发，「先告警后掐死」失效（#212+#213 合并评审定的组合约束）。 */
  killMaxMs: 480_000,
});

const MIB = 1024 * 1024;

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 阈值集中读取；坏值一律回退默认，绝不让一个错的环境变量把请求全打死。 */
export function requestBudgetThresholds(environment = process.env) {
  const env = environment ?? {};
  return {
    ttfbBaseMs: positiveInt(env.MILKSU_PI_REQUEST_TTFB_BASE_MS, DEFAULT_REQUEST_BUDGET.ttfbBaseMs),
    ttfbPerMbMs: positiveInt(env.MILKSU_PI_REQUEST_TTFB_PER_MB_MS, DEFAULT_REQUEST_BUDGET.ttfbPerMbMs),
    ttfbMaxMs: positiveInt(env.MILKSU_PI_REQUEST_TTFB_MAX_MS, DEFAULT_REQUEST_BUDGET.ttfbMaxMs),
    stallMs: positiveInt(env.MILKSU_PI_REQUEST_STALL_MS, DEFAULT_REQUEST_BUDGET.stallMs),
    killGraceMs: positiveInt(env.MILKSU_PI_REQUEST_KILL_GRACE_MS, DEFAULT_REQUEST_BUDGET.killGraceMs),
    killMaxMs: positiveInt(env.MILKSU_PI_REQUEST_KILL_MAX_MS, DEFAULT_REQUEST_BUDGET.killMaxMs),
  };
}

/**
 * 每阶段两个阈值：软阈值（到点发告警）和硬阈值（到点掐死）。
 * 硬阈值 = min(软阈值 + 宽限, 绝对上限)，所以宽限再大也不会让一个请求占住工作区超过上限。
 */
function hardDeadline(softMs, limits) {
  return Math.min(softMs + limits.killGraceMs, limits.killMaxMs);
}

/** 首字节软预算 = base + 体积(MB) × 每MB系数，封顶 ttfbMaxMs；断流阈值与体积无关。 */
export function resolveRequestBudget({ payloadBytes = 0, thresholds } = {}) {
  // 缺字段按默认补齐：调用方常只覆盖自己关心的阈值，硬掐字段不该因此变成 NaN。
  const limits = { ...DEFAULT_REQUEST_BUDGET, ...(thresholds ?? {}) };
  const bytes = Math.max(0, Number(payloadBytes) || 0);
  const scaled = limits.ttfbBaseMs + (bytes / MIB) * limits.ttfbPerMbMs;
  const ttfbMs = Math.min(Math.round(scaled), limits.ttfbMaxMs);
  const stallMs = limits.stallMs;
  return {
    payloadBytes: bytes,
    ttfbMs,
    ttfbKillMs: hardDeadline(ttfbMs, limits),
    stallMs,
    stallKillMs: hardDeadline(stallMs, limits),
  };
}

/**
 * 只数大小、不建大字符串：context 可能是几十 MB，`JSON.stringify` 一次就够贵了，
 * 这里再 stringify 一次会把内存和时间都翻倍。
 */
export function estimateRequestBytes(value) {
  let bytes = 0;
  const seen = new Set();
  const walk = (node) => {
    if (node === null || node === undefined) {
      bytes += 4;
      return;
    }
    const type = typeof node;
    if (type === "string") {
      bytes += Buffer.byteLength(node) + 2;
      return;
    }
    if (type === "number" || type === "boolean") {
      bytes += 8;
      return;
    }
    if (type === "bigint") {
      bytes += String(node).length + 2;
      return;
    }
    if (type !== "object") {
      bytes += 2;
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    if (ArrayBuffer.isView(node)) {
      bytes += node.byteLength;
      return;
    }
    if (Array.isArray(node)) {
      bytes += 2;
      for (const item of node) walk(item);
      return;
    }
    bytes += 2;
    for (const key of Object.keys(node)) {
      bytes += Buffer.byteLength(key) + 4;
      walk(node[key]);
    }
  };
  walk(value);
  return bytes;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

function formatMegabytes(bytes) {
  return `${(bytes / MIB).toFixed(2)}MB`;
}

/** 判死时抛出的错误；文案里保留 "timed out"，让既有的来源回退/分类正则认得。 */
export class RequestBudgetError extends Error {
  constructor({ kind, budgetMs, waitedMs = budgetMs, payloadBytes = 0 }) {
    const stalled = kind === "stall";
    super(stalled
      ? `Model stream stalled: no data for ${formatSeconds(waitedMs)} after the first byte `
        + `(request ${formatMegabytes(payloadBytes)}, stall budget ${formatSeconds(budgetMs)}), `
        + "so the connection was dropped."
      : `Model request timed out before the first byte: no response within ${formatSeconds(waitedMs)} `
        + `(request ${formatMegabytes(payloadBytes)}, first-byte budget ${formatSeconds(budgetMs)}). `
        + "A larger request needs a larger first-byte budget, or the connection never came up.");
    this.name = "RequestBudgetError";
    this.kind = kind;
    this.budgetMs = budgetMs;
    this.waitedMs = waitedMs;
    this.payloadBytes = payloadBytes;
  }
}

function combineSignals(...signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  const forward = signal => controller.abort(signal.reason);
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => forward(signal), { once: true });
  }
  return controller.signal;
}

/**
 * 一个请求的预算看门狗。
 *
 * - `signal` 交给下游请求；硬掐时用 `RequestBudgetError` abort 它。
 * - `note()` 每收到一个事件调用：首个事件结束 TTFB 阶段、进入断流阶段，之后每个事件重置
 *   断流软闹钟与硬闹钟；有进展就不是死。
 * - `onWarn(stall)` 在软阈值到点时调用：`stall` 形如
 *   `{ stage: "ttfb" | "stream", kind: "ttfb" | "stall", budgetMs, payloadBytes }`。
 *   它只报告「疑似挂死」，不 abort。
 * - `timeoutError()` 取回本次硬掐的预算错误（供调用方把 AbortError 换成可读错误）。
 * - `stop()` 必须放在 finally：成功、失败、断流都不能留下定时器。
 *
 * 定时器可注入，单测不用真的等几分钟。
 */
export function createRequestBudgetGuard({
  payloadBytes = 0,
  thresholds,
  parentSignal,
  timerApi = { setTimeout, clearTimeout },
  onExpire,
  onWarn,
} = {}) {
  const budget = resolveRequestBudget({ payloadBytes, thresholds });
  const controller = new AbortController();
  const signal = combineSignals(parentSignal, controller.signal);
  let stage = "ttfb";
  let warnTimer = null;
  let killTimer = null;
  let warned = false;

  const clearWarn = () => {
    if (warnTimer !== null) {
      timerApi.clearTimeout(warnTimer);
      warnTimer = null;
    }
  };
  const clearKill = () => {
    if (killTimer !== null) {
      timerApi.clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const expire = (kind) => {
    if (controller.signal.aborted) return;
    const soft = kind === "stall" ? budget.stallMs : budget.ttfbMs;
    const hard = kind === "stall" ? budget.stallKillMs : budget.ttfbKillMs;
    const error = new RequestBudgetError({
      kind,
      budgetMs: soft,
      waitedMs: hard,
      payloadBytes: budget.payloadBytes,
    });
    try {
      onExpire?.(error);
    } catch {
      /* 观测回调不能挡住判死 */
    }
    controller.abort(error);
  };

  // 软告警：到点不再判死，把「疑似挂死」交给渲染层，之后才武装硬掐计时器。
  // 宽限里只要来了新事件，note() 就会把硬掐计时器换掉（有进展就不是死）。
  const warn = (kind) => {
    warned = true;
    const soft = kind === "stall" ? budget.stallMs : budget.ttfbMs;
    const hard = kind === "stall" ? budget.stallKillMs : budget.ttfbKillMs;
    try {
      onWarn?.({
        stage: kind === "stall" ? "stream" : "ttfb",
        kind,
        budgetMs: soft,
        payloadBytes: budget.payloadBytes,
      });
    } catch {
      /* 观测回调不能挡住告警 */
    }
    clearWarn();
    clearKill();
    killTimer = timerApi.setTimeout(() => expire(kind), Math.max(1, hard - soft));
  };

  warnTimer = timerApi.setTimeout(() => warn("ttfb"), budget.ttfbMs);

  return {
    budget,
    signal,
    get stage() {
      return stage;
    },
    get warned() {
      return warned;
    },
    note() {
      if (stage === "ttfb") {
        // 首字节到了：这次请求活着，TTFB 阶段的软告警和硬掐一并作废。
        stage = "stream";
      }
      clearWarn();
      clearKill();
      warned = false;
      warnTimer = timerApi.setTimeout(() => warn("stall"), budget.stallMs);
    },
    stop() {
      clearWarn();
      clearKill();
    },
    timeoutError() {
      return controller.signal.reason instanceof RequestBudgetError
        ? controller.signal.reason
        : null;
    },
    abort(error) {
      controller.abort(error);
    },
  };
}

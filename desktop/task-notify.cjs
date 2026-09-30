"use strict";

/**
 * 任务完成通知 —— 外壳层（批次 1）。
 *
 * 本模块**只做三件事**，且前两件是纯函数（不碰 Electron API ⇒ 可单测）：
 *   shouldNotify(input, state)  决策：该不该弹
 *   buildPayload(input)         组内容：标题/正文/四类前缀
 *   show(payload, deps)         真正弹（平台分支；依赖注入以便测试）
 *
 * 契约（见计划）：method = 'NotifyTask'
 *   args: { kind, conversationId, conversationTitle, summary, silent? }
 *   返回: { shown: boolean, reason?: 'focused'|'disabled'|'rate-limited'|'unsupported'|'invalid' }
 */

const TASK_NOTIFY_KINDS = Object.freeze(["completed", "failed", "needs-decision", "stalled"]);

/**
 * 防抖窗口（第二层）：同一**完整键**在这个窗口内重复出现 ⇒ rate-limited。
 * 注意它不再决定"新一轮能不能发"——是否算"同一事件"由键里的 turnKey 决定。
 */
const TASK_NOTIFY_WINDOW_MS = 60_000;

/** 四类通知的前缀（中英成对；渲染层文案不在这里断言 ✓）。 */
const KIND_PREFIX = Object.freeze({
  completed: { zh: "任务已完成", en: "Task finished" },
  failed: { zh: "任务被异常终止", en: "Task terminated unexpectedly" },
  "needs-decision": { zh: "需要你的决定", en: "Needs your decision" },
  // 停滞是**系统告警**（模型疑似挂死），与 needs-decision（等你拍板）目的不同：
  // 它不替用户做决定，只陈述“疑似卡死”这一事实。
  stalled: { zh: "模型疑似挂死", en: "Model appears stalled" },
});

function normalizeKind(input) {
  return String(input?.kind ?? "").trim();
}

function isSupportedPlatform(platform) {
  return platform === "darwin" || platform === "win32";
}

/**
 * 键构造（唯一来源 ⇒ main.cjs 与测试不会各写一份而漂移）：
 *   `${conversationId}:${kind}` ＋ 有 turnKey 时追加 `:${turnKey}`。
 * turnKey 归一化：null / undefined / 空串 / 纯空白 ⇒ **视为缺省**（退回旧键，不产生 `...:` 这种尾巴）。
 */
function taskNotifyKey(input = {}) {
  const conversationId = String(input?.conversationId ?? "").trim();
  if (!conversationId) return "";
  const kind = normalizeKind(input);
  const turnKey = String(input?.turnKey ?? "").trim();
  return turnKey ? `${conversationId}:${kind}:${turnKey}` : `${conversationId}:${kind}`;
}

/**
 * 这个键在窗口内见过吗？
 *   Map    ⇒ 值是上次通知时间戳：无记录或超过窗口 ⇒ 通过；
 *   对象   ⇒ 同上（按属性取值）；
 *   Set    ⇒ 老行为（无时间信息 ⇒ 见过即拦）；
 *   布尔标记（true）⇒ 老语义：已通知过 ⇒ 拦；
 *   其它   ⇒ 通过（没传就不拦）。
 */
function seenAllowsAgain(seenValue, now) {
  if (seenValue === undefined || seenValue === null || seenValue === false) return true;
  if (seenValue === true) return false;
  const seenAt = Number(seenValue);
  if (!Number.isFinite(seenAt)) return true;
  // 严格超过窗口才放行（恰好等于窗口时仍算"见过" ⇒ 由下面的边界用例钉住口径）
  return now - seenAt > TASK_NOTIFY_WINDOW_MS;
}

function notSeenKey(lastNotified, key, now = Date.now()) {
  if (!key) return true;
  if (!lastNotified) return true;
  if (typeof lastNotified.get === "function") return seenAllowsAgain(lastNotified.get(key), now);
  if (typeof lastNotified.has === "function") return !lastNotified.has(key);
  return seenAllowsAgain(lastNotified[key], now);
}

/**
 * 决策（纯函数 ✓）。顺序固定，先判"不可能的"再判"该不该弹"：
 *   非法 kind ⇒ invalid ｜ 开关关 ⇒ disabled ｜ 窗口聚焦 ⇒ focused
 *   ｜ 同**完整键**在窗口内已通知过 ⇒ rate-limited ｜ 平台不支持 ⇒ unsupported ｜ 否则 notify
 * state: { enabled?, focused?, platform?, lastNotified? (Set|Map|对象), now? }
 *   now 可注入 ⇒ 时间窗口可确定性测试（缺省 Date.now()）。
 */
function shouldNotify(input = {}, state = {}) {
  const kind = normalizeKind(input);
  if (!TASK_NOTIFY_KINDS.includes(kind)) return "invalid";
  if (state.enabled === false) return "disabled";
  if (state.focused === true) return "focused";
  const key = taskNotifyKey(input);
  const now = Number.isFinite(state.now) ? Number(state.now) : Date.now();
  if (!notSeenKey(state.lastNotified, key, now)) return "rate-limited";
  if (!isSupportedPlatform(String(state.platform ?? process.platform))) return "unsupported";
  return "notify";
}

/** 组内容（纯函数 ✓）：标题＝对话标题，正文＝summary；四类前缀不同（中英都给）。 */
function buildPayload(input = {}) {
  const kind = normalizeKind(input);
  const prefix = KIND_PREFIX[kind] ?? KIND_PREFIX.completed;
  const title = String(input?.conversationTitle ?? "").trim();
  const summary = String(input?.summary ?? "").trim();
  return {
    kind,
    conversationId: String(input?.conversationId ?? "").trim(),
    title: title || prefix.zh,
    body: summary || prefix.en,
    silent: input?.silent === true,
    prefix,
  };
}

/**
 * 真正弹（平台分支 ✓）。依赖注入 Notification/onClick ⇒ 可在 node 里测 ✓。
 * darwin / win32 支持；其它平台 ⇒ 'unsupported'（不猜 ✗）。
 */
function show(payload, deps = {}) {
  const platform = String(deps.platform ?? process.platform);
  if (!isSupportedPlatform(platform)) return "unsupported";
  const Notification = deps.Notification;
  if (typeof Notification !== "function") return "unsupported";
  const notification = new Notification({
    title: payload?.title ?? "",
    body: payload?.body ?? "",
    silent: payload?.silent === true,
  });
  if (typeof notification.on === "function" && typeof deps.onClick === "function") {
    notification.on("click", () => deps.onClick(payload));
  }
  if (typeof notification.show === "function") notification.show();
  return "shown";
}

/**
 * Dock 角标：**只有真的弹了通知**才 +1（被“前台压制 / 开关关闭 / inert 无效”挡掉的不加 ✗）。
 * 纯函数 ⇒ 可在 node 里单测 ✓。
 */
function badgeAfterNotify(current, status) {
  const base = Number.isFinite(Number(current)) && Number(current) > 0 ? Math.floor(Number(current)) : 0;
  return String(status ?? "").trim() === "shown" ? base + 1 : base;
}

/**
 * “已读”⇒ 清零。已读口径：App 回到前台（用户把窗口切回来，或点了那条通知跳回来）。
 */
function badgeAfterRead() {
  return 0;
}

module.exports = {
  TASK_NOTIFY_KINDS,
  TASK_NOTIFY_WINDOW_MS,
  KIND_PREFIX,
  taskNotifyKey,
  shouldNotify,
  buildPayload,
  show,
  badgeAfterNotify,
  badgeAfterRead,
};

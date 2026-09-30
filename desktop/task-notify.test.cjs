"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldNotify, buildPayload, show, KIND_PREFIX, badgeAfterNotify, badgeAfterRead } = require("./task-notify.cjs");

const base = { kind: "completed", conversationId: "c1", conversationTitle: "对话 A", summary: "跑完了" };
const free = { enabled: true, focused: false, platform: "darwin" };

test("聚焦 ⇒ focused（不通知）", () => {
  assert.equal(shouldNotify(base, { ...free, focused: true }), "focused");
});

// 停滞看门狗走同一条管道 ⇒ 前台压制对它也生效（用户在 App 里能直接看到停滞横幅，不必再弹系统通知）。
// 停滞是**独立的第四类**（stalled），不得复用 needs-decision（后者语义是“等你拍板”）。
test("停滞类 stalled：聚焦时被压制；不在前台才通知", () => {
  const stall = { kind: "stalled", conversationId: "c1", conversationTitle: "对话 A", summary: "模型请求已 2 分钟无响应，可回到会话选择重试或停止", turnKey: 123 };
  assert.equal(shouldNotify(stall, { ...free, focused: true }), "focused");
  assert.equal(shouldNotify(stall, free), "notify");
});

test("开关关 ⇒ disabled（不通知）", () => {
  assert.equal(shouldNotify(base, { ...free, enabled: false }), "disabled");
});

test("同对话同 kind 已通知过 ⇒ rate-limited（不通知）", () => {
  assert.equal(shouldNotify(base, { ...free, lastNotified: new Set(["c1:completed"]) }), "rate-limited");
  assert.equal(shouldNotify(base, { ...free, lastNotified: { "c1:completed": true } }), "rate-limited");
});

test("允许的 kind 就是这四种（与渲染层的 SHELL_NOTIFY_KINDS 对应）", () => {
  const { TASK_NOTIFY_KINDS } = require("./task-notify.cjs");
  assert.deepEqual([...TASK_NOTIFY_KINDS].sort(), ["completed", "failed", "needs-decision", "stalled"]);
  // 渲染层内部叫 needs-input，发出来必须已经翻译成 needs-decision；
  // 否则这里会判 invalid 直接丢弃（真机实测过这个 bug）。
  assert.equal(shouldNotify({ ...base, kind: "needs-input" }, free), "invalid");
});

test("非法 kind ⇒ invalid", () => {
  assert.equal(shouldNotify({ ...base, kind: "nope" }, free), "invalid");
  assert.equal(shouldNotify({ ...base, kind: "" }, free), "invalid");
});

test("平台不支持 ⇒ unsupported", () => {
  assert.equal(shouldNotify(base, { ...free, platform: "linux" }), "unsupported");
});

test("正常情况 ⇒ notify", () => {
  assert.equal(shouldNotify(base, free), "notify");
});

// —— 窗口 + turnKey（本轮新增口径）——
const now = 1_000_000_000_000;
const key = "c1:completed";

test("同一完整键：窗口内（30s）⇒ rate-limited；超窗（61s）⇒ notify", () => {
  assert.equal(shouldNotify(base, { ...free, now, lastNotified: new Map([[key, now - 30_000]]) }), "rate-limited");
  assert.equal(shouldNotify(base, { ...free, now, lastNotified: new Map([[key, now - 61_000]]) }), "notify");
  assert.equal(shouldNotify(base, { ...free, now, lastNotified: { [key]: now - 30_000 } }), "rate-limited");
  assert.equal(shouldNotify(base, { ...free, now, lastNotified: { [key]: now - 61_000 } }), "notify");
});

test("窗口边界：恰好等于窗口（60.000s）⇒ 仍算见过（rate-limited）；超过 1ms ⇒ notify", () => {
  // 口径：严格超过窗口才放行（与 main.cjs 的剪枝同一口径）
  assert.equal(
    shouldNotify(base, { ...free, now, lastNotified: new Map([[key, now - 60_000]]) }),
    "rate-limited",
  );
  assert.equal(
    shouldNotify(base, { ...free, now, lastNotified: new Map([[key, now - 60_001]]) }),
    "notify",
  );
  assert.equal(
    shouldNotify(base, { ...free, now, lastNotified: { [key]: now - 60_000 } }),
    "rate-limited",
  );
});

test("同会话同 kind、但 turnKey 不同 ⇒ notify（新的一轮/新的一次失败必须能发）", () => {
  const seen = new Map([["c1:failed:t1", now - 10_000]]);
  assert.equal(
    shouldNotify({ ...base, kind: "failed", turnKey: "t2" }, { ...free, now, lastNotified: seen }),
    "notify",
  );
  assert.equal(
    shouldNotify({ ...base, kind: "failed", turnKey: "t1" }, { ...free, now, lastNotified: seen }),
    "rate-limited",
  );
});

test("turnKey 缺省/空串/纯空白 ⇒ 退回旧键行为", () => {
  for (const turnKey of [undefined, null, "", "   "]) {
    const seen = new Map([[key, now - 10_000]]);
    assert.equal(shouldNotify({ ...base, turnKey }, { ...free, now, lastNotified: seen }), "rate-limited");
  }
  // 旧键命中时，不得因为多出 `...:` 尾巴而放过
  assert.equal(shouldNotify({ ...base, turnKey: "  " }, { ...free, now, lastNotified: { [key]: true } }), "rate-limited");
});

test("剪枝：超过窗口的项被删、恰好等于窗口的项保留", () => {
  const seen = new Map([[key, now - 10_000]]);
  for (const [seenKey, seenAt] of seen) {
    if (now - Number(seenAt) > 60_000) seen.delete(seenKey);
  }
  assert.equal(seen.size, 1, "窗口内的项不该被剪掉");
  const border = new Map([[key, now - 60_000]]);
  for (const [seenKey, seenAt] of border) {
    if (now - Number(seenAt) > 60_000) border.delete(seenKey);
  }
  assert.equal(border.size, 1, "恰好等于窗口的项也要保留（与 shouldNotify 同一口径）");
  const aged = new Map([[key, now - 120_000]]);
  for (const [seenKey, seenAt] of aged) {
    if (now - Number(seenAt) > 60_000) aged.delete(seenKey);
  }
  assert.equal(aged.size, 0, "超过窗口的项必须被剪掉");
  assert.equal(shouldNotify(base, { ...free, now, lastNotified: aged }), "notify");
});

test("taskNotifyKey：归一化（空/空白 turnKey 不入键）", () => {
  const { taskNotifyKey } = require("./task-notify.cjs");
  assert.equal(taskNotifyKey({ conversationId: "c1", kind: "failed" }), "c1:failed");
  assert.equal(taskNotifyKey({ conversationId: "c1", kind: "failed", turnKey: "  " }), "c1:failed");
  assert.equal(taskNotifyKey({ conversationId: "c1", kind: "failed", turnKey: "t9" }), "c1:failed:t9");
  assert.equal(taskNotifyKey({ conversationId: "  ", kind: "failed" }), "");
});

test("buildPayload：标题＝对话标题、正文＝summary、四类前缀不同（中英成对）", () => {
  const p = buildPayload(base);
  assert.equal(p.title, "对话 A");
  assert.equal(p.body, "跑完了");
  assert.equal(p.prefix.zh, KIND_PREFIX.completed.zh);
  assert.equal(p.prefix.en, KIND_PREFIX.completed.en);
  const kinds = ["completed", "failed", "needs-decision", "stalled"].map(k => buildPayload({ ...base, kind: k }));
  const zh = new Set(kinds.map(k => k.prefix.zh));
  assert.equal(zh.size, 4, "四类 kind 的前缀必须互不相同");
  for (const k of kinds) assert.ok(k.prefix.zh && k.prefix.en, "中英必须成对");
  // 停滞前缀固定为“模型疑似挂死”，不能与“需要你的决定”混同。
  assert.deepEqual(KIND_PREFIX.stalled, { zh: "模型疑似挂死", en: "Model appears stalled" });
  assert.notEqual(KIND_PREFIX.stalled.zh, KIND_PREFIX["needs-decision"].zh);
});

test("buildPayload：缺标题/正文时有默认（不抛）", () => {
  const p = buildPayload({ kind: "failed" });
  assert.equal(p.title, KIND_PREFIX.failed.zh);
  assert.equal(p.body, KIND_PREFIX.failed.en);
});

test("show：darwin/win32 用注入的 Notification ⇒ shown，点击回调带上 conversationId", () => {
  const seen = [];
  class FakeNotification {
    constructor(options) { this.options = options; }
    on(event, handler) { if (event === "click") this.click = handler; }
    show() { seen.push("shown"); }
  }
  for (const platform of ["darwin", "win32"]) {
    const payload = buildPayload(base);
    const result = show(payload, { platform, Notification: FakeNotification, onClick: p => seen.push(p.conversationId) });
    assert.equal(result, "shown");
  }
  assert.deepEqual(seen.filter(x => x === "shown").length, 2);
});

test("show：其它平台 ⇒ unsupported", () => {
  assert.equal(show(buildPayload(base), { platform: "linux", Notification: class {} }), "unsupported");
});

// 源码级守卫（不 require electron ✗）：确认 main.cjs 的 NotifyTask 分支存在，
// 且没有为它新开第二条 IPC 通道。
const fs = require("node:fs");
const path = require("node:path");

test("main.cjs：NotifyTask 分支存在，且没有新增 ipcMain.handle", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /if \(method === 'NotifyTask'\)/, "NotifyTask 分支必须存在");
  assert.match(source, /require\('\.\/task-notify\.cjs'\)/, "必须复用纯函数模块");
  assert.match(source, /emitRendererEvent\('task\.notify\.clicked'/, "点击必须推回渲染层事件");
  assert.match(source, /(isVisible|isFocused)\(\)/, "聚焦判断必须用 mainWindow 的可见/聚焦 API");
  // 聚焦判断必须是 isFocused：用 isVisible 时"窗口在后台但可见"会被当成"用户在看" ✗
  // ⇒ 实测把通知全部压掉（直调返回 reason=focused，macOS 侧从未登记过本 App）。
  assert.match(source, /mainWindow\.isFocused\(\)/, "聚焦判断必须是 isFocused");
  assert.doesNotMatch(source, /focused:[^\n]*isVisible\(\)/, "聚焦判断不得退回 isVisible（会把后台可见窗口当成在看）");
  const handles = source.match(/ipcMain\.handle\(/g) ?? [];
  assert.equal(handles.length, 1, "不得新增第二条 ipcMain.handle 通道");
});

test("main.cjs：跨调用记录用带时间戳的 Map，并复用统一键构造（不得回退成永久 Set）", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /const taskNotifySeen = new Map\(\)/, "必须是 Map（值＝时间戳）");
  assert.doesNotMatch(source, /const taskNotifySeen = new Set\(\)/, "不得回退成永久 Set");
  assert.match(source, /taskNotifyKey\(notifyInput\)/, "写入必须用统一键构造");
  assert.match(source, /taskNotifySeen\.delete\(/, "写入前必须剪枝");
  // 剪枝必须在写入之前
  const pruneAt = source.indexOf("taskNotifySeen.delete(");
  const setAt = source.indexOf("taskNotifySeen.set(");
  assert.ok(pruneAt > -1 && setAt > -1 && pruneAt < setAt, "剪枝必须在写入之前");
  // 时间源统一：一次调用只取一次 now，判断与写入共用一个值
  assert.match(source, /now: notifyNow/, "shouldNotify 必须收到同一个 now");
  assert.match(source, /taskNotifySeen\.set\(taskNotifyKey\(notifyInput\), notifyNow\)/, "写入必须用同一个 now");
});

test("角标：只有真的弹出（shown）才 +1", () => {
  assert.equal(badgeAfterNotify(0, "shown"), 1);
  assert.equal(badgeAfterNotify(2, "shown"), 3);
});

test("角标：被挡掉的情况（前台压制/关闭/无效/限流/不支持）不加", () => {
  for (const status of ["focused", "disabled", "invalid", "rate-limited", "unsupported", ""]) {
    assert.equal(badgeAfterNotify(2, status), 2, `${status} 不该加角标`);
  }
});

test("角标：已读清零，且非法当前值按 0 处理（防御）", () => {
  assert.equal(badgeAfterRead(), 0);
  assert.equal(badgeAfterNotify(undefined, "shown"), 1);
  assert.equal(badgeAfterNotify(-5, "shown"), 1);
  assert.equal(badgeAfterNotify("x", "focused"), 0);
});

test("外壳接线：+1 只在 shown 分支；聚焦与点通知两处清零；用 Electron 的角标 API", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /applyTaskNotifyBadge\(badgeAfterNotify\(taskNotifyBadge, notifyResult\)\)/);
  assert.match(source, /applyTaskNotifyBadge\(badgeAfterRead\(\)\)/, "点通知与聚焦都要清零");
  assert.match(source, /mainWindow\.on\('focus', \(\) => \{\n\s*applyTaskNotifyBadge\(badgeAfterRead\(\)\)/);
  assert.match(source, /app\.setBadgeCount\(taskNotifyBadge\)/);
});

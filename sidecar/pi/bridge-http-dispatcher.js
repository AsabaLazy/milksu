/**
 * 让 MilkSU 掌握模型请求的「连接建立」超时。
 *
 * 定因（2026-09-29）：旧 Dev Extend 会话每次请求在 ~10.5s 报
 * `APIConnectionTimeoutError: Request timed out.`。真实 sidecar 指向不可达地址时
 * 精确复现同一时间，指向正常地址时 15s 首字节、40s 断流都不报错 —— 说明那个
 * 「一刀切 ~10s」不是 TTFB 闹钟，而是 **undici 的默认 `connect.timeout = 10s`**
 * （pi/Node 都没有改过它），只在 TCP/TLS 连接迟迟建不起来时才开枪。
 *
 * pi 的 `configureHttpDispatcher` 只管 `headersTimeout`/`bodyTimeout`，不管连接超时；
 * 而且 SDK 路径根本不会调用它。所以这里在 sidecar 启动时装一个由 MilkSU 掌握的
 * 全局 dispatcher：连接超时拉齐到首字节预算的上限，配合每个请求的两段式预算
 * （`bridge-request-budget.js`）共同判定 —— 连接慢不再被固定 10s 误杀，
 * 真正的死流由断流检测在 30s 判死。
 *
 * 只改「连接建立」一个量：headers/body 保持 undici 的 300s 兜底，避免影响
 * MCP / 网页研究 / 插件等其它 fetch。
 */
import { Agent, setGlobalDispatcher } from "undici";
import { requestBudgetThresholds } from "./bridge-request-budget.js";

/** 连接超时与首字节预算上限对齐（默认 300s，随 MILKSU_PI_REQUEST_TTFB_MAX_MS），保证每个请求的预算看门狗才是权威。 */
export function connectTimeoutMs(environment = process.env) {
  return requestBudgetThresholds(environment).ttfbMaxMs;
}

/**
 * 装全局 dispatcher。`createAgent` / `setDispatcher` 可注入，单测不用真改进程状态。
 * 失败不抛：装不上就沿用 undici 默认（会退回 10s 连接超时），但绝不能拦住 sidecar 启动。
 */
export function installRequestHttpDispatcher({
  environment = process.env,
  createAgent,
  setDispatcher,
  onError,
} = {}) {
  const timeout = connectTimeoutMs(environment);
  try {
    const create = createAgent ?? (options => new Agent(options));
    const set = setDispatcher ?? setGlobalDispatcher;
    const agent = create({ connect: { timeout } });
    set(agent);
    return { connectTimeoutMs: timeout, installed: true, agent };
  } catch (error) {
    onError?.(error);
    return { connectTimeoutMs: timeout, installed: false, error };
  }
}

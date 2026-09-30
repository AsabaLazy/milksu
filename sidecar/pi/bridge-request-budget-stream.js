/**
 * 把两段式预算套到**所有**模型请求上。
 *
 * 为什么是这里：`configureRuntimeModel` 在只有一个来源时（账号、或用户自己的中转站，
 * 也就是绝大多数回合）会直接早退，**不会**注册 `milksu-route` —— 那条路由只在
 * 「账号 + 自有来源」双来源回合才走。所以在 `model-source-routing.js` 里包一层会漏掉主干。
 * pi 的 agent loop 是动态调用 `modelRuntime.streamSimple(...)`（见 pi-coding-agent 的
 * streamFn），因此在这里包住它，账号 / 自有中转 / 双来源三条路径都覆盖到。
 *
 * 行为：请求前建看门狗，把 `signal` 交给真正的请求；首个事件前是首字节预算，
 * 之后改用断流检测。判死时把 SDK 的「Request was aborted.」换成带阶段与预算的可读错误，
 * 其余事件原样透传 —— 不改变正常回合的任何语义。
 */
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createRequestBudgetGuard,
  estimateRequestBytes,
  requestBudgetThresholds,
} from "./bridge-request-budget.js";

const APPLIED = Symbol.for("milksu.pi.requestBudget.applied");

function budgetErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 把失败包成 pi 的 error 事件（协议里 `error` 是一个 assistant 消息对象）。 */
function budgetErrorEvent(error, fallbackMessage) {
  const base = fallbackMessage && typeof fallbackMessage === "object" ? fallbackMessage : {};
  return {
    type: "error",
    reason: "error",
    error: {
      ...base,
      stopReason: "error",
      errorMessage: budgetErrorMessage(error),
    },
  };
}

/** 正常事件原样透传；只有「预算判死且这一事件是失败」时才换文案。 */
function passThrough(event, guard) {
  const timeout = guard.timeoutError();
  if (!timeout || event?.type !== "error") return event;
  return budgetErrorEvent(timeout, event.error);
}

function budgetedStream(inner, guard) {
  const outer = new AssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of inner) {
        guard.note();
        outer.push(passThrough(event, guard));
      }
      outer.end();
    } catch (error) {
      // 有些失败是抛出来的（没有 error 事件），同样翻译成预算文案。
      outer.push(budgetErrorEvent(guard.timeoutError() ?? error));
      outer.end();
    } finally {
      guard.stop();
    }
  })();
  return outer;
}

/**
 * 包住 `runtime.streamSimple`，返回是否成功接上。
 * `thresholds` / `estimateBytes` / `timerApi` 可注入，便于单测与真机标定。
 */
export function applyRequestBudgetToRuntime(runtime, {
  thresholds = requestBudgetThresholds,
  estimateBytes = estimateRequestBytes,
  timerApi,
} = {}) {
  if (!runtime || typeof runtime.streamSimple !== "function") return false;
  if (runtime[APPLIED]) return true;
  const original = runtime.streamSimple.bind(runtime);

  runtime.streamSimple = (model, context, options) => {
    const guard = createRequestBudgetGuard({
      payloadBytes: estimateBytes(context),
      thresholds: typeof thresholds === "function" ? thresholds() : thresholds,
      parentSignal: options?.signal,
      timerApi,
    });
    let inner;
    try {
      inner = original(model, context, { ...(options ?? {}), signal: guard.signal });
    } catch (error) {
      guard.stop();
      throw error;
    }
    return budgetedStream(inner, guard);
  };
  Object.defineProperty(runtime, APPLIED, { value: true, enumerable: false });
  return true;
}

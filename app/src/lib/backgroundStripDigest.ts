// 「后台任务」窄带的事实口径（纯函数，**不出文案** —— 句子由组件按 t(中文, English) 成对写）。
//
// 口径来源（由监工拍定）：
// - status 的真实取值是 `running / succeeded / failed / cancelled / timed_out`
//   （app/src/codingEnvironmentTypes.ts:72；侧车遇未知值降级 `failed`，bridge-background-view.js:71）。
// - 终态的判定**必须用过滤前的完整任务列表**，优先级从上到下：
//     有 failed / timed_out ⇒ failed；否则有 cancelled ⇒ cancelled；否则有 running ⇒ 还在跑；否则 ⇒ completed。
// - 终态只在"在跑集合**从非空变空**"那一刻形成，之后在窄带里**停 15 秒**自动收起。
// - ⚠️ 窄带**没有**百分比可言：数据里只有 status，没有进度数字 —— 不要编（范围外）。

export type BackgroundTaskLike = { id?: unknown; name?: unknown; status?: unknown }

export type BackgroundStripStatusKind = 'running' | 'failed' | 'cancelled' | 'completed'

export type BackgroundTaskOutcome = {
  kind: 'failed' | 'cancelled' | 'completed'
  count: number
  /** 其中**失败**（含超时）的个数。`count` 是一批的总数，拿它当“失败几个”会误导
   *  （真机截图：一批 11 个里只有 1 个失败，却写成“共 11 个”✗）。 */
  failedCount?: number
  firstName: string
  at: number
}

export type BackgroundStripDigest = {
  visible: boolean
  mode: 'running' | 'settled'
  count: number
  firstName: string
  moreCount: number
  statusKind: BackgroundStripStatusKind
}

/** 终态在窄带里停留多久（用户拍：15 秒）。 */
export const BACKGROUND_STRIP_SETTLED_MS = 15_000

function statusOf(task: BackgroundTaskLike | undefined): string {
  return String(task?.status ?? '')
}

function nameOf(task: BackgroundTaskLike | undefined): string {
  return String(task?.name ?? '').trim()
}

/** 在跑的任务（事实层存的就是这一份）。 */
export function runningTasks(tasks: BackgroundTaskLike[] | undefined | null): BackgroundTaskLike[] {
  return (Array.isArray(tasks) ? tasks : []).filter(task => statusOf(task) === 'running')
}

/**
 * 用**完整**任务列表算终态。仍在跑（含"还有 running"）⇒ null（那时窄带显示"进行中"，不该有终态）。
 */
export function outcomeForTasks(
  tasks: BackgroundTaskLike[] | undefined | null,
  at: number,
): BackgroundTaskOutcome | null {
  const list = (Array.isArray(tasks) ? tasks : []).filter(Boolean)
  if (list.length === 0) return null
  if (list.some(task => ['failed', 'timed_out'].includes(statusOf(task)))) {
    const failedCount = list.filter(task => ['failed', 'timed_out'].includes(statusOf(task))).length
    return { kind: 'failed', count: list.length, failedCount, firstName: nameOf(list[0]), at }
  }
  if (list.some(task => statusOf(task) === 'cancelled')) {
    return { kind: 'cancelled', count: list.length, firstName: nameOf(list[0]), at }
  }
  if (list.some(task => statusOf(task) === 'running')) return null
  return { kind: 'completed', count: list.length, firstName: nameOf(list[0]), at }
}

/** 窄带该显示什么：在跑优先；否则看终态是否还在 15 秒窗口内。 */
export function backgroundStripDigest({
  running,
  outcome,
  now,
}: {
  running?: BackgroundTaskLike[] | null
  outcome?: BackgroundTaskOutcome | null
  now: number
}): BackgroundStripDigest {
  const live = runningTasks(running)
  if (live.length > 0) {
    return {
      visible: true,
      mode: 'running',
      count: live.length,
      firstName: nameOf(live[0]),
      moreCount: live.length - 1,
      statusKind: 'running',
    }
  }
  if (outcome && now - outcome.at < BACKGROUND_STRIP_SETTLED_MS) {
    return {
      visible: true,
      mode: 'settled',
      count: outcome.count,
      firstName: outcome.firstName,
      moreCount: Math.max(0, outcome.count - 1),
      statusKind: outcome.kind,
    }
  }
  return { visible: false, mode: 'settled', count: 0, firstName: '', moreCount: 0, statusKind: 'completed' }
}

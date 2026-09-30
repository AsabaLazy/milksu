import { useT } from '@/hooks/useUiLocale'

// 3×3 点阵：**九个格子的位置都在**，点亮的是一条 Z 形路径 —— 上排三格填满 + 中间一格 + 下排三格填满。
// 路径（行优先索引）：0,1,2（上排）→ 4（中）→ 6,7,8（下排）。
const BACKGROUND_TASK_PATH = [0, 1, 2, 4, 6, 7, 8]
const BACKGROUND_TASK_SLOTS = 9

/**
 * 「这个会话有后台任务在跑」的标记（侧栏用）。
 *
 * 形态：**和运行中/待决策标记同一套 3×3 网格**（`.agent-pixel` = `repeat(3, 4px)` + `gap 1.5px`；
 * `.agent-pixel__cell` = 4×4 + `border-radius: 1px`）⇒ 并排时尺寸完全一致；颜色**蓝色**。
 * 点亮的是一条 **Z 形**：上排三格 + 中间一格 + 下排三格（共 7 格）。
 *
 * 为什么只做标记、不做文字：读者在这一栏要的是**"还有东西在跑"这一个事实** ✓，
 * 不是"几个任务、叫什么名字"这种详情（真机反馈：那行文字把会话列表挤坏了，
 * 而且任务结束后还会留着 ✗）。详情放到对话里说。
 *
 * 无障碍：`role="status"` + 双语 `aria-label`（这是状态，不是按钮）；`prefers-reduced-motion` 关动画。
 */
export default function AgentBackgroundTaskMark({ label }: { label?: string }) {
  const t = useT()
  const text = label ?? t('后台任务进行中', 'Background task running')
  return (
    <span className="agent-bg-task-mark inline-flex items-center" role="status" aria-label={text}>
      {/* 蓝色工具类放在**点亮的格子**上：它只用来让 Tailwind 把主题变量发射出来，真正的底色
          写在下面未分层的 `.agent-pixel--bg-task .agent-pixel__cell` 里（否则会被原版规则盖掉）。
          ⚠️ 不能放在网格容器上 —— 未点亮的格子是**透明**的，容器着色会让那四格也泛蓝 ✗（真机截图证实）。 */}
      <span className="agent-pixel agent-pixel--bg-task" aria-hidden="true">
        {Array.from({ length: BACKGROUND_TASK_SLOTS }, (_slot, index) =>
          BACKGROUND_TASK_PATH.includes(index)
            ? <span key={index} className="agent-pixel__cell agent-pixel__cell--bg-task bg-blue-400" />
            : <span key={index} className="agent-pixel__cell--hole" />,
        )}
      </span>
    </span>
  )
}

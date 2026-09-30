import ProgressiveBlur from 'react-progressive-blur'

/** Bottom-only edge blur for the composer dock. */
export function ChatEdgeFade() {
  return (
    <div className="chat-edge-fade chat-edge-fade-bottom" aria-hidden="true">
      <ProgressiveBlur className="chat-edge-fade-progressive" position="bottom" intensity={100} />
    </div>
  )
}

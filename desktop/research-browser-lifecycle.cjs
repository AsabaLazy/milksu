'use strict'

function createResearchWebContentsDisposer({
  gateForPartition,
  hasResearchPartition,
  releaseResearchPartition,
}) {
  const disposals = new WeakMap()

  return function destroyResearchWebContents(webContents, partition) {
    const existing = disposals.get(webContents)
    if (existing) return existing

    const disposal = Promise.resolve().then(async () => {
      const gate = gateForPartition(partition)
      const id = webContents.id
      if (!webContents.isDestroyed()) {
        if (
          gate.isResearchMode()
          || gate.isRestricted(id)
          || hasResearchPartition(partition)
        ) {
          await new Promise((resolve, reject) => {
            if (webContents.isDestroyed()) {
              resolve()
              return
            }
            const onDestroyed = () => resolve()
            webContents.once('destroyed', onDestroyed)
            try {
              webContents.destroy()
            } catch (error) {
              webContents.removeListener('destroyed', onDestroyed)
              if (webContents.isDestroyed()) resolve()
              else reject(error)
            }
          })
        } else {
          webContents.close()
        }
      }
      gate.unmark(id)
      await releaseResearchPartition(partition)
    })
    disposals.set(webContents, disposal)
    void disposal.catch(() => {
      if (disposals.get(webContents) === disposal) disposals.delete(webContents)
    })
    return disposal
  }
}

module.exports = { createResearchWebContentsDisposer }

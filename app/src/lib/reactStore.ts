import { useEffect, useMemo, useSyncExternalStore } from 'react'

export interface Store<T extends object> {
  getState: () => T
  setState: (updater: Partial<T> | ((state: T) => T)) => void
  subscribe: (listener: () => void) => () => void
}

function sameState<T extends object>(previous: T, next: T): boolean {
  if (Object.is(previous, next)) return true
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    if (!Object.is(
      (previous as Record<string, unknown>)[key],
      (next as Record<string, unknown>)[key],
    )) return false
  }
  return true
}

export interface StoreOptions {
  /**
   * 自定义「通知订阅者（即 React 重新渲染）」的时机。
   *
   * 关键：`getState()` 永远**同步**返回最新状态，业务逻辑不受影响；被合并的只是订阅者通知。
   * 流式增量场景里，一帧内到多次写状态时会合并成一次 React 渲染，避免主线程被喂满。
   * 返回一个取消函数（生产环境一般用不上，卸载时可调用）。
   */
  schedulePublish?: (flush: () => void) => () => void
}

export function createStore<T extends object>(
  initial: T,
  options?: StoreOptions,
): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  let publishing = false
  let queued = false
  let publishScheduled = false

  function publish() {
    if (publishing) {
      queued = true
      return
    }
    publishing = true
    try {
      do {
        queued = false
        for (const listener of [...listeners]) listener()
      } while (queued)
    } finally {
      publishing = false
    }
  }

  function notify() {
    if (!options?.schedulePublish) {
      publish()
      return
    }
    if (publishScheduled) return
    publishScheduled = true
    options.schedulePublish(() => {
      publishScheduled = false
      publish()
    })
  }

  return {
    getState() {
      return state
    },
    setState(updater) {
      const next = typeof updater === 'function' ? updater(state) : { ...state, ...updater }
      if (sameState(state, next)) return
      state = next
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

export function nextTick() {
  return Promise.resolve()
}

export function useStoreRuntime<R>(factory: () => R): R {
  const runtime = useMemo(factory, []) as R & {
    store: Store<object>
    start?: () => void
    stop?: () => void
    mount?: () => void
    unmount?: () => void
    dispose?: () => void
  }
  useStore(runtime.store)
  useEffect(() => {
    runtime.mount?.()
    if (!runtime.mount) runtime.start?.()
    return () => {
      runtime.unmount?.()
      if (!runtime.unmount) runtime.stop?.()
      runtime.dispose?.()
    }
  }, [runtime])
  return runtime
}

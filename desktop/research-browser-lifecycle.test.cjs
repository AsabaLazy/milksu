'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { createResearchWebContentsDisposer } = require('./research-browser-lifecycle.cjs')

test('restricted WebContents stays gated until its destroyed event and disposes once', async () => {
  const order = []
  const gate = {
    isResearchMode: () => true,
    isRestricted: () => true,
    unmark() { order.push('unmark') },
  }
  const partition = {}
  let releases = 0
  const dispose = createResearchWebContentsDisposer({
    gateForPartition: () => gate,
    hasResearchPartition: () => true,
    async releaseResearchPartition() {
      releases += 1
      order.push('release')
    },
  })
  const contents = new EventEmitter()
  let destroyed = false
  let destroyCalls = 0
  contents.id = 9
  contents.isDestroyed = () => destroyed
  contents.destroy = () => {
    destroyCalls += 1
    order.push('destroy')
  }
  contents.close = () => { throw new Error('Research contents must use destroy') }

  const first = dispose(contents, partition)
  const second = dispose(contents, partition)
  await Promise.resolve()
  assert.equal(destroyCalls, 1)
  assert.deepEqual(order, ['destroy'])
  assert.equal(releases, 0)

  destroyed = true
  contents.emit('destroyed')
  await Promise.all([first, second])
  assert.deepEqual(order, ['destroy', 'unmark', 'release'])
  assert.equal(releases, 1)
})

test('ordinary WebContents keeps the ordinary close path', async () => {
  const order = []
  const dispose = createResearchWebContentsDisposer({
    gateForPartition: () => ({
      isResearchMode: () => false,
      isRestricted: () => false,
      unmark() { order.push('unmark') },
    }),
    hasResearchPartition: () => false,
    async releaseResearchPartition() { order.push('release') },
  })
  const contents = new EventEmitter()
  let closed = 0
  contents.id = 10
  contents.isDestroyed = () => false
  contents.destroy = () => { throw new Error('ordinary contents should not be destroyed') }
  contents.close = () => { closed += 1; order.push('close') }

  await dispose(contents, {})
  assert.equal(closed, 1)
  assert.deepEqual(order, ['close', 'unmark', 'release'])
})

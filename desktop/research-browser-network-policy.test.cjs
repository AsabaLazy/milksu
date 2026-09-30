'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  applyResearchWebRTCPolicy,
  canActivateTabInResearchMode,
  createResearchBrowserNetworkGate,
  redactResearchDisplayText,
  redactResearchURL,
} = require('./research-browser-network-policy.cjs')

function webRequestHarness(options = {}) {
  let listener
  let filter
  const browserSession = {
    webRequest: {
      onBeforeRequest(requestFilter, callback) {
        filter = requestFilter
        listener = callback
      },
    },
  }
  const gate = createResearchBrowserNetworkGate(browserSession, options)
  return {
    gate,
    filter,
    request(details) {
      return new Promise(resolve => listener(details, resolve))
    },
  }
}

test('marked Research Browser allows requests resolving only to public addresses', async () => {
  const lookedUp = []
  const harness = webRequestHarness({
    lookup: async (hostname, options) => {
      lookedUp.push({ hostname, options })
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ]
    },
  })
  harness.gate.mark(11)

  const result = await harness.request({
    url: 'https://papers.example.org/article',
    webContentsId: 11,
    resourceType: 'mainFrame',
  })
  const redirectTarget = await harness.request({
    url: 'http://127.0.0.1/private',
    webContentsId: 11,
    resourceType: 'mainFrame',
  })

  assert.deepEqual(harness.filter, { urls: ['<all_urls>'] })
  assert.deepEqual(result, { cancel: false })
  assert.deepEqual(redirectTarget, { cancel: true })
  assert.equal(lookedUp[0].hostname, 'papers.example.org')
  assert.deepEqual(lookedUp[0].options, { all: true, verbatim: true })
})

test('marked Research Browser blocks private IP literals and mixed public/private DNS', async () => {
  let lookupCount = 0
  const harness = webRequestHarness({
    lookup: async () => {
      lookupCount += 1
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '10.12.0.8', family: 4 },
        { address: 'fe80::1', family: 6 },
      ]
    },
  })
  harness.gate.mark(12)

  const literalResults = []
  for (const url of [
    'http://127.0.0.1/admin',
    'http://2130706433/admin',
    'http://100.64.0.1/admin',
    'http://169.254.169.254/latest',
    'http://localhost:3000/',
    'http://printer.local/',
    'http://[::1]/admin',
    'http://[fc00::1]/admin',
  ]) {
    literalResults.push(await harness.request({
      url,
      webContentsId: 12,
      resourceType: 'mainFrame',
    }))
  }
  const dns = await harness.request({
    url: 'https://papers.example.org/private-image.png',
    webContentsId: 12,
    resourceType: 'image',
  })

  assert.deepEqual(literalResults, Array(8).fill({ cancel: true }))
  assert.deepEqual(dns, { cancel: true })
  assert.equal(lookupCount, 1, 'IP literals must not be sent to DNS')
})

test('marked Research Browser fails closed on DNS lookup errors and timeouts', async t => {
  await t.test('lookup error', async () => {
    const harness = webRequestHarness({
      lookup: async () => { throw new Error('DNS unavailable') },
    })
    harness.gate.mark(13)
    assert.deepEqual(await harness.request({
      url: 'https://papers.example.org/',
      webContentsId: 13,
    }), { cancel: true })
  })

  await t.test('lookup timeout', async () => {
    const harness = webRequestHarness({
      lookup: () => new Promise(() => {}),
      timeoutMs: 5,
    })
    harness.gate.mark(14)
    assert.deepEqual(await harness.request({
      url: 'https://papers.example.org/',
      webContentsId: 14,
    }), { cancel: true })
  })
})

test('a popup inherits the restriction from its marked Research Browser opener', async () => {
  const harness = webRequestHarness({
    lookup: async () => [{ address: '100.64.1.2', family: 4 }],
  })
  harness.gate.mark(15)
  harness.gate.inherit(15, 16)

  assert.equal(harness.gate.isRestricted(16), true)
  assert.deepEqual(await harness.request({
    url: 'https://papers.example.org/redirected-resource',
    webContentsId: 16,
    resourceType: 'subFrame',
  }), { cancel: true })

  assert.equal(harness.gate.isRestricted(17), false)
  assert.deepEqual(await harness.request({
    url: 'http://100.64.1.2/',
    webContentsId: 17,
    resourceType: 'mainFrame',
  }), { cancel: false })
})

test('ordinary Browser tabs continue to allow localhost', async () => {
  const harness = webRequestHarness({
    lookup: async () => { throw new Error('unmarked tabs must not perform policy DNS') },
  })

  assert.deepEqual(await harness.request({
    url: 'http://localhost:5173/',
    webContentsId: 18,
    resourceType: 'mainFrame',
  }), { cancel: false })
})

test('Research mode fails closed when Electron cannot attribute a request to a tab', async () => {
  const harness = webRequestHarness()
  harness.gate.setResearchMode(true)
  assert.deepEqual(await harness.request({ url: 'file:///C:/Windows/win.ini' }), { cancel: true })
  assert.deepEqual(await harness.request({ url: 'https://papers.example.org/' }), { cancel: true })

  harness.gate.setResearchMode(false)
  assert.deepEqual(await harness.request({ url: 'https://papers.example.org/' }), { cancel: false })
})

test('Research mode cannot focus a tab that was not explicitly restricted', () => {
  assert.equal(canActivateTabInResearchMode(true, false), false)
  assert.equal(canActivateTabInResearchMode(true, true), true)
  assert.equal(canActivateTabInResearchMode(false, false), true)
})

test('Research tabs disable non-proxied WebRTC UDP and fail closed if unsupported', () => {
  let selectedPolicy = ''
  applyResearchWebRTCPolicy({
    setWebRTCIPHandlingPolicy(policy) { selectedPolicy = policy },
  })
  assert.equal(selectedPolicy, 'disable_non_proxied_udp')
  assert.throws(() => applyResearchWebRTCPolicy({}), /WebRTC policy is unavailable/u)
})

test('Research Browser projections redact signed URLs without changing operational URLs', () => {
  const rawURL = 'https://user:password@papers.example.org/file?X-Amz-Credential=aws-id&X-Amz-Signature=aws-signature&X-Goog-Signature=google-signature&sig=azure-signature&keep=visible#fragment-secret'
  const displayURL = redactResearchURL(rawURL)
  assert.doesNotMatch(displayURL, /user|password|aws-id|aws-signature|google-signature|azure-signature|fragment-secret/u)
  assert.match(displayURL, /keep=visible/u)
  assert.match(displayURL, /X-Amz-Signature=%5BREDACTED%5D/u)
  assert.doesNotMatch(redactResearchDisplayText(`Source ${rawURL}.`), /aws-signature|google-signature|azure-signature/u)
})

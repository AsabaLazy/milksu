'use strict'

const { lookup: lookupDNS } = require('node:dns/promises')
const http = require('node:http')
const net = require('node:net')
const { BlockList, isIP } = net

const RESEARCH_DNS_TIMEOUT_MS = 3_000
const RESEARCH_REQUEST_FILTER = { urls: ['<all_urls>'] }
const LOCAL_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.lan',
  '.home.arpa',
  '.intranet',
]

function blockListForRanges(ranges, family) {
  const blockList = new BlockList()
  for (const [address, prefixLength] of ranges) {
    blockList.addSubnet(address, prefixLength, family)
  }
  return blockList
}

const IPV4_NON_PUBLIC = blockListForRanges([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
], 'ipv4')

const IPV6_GLOBAL_UNICAST = blockListForRanges([['2000::', 3]], 'ipv6')
const IPV6_NON_PUBLIC = blockListForRanges([
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
], 'ipv6')

function isPublicIPAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false
  const family = isIP(address)
  if (family === 4) return !IPV4_NON_PUBLIC.check(address, 'ipv4')
  if (family === 6) {
    return IPV6_GLOBAL_UNICAST.check(address, 'ipv6')
      && !IPV6_NON_PUBLIC.check(address, 'ipv6')
  }
  return false
}

function isSensitiveResearchQueryName(value) {
  let name = String(value ?? '').trim().toLowerCase()
  try {
    name = decodeURIComponent(name.replaceAll('+', ' '))
  } catch {}
  const normalized = name.replace(/[^a-z0-9]/g, '')
  return normalized === 'key'
    || normalized === 'sig'
    || normalized.includes('apikey')
    || normalized.includes('accesskey')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('passwd')
    || normalized.includes('auth')
    || normalized.includes('credential')
    || normalized.includes('signature')
}

function redactResearchURL(rawURL) {
  try {
    const url = new URL(String(rawURL))
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of new Set(url.searchParams.keys())) {
      if (isSensitiveResearchQueryName(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.toString()
  } catch {
    return '[invalid URL]'
  }
}

function redactResearchDisplayText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s<>"']+/gi, candidate => {
    let end = candidate.length
    while (end > 0 && '.,;:!?)]}'.includes(candidate[end - 1])) end -= 1
    return `${redactResearchURL(candidate.slice(0, end))}${candidate.slice(end)}`
  })
}

function isLocalHostname(hostname) {
  return hostname === 'localhost'
    || hostname === 'home.arpa'
    || (!hostname.includes('.') && isIP(hostname) === 0)
    || LOCAL_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
}

function normalizeResearchHostname(hostname) {
  let value = String(hostname ?? '').toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1)
  }
  value = value.replace(/\.$/u, '')
  if (!value || value.includes('%') || isLocalHostname(value)) return null
  return value
}

function hostnameFromURL(rawURL) {
  let url
  try {
    url = new URL(String(rawURL))
  } catch {
    return null
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null
  return normalizeResearchHostname(url.hostname)
}

async function lookupWithTimeout(hostname, lookup, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('research Browser DNS lookup timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function isAllowedResearchRequest(rawURL, {
  lookup = lookupDNS,
  timeoutMs = RESEARCH_DNS_TIMEOUT_MS,
} = {}) {
  const hostname = hostnameFromURL(rawURL)
  if (!hostname) return false
  return (await resolvePublicResearchAddresses(hostname, { lookup, timeoutMs })) !== null
}

async function resolvePublicResearchAddresses(rawHostname, {
  lookup = lookupDNS,
  timeoutMs = RESEARCH_DNS_TIMEOUT_MS,
} = {}) {
  const hostname = normalizeResearchHostname(rawHostname)
  if (!hostname) return null
  if (isIP(hostname)) {
    return isPublicIPAddress(hostname) ? [hostname] : null
  }
  if (/^(?:[0-9.]+|0x[0-9a-f]+)$/iu.test(hostname)) return null

  try {
    const addresses = await lookupWithTimeout(hostname, lookup, timeoutMs)
    if (!Array.isArray(addresses) || addresses.length === 0) return null
    const resolved = addresses.map(result => (
      typeof result === 'string' ? result : result?.address
    ))
    return resolved.every(isPublicIPAddress) ? resolved : null
  } catch {
    return null
  }
}

function normalizeWebContentsID(value) {
  const id = typeof value === 'object' && value !== null ? value.id : value
  return Number.isSafeInteger(id) && id >= 0 ? id : null
}

function canActivateTabInResearchMode(researchMode, isResearchTab) {
  return researchMode !== true || isResearchTab === true
}

function applyResearchWebRTCPolicy(webContents) {
  if (typeof webContents?.setWebRTCIPHandlingPolicy !== 'function') {
    throw new Error('Research Browser WebRTC policy is unavailable')
  }
  webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
}

function createResearchBrowserNetworkGate(browserSession, options = {}) {
  if (typeof browserSession?.webRequest?.onBeforeRequest !== 'function') {
    throw new Error('Electron session webRequest is unavailable')
  }

  const restrictedWebContents = new Set()
  let researchMode = false
  const listener = (details, callback) => {
    let replied = false
    const reply = cancel => {
      if (replied) return
      replied = true
      callback({ cancel })
    }
    const webContentsID = normalizeWebContentsID(details?.webContentsId)
      ?? normalizeWebContentsID(details?.webContents)
    if (webContentsID === null) {
      reply(researchMode)
      return
    }
    if (!researchMode && !restrictedWebContents.has(webContentsID)) {
      reply(false)
      return
    }
    void isAllowedResearchRequest(details?.url, options)
      .then(allowed => reply(!allowed), () => reply(true))
  }

  browserSession.webRequest.onBeforeRequest(RESEARCH_REQUEST_FILTER, listener)

  return {
    setResearchMode(enabled) {
      researchMode = enabled === true
    },
    isResearchMode() {
      return researchMode
    },
    mark(webContents) {
      const id = normalizeWebContentsID(webContents)
      if (id === null) throw new Error('invalid Research Browser WebContents')
      restrictedWebContents.add(id)
    },
    unmark(webContents) {
      const id = normalizeWebContentsID(webContents)
      if (id !== null) restrictedWebContents.delete(id)
    },
    inherit(opener, popup) {
      const openerID = normalizeWebContentsID(opener)
      if (openerID !== null && restrictedWebContents.has(openerID)) this.mark(popup)
    },
    isRestricted(webContents) {
      const id = normalizeWebContentsID(webContents)
      return id !== null && restrictedWebContents.has(id)
    },
  }
}

const RESEARCH_PROXY_BYPASS_RULES = '<-loopback>'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const PROXY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function canonicalProxyHostname(value) {
  let hostname = String(value ?? '').toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1)
  }
  return hostname.replace(/\.$/u, '')
}

function parseProxyAuthority(value, defaultPort = null) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\s\\/?#@%]/u.test(value)) {
    return null
  }

  let rawHostname
  let rawPort = ''
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    if (closingBracket < 0) return null
    rawHostname = value.slice(1, closingBracket)
    const suffix = value.slice(closingBracket + 1)
    if (suffix && !suffix.startsWith(':')) return null
    if (suffix) rawPort = suffix.slice(1)
    if (net.isIP(rawHostname) !== 6) return null
  } else {
    const colon = value.lastIndexOf(':')
    if (colon >= 0) {
      if (value.indexOf(':') !== colon) return null
      rawHostname = value.slice(0, colon)
      rawPort = value.slice(colon + 1)
    } else {
      rawHostname = value
    }
    if (!rawHostname || rawHostname.includes('[') || rawHostname.includes(']')) return null
    try {
      const parsed = new URL(`http://${rawHostname}/`)
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        return null
      }
      rawHostname = parsed.hostname
    } catch {
      return null
    }
  }

  let port = defaultPort
  if (rawPort) {
    if (!/^\d+$/u.test(rawPort)) return null
    port = Number(rawPort)
  } else if (value.endsWith(':') || defaultPort === null) {
    return null
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  const hostname = canonicalProxyHostname(rawHostname)
  return hostname ? { hostname, port } : null
}

function sameProxyAuthority(left, right) {
  return left.hostname === right.hostname && left.port === right.port
}

function parseHTTPProxyTarget(rawURL, hostHeader) {
  if (
    typeof rawURL !== 'string'
    || !/^(?:http|ws):\/\//iu.test(rawURL)
    || rawURL.includes('#')
    || rawURL.includes('\\')
  ) {
    return null
  }
  const match = /^(?:http|ws):\/\/([^/?#]+)(.*)$/iu.exec(rawURL)
  if (!match || match[1].includes('@')) return null

  let url
  try {
    url = new URL(rawURL)
  } catch {
    return null
  }
  if (
    !['http:', 'ws:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) {
    return null
  }
  const target = parseProxyAuthority(match[1], 80)
  const host = parseProxyAuthority(hostHeader, 80)
  if (!target || !host || !sameProxyAuthority(target, host)) return null

  const parsedURLAuthority = {
    hostname: canonicalProxyHostname(url.hostname),
    port: url.port ? Number(url.port) : 80,
  }
  if (!sameProxyAuthority(target, parsedURLAuthority)) return null
  return {
    ...target,
    path: `${url.pathname}${url.search}` || '/',
  }
}

function parseConnectTarget(authority, hostHeader) {
  const target = parseProxyAuthority(authority)
  const host = parseProxyAuthority(hostHeader)
  if (!target || !host || !sameProxyAuthority(target, host)) return null
  return target
}

function connectionTokens(headers) {
  const value = headers.connection
  const values = Array.isArray(value) ? value : [value]
  return new Set(values.flatMap(item => String(item ?? '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean)))
}

function shouldDropProxyHeader(name, tokens, allowWebSocketUpgrade) {
  const lowerName = name.toLowerCase()
  if (lowerName.startsWith('proxy-')) return true
  if (allowWebSocketUpgrade && (lowerName === 'connection' || lowerName === 'upgrade')) return false
  return PROXY_HOP_HEADERS.has(lowerName) || tokens.has(lowerName)
}

function forwardedHeaders(headers) {
  const tokens = connectionTokens(headers)
  const forwarded = {}
  for (const [name, value] of Object.entries(headers)) {
    if (shouldDropProxyHeader(name, tokens, false)) continue
    forwarded[name] = value
  }
  return forwarded
}

function forwardedWebSocketHeaderLines(request) {
  const tokens = connectionTokens(request.headers)
  const lines = []
  const rawHeaders = request.rawHeaders ?? []
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    if (name.toLowerCase() === 'connection') continue
    if (shouldDropProxyHeader(name, tokens, true)) continue
    lines.push(`${name}: ${rawHeaders[index + 1]}`)
  }
  lines.push('Connection: Upgrade')
  return lines
}

function writeProxySocketError(socket, status, reason) {
  if (!socket || socket.destroyed || !socket.writable) return
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
}

function sendProxyResponseError(response, status) {
  if (!response || response.destroyed || response.headersSent) return
  response.writeHead(status, {
    connection: 'close',
    'content-length': '0',
  })
  response.end()
}

class ResearchEgressProxy {
  constructor(options = {}) {
    this.lookup = options.lookup
    this.timeoutMs = options.timeoutMs
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.connect = options.connect ?? net.connect
    this.server = null
    this.startPromise = null
    this.closePromise = null
    this.port = 0
    this.closing = false
    this.sockets = new Set()
  }

  get url() {
    if (!this.port) throw new Error('Research egress proxy is not listening')
    return `http://127.0.0.1:${this.port}`
  }

  start() {
    if (this.closing) return Promise.reject(new Error('Research egress proxy is closed'))
    if (this.startPromise) return this.startPromise

    const server = http.createServer((request, response) => {
      void this.handleHTTP(request, response).catch(() => sendProxyResponseError(response, 502))
    })
    server.on('connection', socket => this.trackSocket(socket))
    server.on('connect', (request, socket, head) => {
      void this.handleConnect(request, socket, head)
        .catch(() => writeProxySocketError(socket, 502, 'Bad Gateway'))
    })
    server.on('upgrade', (request, socket, head) => {
      void this.handleWebSocketUpgrade(request, socket, head)
        .catch(() => writeProxySocketError(socket, 502, 'Bad Gateway'))
    })
    server.on('clientError', (_error, socket) => {
      writeProxySocketError(socket, 400, 'Bad Request')
    })
    this.server = server

    this.startPromise = new Promise((resolve, reject) => {
      const onError = error => {
        if (!this.port) reject(error)
        else void this.close()
      }
      server.on('error', onError)
      server.once('listening', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Research egress proxy did not bind a TCP port'))
          return
        }
        this.port = address.port
        resolve(this.url)
      })
      server.listen(0, '127.0.0.1')
    })
    return this.startPromise
  }

  trackSocket(socket) {
    if (!socket || typeof socket.on !== 'function' || typeof socket.destroy !== 'function') {
      throw new Error('Research egress connector did not return a socket')
    }
    if (!socket.destroyed) {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    }
    if (this.closing) socket.destroy()
    return socket
  }

  connectPinned(address, port, callback) {
    if (this.closing) throw new Error('Research egress proxy is closed')
    const family = net.isIP(address)
    if (!family) throw new Error('Research egress proxy selected an invalid IP address')
    const socket = this.trackSocket(this.connect({ host: address, port, family }, callback))
    if (this.connectTimeoutMs > 0 && socket.connecting) {
      const timer = setTimeout(() => {
        socket.destroy(new Error('Research egress connection timed out'))
      }, this.connectTimeoutMs)
      timer.unref?.()
      socket.once('connect', () => clearTimeout(timer))
      socket.once('close', () => clearTimeout(timer))
    }
    return socket
  }

  async resolve(hostname) {
    return resolvePublicResearchAddresses(hostname, {
      lookup: this.lookup,
      timeoutMs: this.timeoutMs,
    })
  }

  async handleHTTP(request, response) {
    const target = parseHTTPProxyTarget(request.url, request.headers.host)
    if (!target || connectionTokens(request.headers).has('host')) {
      sendProxyResponseError(response, 400)
      return
    }

    const addresses = await this.resolve(target.hostname)
    if (!addresses) {
      sendProxyResponseError(response, 403)
      return
    }
    if (this.closing || request.destroyed || response.destroyed) return

    const address = addresses[0]
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
    agent.createConnection = (_options, callback) => this.connectPinned(
      address,
      target.port,
      callback,
    )
    let upstream
    try {
      upstream = http.request({
        hostname: address,
        family: net.isIP(address),
        port: target.port,
        method: request.method,
        path: target.path,
        headers: forwardedHeaders(request.headers),
        setHost: false,
        agent,
      })
    } catch {
      agent.destroy()
      sendProxyResponseError(response, 502)
      return
    }

    request.once('aborted', () => upstream.destroy())
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy()
    })
    upstream.once('response', upstreamResponse => {
      if (response.destroyed) {
        upstreamResponse.destroy()
        agent.destroy()
        return
      }
      const headers = forwardedHeaders(upstreamResponse.headers)
      if (upstreamResponse.statusMessage) {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          headers,
        )
      } else {
        response.writeHead(upstreamResponse.statusCode || 502, headers)
      }
      upstreamResponse.once('error', () => response.destroy())
      upstreamResponse.pipe(response)
      upstreamResponse.once('end', () => agent.destroy())
    })
    upstream.once('error', () => {
      agent.destroy()
      sendProxyResponseError(response, 502)
    })
    request.pipe(upstream)
  }

  async handleConnect(request, socket, head) {
    const target = parseConnectTarget(request.url, request.headers.host)
    if (!target) {
      writeProxySocketError(socket, 400, 'Bad Request')
      return
    }

    const addresses = await this.resolve(target.hostname)
    if (!addresses) {
      writeProxySocketError(socket, 403, 'Forbidden')
      return
    }
    if (this.closing || socket.destroyed) return

    let upstream
    let connected = false
    try {
      upstream = this.connectPinned(addresses[0], target.port)
    } catch {
      writeProxySocketError(socket, 502, 'Bad Gateway')
      return
    }
    socket.once('close', () => upstream.destroy())
    upstream.once('error', () => {
      if (!connected) writeProxySocketError(socket, 502, 'Bad Gateway')
      else socket.destroy()
    })
    const onConnect = () => {
      connected = true
      if (this.closing || socket.destroyed) {
        upstream.destroy()
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    }
    if (upstream.connecting) upstream.once('connect', onConnect)
    else queueMicrotask(onConnect)
  }

  async handleWebSocketUpgrade(request, socket, head) {
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
    const target = parseHTTPProxyTarget(request.url, request.headers.host)
    if (
      request.method !== 'GET'
      || request.httpVersion !== '1.1'
      || upgrade !== 'websocket'
      || !connectionTokens(request.headers).has('upgrade')
      || connectionTokens(request.headers).has('host')
      || !target
    ) {
      writeProxySocketError(socket, 400, 'Bad Request')
      return
    }

    const addresses = await this.resolve(target.hostname)
    if (!addresses) {
      writeProxySocketError(socket, 403, 'Forbidden')
      return
    }
    if (this.closing || socket.destroyed) return

    let upstream
    let connected = false
    try {
      upstream = this.connectPinned(addresses[0], target.port)
    } catch {
      writeProxySocketError(socket, 502, 'Bad Gateway')
      return
    }
    socket.once('close', () => upstream.destroy())
    upstream.once('error', () => {
      if (!connected) writeProxySocketError(socket, 502, 'Bad Gateway')
      else socket.destroy()
    })
    const onConnect = () => {
      connected = true
      if (this.closing || socket.destroyed) {
        upstream.destroy()
        return
      }
      const headers = forwardedWebSocketHeaderLines(request).join('\r\n')
      upstream.write(`${request.method} ${target.path} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    }
    if (upstream.connecting) upstream.once('connect', onConnect)
    else queueMicrotask(onConnect)
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      if (this.startPromise) {
        try {
          await this.startPromise
        } catch {
          // A failed listen has no local port to keep open.
        }
      }
      const server = this.server
      if (!server) return
      const sockets = [...this.sockets]
      const socketsClosed = Promise.all(sockets.map(socket => new Promise(resolve => {
        if (socket.closed) resolve()
        else socket.once('close', resolve)
      })))
      const closed = new Promise(resolve => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
      for (const socket of sockets) socket.destroy()
      await Promise.all([closed, socketsClosed])
      this.server = null
      this.port = 0
    })()
    return this.closePromise
  }
}

module.exports = {
  createResearchBrowserNetworkGate,
  canActivateTabInResearchMode,
  applyResearchWebRTCPolicy,
  redactResearchURL,
  redactResearchDisplayText,
  isAllowedResearchRequest,
  isPublicIPAddress,
  resolvePublicResearchAddresses,
  ResearchEgressProxy,
  RESEARCH_PROXY_BYPASS_RULES,
}

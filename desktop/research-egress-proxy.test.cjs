'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const test = require('node:test')

const { ResearchEgressProxy } = require('./research-browser-network-policy.cjs')

function trackConnections(server) {
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return sockets
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function closeServer(server, sockets) {
  if (!server.listening) return
  const closed = new Promise(resolve => server.close(resolve))
  for (const socket of sockets) socket.destroy()
  await closed
}

async function startProxy(t, options) {
  const proxy = new ResearchEgressProxy(options)
  await proxy.start()
  t.after(() => proxy.close())
  return proxy
}

function requestThroughProxy(port, { url, host, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: url,
      headers: { Host: host, ...headers },
      agent: false,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

function readSocketUntil(socket, predicate) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    const timer = setTimeout(() => finish(new Error('socket response timed out')), 5_000)
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (error) reject(error)
      else resolve(value)
    }
    const onData = chunk => {
      data = Buffer.concat([data, chunk])
      if (predicate(data)) finish(null, data)
    }
    const onError = error => finish(error)
    const onClose = () => finish(new Error('socket closed before response completed'))
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function u16(value) {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}

function u24(value) {
  return Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function clientHelloWithServerName(hostname) {
  const name = Buffer.from(hostname)
  const serverName = Buffer.concat([u16(name.length + 3), Buffer.from([0]), u16(name.length), name])
  const extensions = Buffer.concat([
    u16(0),
    u16(serverName.length),
    serverName,
  ])
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ])
  const handshake = Buffer.concat([Buffer.from([1]), u24(body.length), body])
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(handshake.length), handshake])
}

test('HTTP absolute-form requests connect to a validated numeric IP and drop proxy credentials', async t => {
  let received
  const origin = http.createServer((request, response) => {
    received = {
      url: request.url,
      host: request.headers.host,
      proxyAuthorization: request.headers['proxy-authorization'],
      proxyConnection: request.headers['proxy-connection'],
    }
    response.writeHead(200, { 'proxy-authenticate': 'Basic realm=upstream' })
    response.end('pinned response')
  })
  const originSockets = trackConnections(origin)
  await listen(origin)
  t.after(() => closeServer(origin, originSockets))

  const lookups = []
  const connects = []
  const proxy = await startProxy(t, {
    lookup: async (hostname, options) => {
      lookups.push({ hostname, options })
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ]
    },
    connect: (options, callback) => {
      connects.push(options)
      return net.connect({
        host: '127.0.0.1',
        port: origin.address().port,
        family: 4,
      }, callback)
    },
  })
  const target = `http://papers.example.test:${origin.address().port}/article?q=1`
  const result = await requestThroughProxy(new URL(proxy.url).port, {
    url: target,
    host: `papers.example.test:${origin.address().port}`,
    headers: {
      'Proxy-Authorization': 'Basic should-not-reach-origin',
      'Proxy-Connection': 'keep-alive',
    },
  })

  assert.equal(result.status, 200)
  assert.equal(result.body, 'pinned response')
  assert.equal(result.headers['proxy-authenticate'], undefined)
  assert.deepEqual(received, {
    url: '/article?q=1',
    host: `papers.example.test:${origin.address().port}`,
    proxyAuthorization: undefined,
    proxyConnection: undefined,
  })
  assert.deepEqual(lookups, [{
    hostname: 'papers.example.test',
    options: { all: true, verbatim: true },
  }])
  assert.deepEqual(connects, [{
    host: '93.184.216.34',
    port: origin.address().port,
    family: 4,
  }])
})

test('HTTP proxy rejects malformed targets, credentials, loopback literals/hosts, and mixed DNS answers', async t => {
  let lookupCount = 0
  let connectCount = 0
  const proxy = await startProxy(t, {
    lookup: async () => {
      lookupCount += 1
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]
    },
    connect: () => {
      connectCount += 1
      throw new Error('blocked requests must not connect')
    },
  })
  const port = Number(new URL(proxy.url).port)
  const hostname = `papers.example.test:${port}`

  const mismatch = await requestThroughProxy(port, {
    url: `http://papers.example.test:${port}/`,
    host: `other.example.test:${port}`,
  })
  const credentials = await requestThroughProxy(port, {
    url: `http://user:secret@papers.example.test:${port}/`,
    host: hostname,
  })
  const privateLiteral = await requestThroughProxy(port, {
    url: 'http://127.0.0.1:8080/admin',
    host: '127.0.0.1:8080',
  })
  const localhost = await requestThroughProxy(port, {
    url: 'http://localhost:8080/admin',
    host: 'localhost:8080',
  })
  const mixedDNS = await requestThroughProxy(port, {
    url: `http://${hostname}/private`,
    host: hostname,
  })

  assert.equal(mismatch.status, 400)
  assert.equal(credentials.status, 400)
  assert.equal(privateLiteral.status, 403)
  assert.equal(localhost.status, 403)
  assert.equal(mixedDNS.status, 403)
  assert.equal(lookupCount, 1, 'malformed targets and IP literals must not use DNS')
  assert.equal(connectCount, 0)
})

test('public IPv6 literals are pinned directly without a DNS lookup', async t => {
  const origin = http.createServer((_request, response) => response.end('ipv6 literal'))
  const originSockets = trackConnections(origin)
  await listen(origin)
  t.after(() => closeServer(origin, originSockets))

  const connects = []
  let lookupCount = 0
  const proxy = await startProxy(t, {
    lookup: async () => {
      lookupCount += 1
      throw new Error('IP literals must not use DNS')
    },
    connect: (options, callback) => {
      connects.push(options)
      return net.connect({
        host: '127.0.0.1',
        port: origin.address().port,
        family: 4,
      }, callback)
    },
  })
  const port = Number(new URL(proxy.url).port)
  const hostname = '[2606:4700:4700::1111]'
  const result = await requestThroughProxy(port, {
    url: `http://${hostname}:${origin.address().port}/`,
    host: `${hostname}:${origin.address().port}`,
  })

  assert.equal(result.status, 200)
  assert.equal(result.body, 'ipv6 literal')
  assert.equal(lookupCount, 0)
  assert.deepEqual(connects, [{
    host: '2606:4700:4700::1111',
    port: origin.address().port,
    family: 6,
  }])
})

test('HTTP proxy fails closed on DNS lookup errors and timeouts', async t => {
  await t.test('lookup failure', async subtest => {
    const proxy = await startProxy(subtest, {
      lookup: async () => { throw new Error('resolver unavailable') },
      connect: () => { throw new Error('must not connect') },
    })
    const port = Number(new URL(proxy.url).port)
    const result = await requestThroughProxy(port, {
      url: 'http://papers.example.test/resource',
      host: 'papers.example.test',
    })
    assert.equal(result.status, 403)
  })

  await t.test('lookup timeout', async subtest => {
    const proxy = await startProxy(subtest, {
      lookup: () => new Promise(() => {}),
      timeoutMs: 5,
      connect: () => { throw new Error('must not connect') },
    })
    const port = Number(new URL(proxy.url).port)
    const result = await requestThroughProxy(port, {
      url: 'http://papers.example.test/resource',
      host: 'papers.example.test',
    })
    assert.equal(result.status, 403)
  })
})

test('HTTPS CONNECT pins a numeric IP and preserves the tunneled TLS ClientHello SNI', async t => {
  const origin = net.createServer(socket => socket.pipe(socket))
  const originSockets = trackConnections(origin)
  await listen(origin)
  t.after(() => closeServer(origin, originSockets))

  const connects = []
  const proxy = await startProxy(t, {
    lookup: async hostname => {
      assert.equal(hostname, 'secure.example.test')
      return [{ address: '93.184.216.34', family: 4 }]
    },
    connect: (options, callback) => {
      connects.push(options)
      return net.connect({ host: '127.0.0.1', port: origin.address().port }, callback)
    },
  })
  const port = Number(new URL(proxy.url).port)
  const client = net.connect(port, '127.0.0.1')
  t.after(() => client.destroy())
  const hello = clientHelloWithServerName('secure.example.test')
  const response = readSocketUntil(client, data => {
    const headerEnd = data.indexOf('\r\n\r\n')
    return headerEnd >= 0 && data.length >= headerEnd + 4 + hello.length
  })
  client.once('connect', () => {
    client.write(Buffer.concat([
      Buffer.from(
        `CONNECT secure.example.test:${origin.address().port} HTTP/1.1\r\n`
        + `Host: secure.example.test:${origin.address().port}\r\n`
        + 'Proxy-Authorization: Basic do-not-forward\r\n\r\n',
      ),
      hello,
    ]))
  })
  const bytes = await response
  const headerEnd = bytes.indexOf('\r\n\r\n')
  assert.match(bytes.subarray(0, headerEnd).toString(), /^HTTP\/1\.1 200 Connection Established/u)
  assert.deepEqual(bytes.subarray(headerEnd + 4, headerEnd + 4 + hello.length), hello)
  assert.ok(hello.includes(Buffer.from('secure.example.test')))
  assert.deepEqual(connects, [{
    host: '93.184.216.34',
    port: origin.address().port,
    family: 4,
  }])
})

test('WebSocket upgrades use absolute-form validation, preserve Host, and omit proxy credentials', async t => {
  let received
  const origin = http.createServer()
  origin.on('upgrade', (request, socket) => {
    received = {
      url: request.url,
      host: request.headers.host,
      connection: request.headers.connection,
      upgrade: request.headers.upgrade,
      proxyAuthorization: request.headers['proxy-authorization'],
      proxyConnection: request.headers['proxy-connection'],
    }
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n\r\n',
    )
  })
  const originSockets = trackConnections(origin)
  await listen(origin)
  t.after(() => closeServer(origin, originSockets))

  const connects = []
  const proxy = await startProxy(t, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: (options, callback) => {
      connects.push(options)
      return net.connect({
        host: '127.0.0.1',
        port: origin.address().port,
      }, callback)
    },
  })
  const port = Number(new URL(proxy.url).port)
  const client = net.connect(port, '127.0.0.1')
  t.after(() => client.destroy())
  const response = readSocketUntil(client, data => data.includes(Buffer.from('\r\n\r\n')))
  client.once('connect', () => {
    client.write(
      `GET ws://chat.example.test:${origin.address().port}/socket?q=1 HTTP/1.1\r\n`
      + `Host: chat.example.test:${origin.address().port}\r\n`
      + 'Connection: keep-alive, Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + 'Sec-WebSocket-Version: 13\r\n'
      + 'Proxy-Authorization: Basic do-not-forward\r\n'
      + 'Proxy-Connection: keep-alive\r\n\r\n',
    )
  })
  const bytes = await response
  assert.match(bytes.toString(), /^HTTP\/1\.1 101 Switching Protocols/u)
  assert.deepEqual(received, {
    url: '/socket?q=1',
    host: `chat.example.test:${origin.address().port}`,
    connection: 'Upgrade',
    upgrade: 'websocket',
    proxyAuthorization: undefined,
    proxyConnection: undefined,
  })
  assert.deepEqual(connects, [{
    host: '93.184.216.34',
    port: origin.address().port,
    family: 4,
  }])
})

test('closing the egress proxy destroys active tunnels and closes its loopback listener', async t => {
  const origin = net.createServer(socket => socket.pipe(socket))
  const originSockets = trackConnections(origin)
  await listen(origin)
  t.after(() => closeServer(origin, originSockets))

  const proxy = await startProxy(t, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: (options, callback) => net.connect({
      host: '127.0.0.1',
      port: origin.address().port,
    }, callback),
  })
  const port = Number(new URL(proxy.url).port)
  const client = net.connect(port, '127.0.0.1')
  t.after(() => client.destroy())
  const established = readSocketUntil(client, data => data.includes(Buffer.from('\r\n\r\n')))
  client.once('connect', () => {
    client.write(
      `CONNECT close.example.test:${origin.address().port} HTTP/1.1\r\n`
      + `Host: close.example.test:${origin.address().port}\r\n\r\n`,
    )
  })
  await established

  await proxy.close()
  assert.equal(proxy.port, 0)
  await new Promise((resolve, reject) => {
    const probe = net.connect(port, '127.0.0.1')
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error('Research egress listener remained open'))
    })
    probe.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })
})

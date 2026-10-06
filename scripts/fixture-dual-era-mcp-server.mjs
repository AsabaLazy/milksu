#!/usr/bin/env node
// A dual-era MCP stdio server for the protocol-negotiation regression tests.
//
// It answers `server/discover` as a 2026-07-28-only modern server and also
// speaks the legacy `initialize` handshake, so a single fixture can show both
// directions of `versionNegotiation`:
//   - `mode: "auto"` connects through the modern revision,
//   - a client without `versionNegotiation` stays on the legacy handshake
//     even though this server also speaks 2026-07-28.
//
// Modern-era requests carry the 2026-07-28 per-request `_meta` envelope, so
// results for those requests are stamped with `resultType: "complete"` as the
// revision requires.
import { createInterface } from 'node:readline'

const modernProtocolVersion = '2026-07-28'
const legacyProtocolVersion = '2025-06-18'
const protocolVersionMetaKey = 'io.modelcontextprotocol/protocolVersion'
const serverInfoMetaKey = 'io.modelcontextprotocol/serverInfo'
const serverInfo = {
  name: 'milksu-dual-era-mcp-fixture',
  version: '1.0.0',
}
const fixtureTool = {
  name: 'negotiation_echo',
  title: 'Negotiation echo',
  description: 'Echo the era the call arrived on.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

function isModernRequest(params) {
  return params?._meta?.[protocolVersionMetaKey] !== undefined
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })}\n`)
}

function callResult(modern) {
  const text = JSON.stringify({
    source: 'dual-era-fixture',
    era: modern ? 'modern' : 'legacy',
  })
  return {
    ...(modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}),
    content: [{ type: 'text', text }],
  }
}

async function handle(message) {
  const { id, method, params } = message
  if (method === 'server/discover') {
    reply(id, {
      supportedVersions: [modernProtocolVersion],
      capabilities: { tools: {} },
      instructions:
        'Dual-era negotiation fixture: modern discovery plus the legacy handshake.',
      _meta: { [serverInfoMetaKey]: serverInfo },
    })
    return
  }
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? legacyProtocolVersion,
      capabilities: { tools: {} },
      serverInfo,
      instructions: 'Dual-era negotiation fixture, legacy handshake path.',
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') {
    reply(
      id,
      isModernRequest(params)
        ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
        : {},
    )
    return
  }
  if (method === 'tools/list') {
    reply(id, {
      ...(isModernRequest(params)
        ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
        : {}),
      tools: [fixtureTool],
    })
    return
  }
  if (method === 'tools/call') {
    if (params?.name !== 'negotiation_echo') {
      fail(id, -32602, `unknown fixture tool ${params?.name ?? '<missing>'}`)
      return
    }
    reply(id, callResult(isModernRequest(params)))
    return
  }
  fail(id, -32601, `unsupported method ${method}`)
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
})

for await (const line of lines) {
  if (!line.trim()) continue
  try {
    await handle(JSON.parse(line))
  } catch (error) {
    fail(null, -32000, error instanceof Error ? error.message : String(error))
  }
}

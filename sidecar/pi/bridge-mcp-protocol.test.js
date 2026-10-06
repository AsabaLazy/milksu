import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  loadCodingMcpConfig,
  loadSelectedMcpConfig,
  normalizeSelectedMcpServers,
} from "./bridge-mcp.js";
import { codingMcpOperationRequiresApproval } from "./bridge-auto-approval.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const usesSandboxExec = process.platform === "darwin";
const dualEraFixturePath = join(
  repositoryRoot,
  "scripts",
  "fixture-dual-era-mcp-server.mjs",
);
const legacyFixturePath = join(
  repositoryRoot,
  "scripts",
  "fixture-project-mcp-server.mjs",
);

function reviewedProjectConfig(mcpServers) {
  return JSON.stringify({ mcpServers });
}

function projectServer(overrides = {}) {
  return {
    command: "npx",
    args: ["-y", "negotiation-fixture"],
    includeTools: ["fixture_read"],
    milksu: {
      source: "npm:negotiation-fixture",
      version: "1.2.3",
      taskScope: "protocol negotiation regression",
    },
    ...overrides,
  };
}

async function withProjectWorkspace(configJson, run) {
  const workspace = await mkdtemp(join(tmpdir(), "milksu-mcp-protocol-"));
  await writeFile(join(workspace, ".mcp.json"), configJson);
  return run(workspace);
}

async function connectFixtureClient(fixturePath, clientOptions, cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    ...(cwd ? { cwd } : {}),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "milksu-negotiation-regression", version: "1.0.0" },
    clientOptions,
  );
  await client.connect(transport);
  return { client, transport };
}

async function callNegotiationEcho(client) {
  const result = await client.callTool({
    name: "negotiation_echo",
    arguments: {},
  });
  const text = result.content?.find(block => block.type === "text")?.text;
  return JSON.parse(text);
}

test("every server handed to createMcpAdapter carries protocolVersion auto", async () => {
  // pi-mcp-adapter 5.0.0 默认把没写 protocolVersion 的服务器按 "legacy"
  // 握手处理，2026-07-28 专用服务器连不上。adapterConfig 是所有服务器进
  // createMcpAdapter({ config }) 的唯一漏斗，在这里统一盖章 "auto"。
  await withProjectWorkspace(
    reviewedProjectConfig({
      pinned: projectServer({ protocolVersion: "2026-07-28" }),
      remote: { url: "https://example.test/mcp", protocolVersion: "legacy" },
    }),
    async workspace => {
      const raw = await readFile(join(workspace, ".mcp.json"), "utf8");
      const loaded = await loadSelectedMcpConfig(
        workspace,
        ["pinned"],
        createHash("sha256").update(raw).digest("hex"),
      );
      assert.equal(loaded.config.mcpServers.pinned.protocolVersion, "auto");

      const combined = await loadCodingMcpConfig(
        workspace,
        ["pinned"],
        createHash("sha256").update(raw).digest("hex"),
        undefined,
        undefined,
        undefined,
        [],
        {
          // 用户目录里的服务器也带一个旧值，证明同一漏斗盖掉它。
          "user-tools": {
            url: "https://user.example.test/mcp",
            protocolVersion: "legacy",
          },
        },
      );
      for (const definition of Object.values(combined.config.mcpServers)) {
        assert.equal(definition.protocolVersion, "auto");
      }
      assert.deepEqual(
        Object.keys(combined.config.mcpServers).sort(),
        ["pinned", "user-tools"],
      );
      // 5.0.0 程序化配置唯一还会合并的外部来源是 claudePlugins；MilkSU
      // 从不传它，所以这份配置不会从盘上带进任何服务器。
      assert.doesNotMatch(JSON.stringify(combined.config), /claudePlugins/);
    },
  );
});

test("adapter settings keep the 5.0.0 surface on one proxy tool and no QuickJS", async () => {
  await withProjectWorkspace(
    reviewedProjectConfig({ server: projectServer() }),
    async workspace => {
      const raw = await readFile(join(workspace, ".mcp.json"), "utf8");
      const loaded = await loadSelectedMcpConfig(
        workspace,
        ["server"],
        createHash("sha256").update(raw).digest("hex"),
      );
      const settings = loaded.config.settings;
      // 5.0.0 起每台服务器会默认再挂 mcp__<server> 命名空间代理工具；
      // 关掉它，保持全部调用走同一个 "mcp" 代理和审批边界。
      assert.equal(settings.namespaceProxyTools, false);
      // 5.0.0 可以打开基于 QuickJS 的 MCP 脚本工具；产品路径不开，
      // 沙箱仍由 bridge-mcp 的 sandbox-exec 包装承担。
      assert.equal(settings.scriptMode, false);
      assert.equal(settings.directTools, false);
      assert.equal(settings.disableProxyTool, false);
      // 不发现宿主机上的任何 mcp 配置文件。
      assert.equal(settings.hostConfigDiscovery, "off");
      assert.equal(settings.sampling, false);
      assert.equal(settings.samplingAutoApprove, false);
      assert.equal(settings.elicitation, false);
      assert.equal(settings.autoAuth, false);
    },
  );
});

test("sandbox wrapping, environment filtering, caps, and approval stay in the bridge", async () => {
  await withProjectWorkspace(
    reviewedProjectConfig({
      sandboxed: projectServer({
        env: { FIXTURE_MODE: "1" },
        includeTools: Array.from({ length: 64 }, (_, index) => `reviewed_${index}`),
      }),
      oversized: projectServer({
        includeTools: Array.from({ length: 65 }, (_, index) => `reviewed_${index}`),
      }),
    }),
    async workspace => {
      const raw = await readFile(join(workspace, ".mcp.json"), "utf8");
      const digest = createHash("sha256").update(raw).digest("hex");

      const loaded = await loadSelectedMcpConfig(workspace, ["sandboxed"], digest);
      const definition = loaded.config.mcpServers.sandboxed;
      if (usesSandboxExec) {
        assert.equal(definition.command, "/usr/bin/sandbox-exec");
        assert.ok(definition.args.includes("/usr/bin/env"));
        assert.deepEqual(definition.env, {});
        assert.ok(definition.args.some(value => value.startsWith("HOME=")));
      } else {
        assert.equal(definition.command, "npx");
        assert.equal(definition.env.FIXTURE_MODE, "1");
        assert.equal(definition.env.DEEPSEEK_API_KEY, undefined);
      }
      assert.equal(definition.lifecycle, "lazy");
      assert.equal(definition.includeTools.length, 64);

      // 每任务 16 台服务器、每台 64 个已评审工具的上限保持不变。
      assert.equal(normalizeSelectedMcpServers(
        Array.from({ length: 16 }, (_, index) => `server-${index}`),
      ).length, 16);
      assert.throws(
        () => normalizeSelectedMcpServers(
          Array.from({ length: 17 }, (_, index) => `server-${index}`),
        ),
        /at most 16 MCP servers/,
      );
      await assert.rejects(
        loadSelectedMcpConfig(workspace, ["oversized"], digest),
        /1-64 reviewed includeTools/,
      );

      // 逐次审批仍在桥上：普通项目服务器在 ask 和 read-only 档要审批，
      // workspace-auto 也不静默放行（保持桌面审批卡）。
      const call = { server: "sandboxed", tool: "reviewed_1", args: {} };
      assert.equal(codingMcpOperationRequiresApproval(call, "ask", "sandboxed"), true);
      assert.equal(codingMcpOperationRequiresApproval(call, "read-only", "sandboxed"), true);
      assert.equal(
        codingMcpOperationRequiresApproval(call, "workspace-auto", "sandboxed"),
        true,
      );
    },
  );
});

test("bridge.js feeds createMcpAdapter only the reviewed config object", async () => {
  const bridgeSource = await readFile(
    join(repositoryRoot, "sidecar", "pi", "bridge.js"),
    "utf8",
  );
  const mcpCalls = bridgeSource.match(/createMcpAdapter\(/g) ?? [];
  assert.equal(mcpCalls.length, 1);
  assert.match(bridgeSource, /createMcpAdapter\(\{ config: mcpConfig \}\)/);
  assert.doesNotMatch(bridgeSource, /createMcpAdapter\(\{[^}]*configPath/);

  const mcpConfigSource = await readFile(
    join(repositoryRoot, "sidecar", "pi", "bridge-mcp.js"),
    "utf8",
  );
  assert.match(mcpConfigSource, /mcpServers: withAutoProtocolVersion\(mcpServers\)/);
});

test("the reviewed adapter build keeps programmatic config off host mcp files", async () => {
  // 只对钉住的已评审版本做这份源码契约：版本一变，先停下来重新评审。
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, "node_modules", "pi-mcp-adapter", "package.json"),
    "utf8",
  ));
  assert.equal(manifest.version, "5.0.0");

  const adapterSource = await readFile(
    join(repositoryRoot, "node_modules", "pi-mcp-adapter", "index.ts"),
    "utf8",
  );
  // 程序化配置（createMcpAdapter({ config })）不走 loadMcpConfig，
  // ~/.pi/agent/mcp.json、项目 .pi/mcp.json、~/.config/mcp/mcp.json、
  // ~/.agents/mcp.json 只能从那里进来。
  assert.match(
    adapterSource,
    /const earlyConfigPath = programmaticConfig\s*\n\s+\? undefined/,
  );
  assert.match(
    adapterSource,
    /const earlyConfig = programmaticConfig\s*\n\s+\? resolveConfiguredClaudePluginMcp\(/,
  );

  // 服务器级 protocolVersion 的映射：不写和 "legacy" 都退回 undefined
  // （旧行为字节等价），"auto" 映射成 mode "auto"。
  const serverManagerSource = await readFile(
    join(repositoryRoot, "node_modules", "pi-mcp-adapter", "server-manager.ts"),
    "utf8",
  );
  assert.match(
    serverManagerSource,
    /case undefined:\s*\n\s+case "legacy":\s*\n\s+return undefined;\s*\n\s+case "auto":\s*\n\s+return \{ mode: "auto" \};/,
  );
});

test("omitted protocolVersion stays on the legacy handshake even for modern servers", async () => {
  const { client, transport } = await connectFixtureClient(
    dualEraFixturePath,
    {},
  );
  try {
    // 这台服务器同时会说 2026-07-28 和旧握手；不写 versionNegotiation
    // 时客户端必须走旧 initialize，钉住「不写则默认 legacy」。
    assert.equal(client.getDiscoverResult(), undefined);
    assert.equal(client.getServerVersion()?.name, "milksu-dual-era-mcp-fixture");
    const payload = await callNegotiationEcho(client);
    assert.equal(payload.era, "legacy");
  } finally {
    await client.close();
    await transport.close();
  }
});

test("protocolVersion auto connects to a 2026-07-28 server through discovery", async () => {
  const { client, transport } = await connectFixtureClient(
    dualEraFixturePath,
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    const discover = client.getDiscoverResult();
    assert.ok(discover, "auto must establish the modern era through server/discover");
    assert.deepEqual(discover.supportedVersions, ["2026-07-28"]);
    assert.equal(client.getServerVersion()?.name, "milksu-dual-era-mcp-fixture");
    const payload = await callNegotiationEcho(client);
    assert.equal(payload.era, "modern");
  } finally {
    await client.close();
    await transport.close();
  }
});

test("protocolVersion auto falls back to the legacy handshake for older servers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "milksu-mcp-legacy-fallback-"));
  const fixtureText = "MilkSU legacy fallback fixture\n";
  await writeFile(join(workspace, "fixture.txt"), fixtureText);
  const digest = createHash("sha256").update(fixtureText).digest("hex");
  const { client, transport } = await connectFixtureClient(
    legacyFixturePath,
    { versionNegotiation: { mode: "auto" } },
    workspace,
  );
  try {
    // 只懂旧握手的服务器对 server/discover 探测回 method not found，
    // auto 必须退回旧 initialize 并完成真实调用。
    assert.equal(client.getDiscoverResult(), undefined);
    assert.equal(client.getServerVersion()?.name, "milksu-project-mcp-fixture");
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ["fixture_read"]);
    const result = await client.callTool({
      name: "fixture_read",
      arguments: { expectedSha256: digest },
    });
    const parsed = JSON.parse(
      result.content?.find(block => block.type === "text")?.text,
    );
    assert.equal(parsed.source, "project-fixture");
    assert.equal(parsed.text, fixtureText);
  } finally {
    await client.close();
    await transport.close();
  }
});

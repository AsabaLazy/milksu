import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { skillResourceRoot, syncDshSkillCatalog } from "./skill-catalog.js";

test("syncs enabled product skills into DSH_HOME/skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "milksu-dsh-skills-"));
  const names = syncDshSkillCatalog({ dshHome: home });
  assert.ok(names.includes("product-design"));
  assert.ok(names.includes("release-milksu"));
  const body = await readFile(join(home, "skills", "product-design", "SKILL.md"), "utf8");
  assert.match(body, /name: product-design/);
  const hidden = await readFile(join(home, "skills", "release-milksu", "SKILL.md"), "utf8");
  assert.match(hidden, /disable-model-invocation: true/);
});

test("syncs the DSH-only web research skill and cleans the Pi-only deep-research link", async () => {
  const home = await mkdtemp(join(tmpdir(), "milksu-dsh-skills-"));
  // 旧版把 durable 的 deep-research 同步进了 DSH 目录（#163 时代）：残留链接必须被清掉。
  const stale = join(home, "skills", "deep-research");
  await mkdir(stale, { recursive: true, mode: 0o700 });
  await writeFile(join(stale, "SKILL.md"), "---\nname: deep-research\ndescription: stale.\n---\n", {
    mode: 0o600,
  });

  const names = syncDshSkillCatalog({ dshHome: home });

  assert.ok(names.includes("deep-research-web"), "the lightweight skill must reach the DSH catalog");
  assert.ok(!names.includes("deep-research"), "the Pi-only durable skill must not be synced");
  await assert.rejects(
    readFile(join(home, "skills", "deep-research", "SKILL.md")),
    /ENOENT/,
    "the stale deep-research link must be cleaned from an existing DSH home",
  );
  const body = await readFile(join(home, "skills", "deep-research-web", "SKILL.md"), "utf8");
  assert.match(body, /name: deep-research-web/);
});

test("drops disabled product skills from the DSH catalog root", async () => {
  const home = await mkdtemp(join(tmpdir(), "milksu-dsh-skills-"));
  syncDshSkillCatalog({ dshHome: home });
  const names = syncDshSkillCatalog({
    dshHome: home,
    disabledSkills: ["product-design"],
  });
  assert.equal(names.includes("product-design"), false);
  await assert.rejects(readFile(join(home, "skills", "product-design", "SKILL.md")), /ENOENT/);
});

test("publishes extra user skill directories that already have SKILL.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "milksu-dsh-skills-"));
  const extra = await mkdtemp(join(tmpdir(), "milksu-user-skill-"));
  const skillDir = join(extra, "user-note");
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: user-note\ndescription: Extra.\n---\n\nBody.\n", {
    mode: 0o600,
  });
  const names = syncDshSkillCatalog({
    dshHome: home,
    extraSkillPaths: [skillDir],
  });
  assert.ok(names.includes("user-note"));
  const body = await readFile(join(home, "skills", "user-note", "SKILL.md"), "utf8");
  assert.match(body, /name: user-note/);
  await rm(extra, { recursive: true, force: true });
});

test("skill resource root finds the packaged or checkout skills tree", () => {
  const root = skillResourceRoot();
  assert.ok(root);
});

test("relative DSH_HOME is ignored", () => {
  assert.deepEqual(syncDshSkillCatalog({ dshHome: "dsh-home" }), []);
});

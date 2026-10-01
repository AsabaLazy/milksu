import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  disabledSkillNames,
  dshOnlyCodingSkillNames,
  optionalCodingSkillNames,
  piOnlyCodingSkillNames,
  resolveCodingSkillPaths,
  reviewedCodingSkillNames,
} from "../pi/bridge-skills.js";

// The managed set covers every name the catalogs have ever published, so a skill
// that moved to another kernel (deep-research is Pi-only now) has its stale
// symlink cleaned from an existing DSH home.
const managedSkillNames = new Set([
  ...reviewedCodingSkillNames,
  ...optionalCodingSkillNames,
  ...piOnlyCodingSkillNames,
  ...dshOnlyCodingSkillNames,
]);

export function skillResourceRoot(here = dirname(fileURLToPath(import.meta.url))) {
  return existsSync(join(here, "skills")) ? here : resolve(here, "..", "..");
}

function replacePath(dest) {
  rmSync(dest, { recursive: true, force: true });
}

function publishSkill(src, dest) {
  try {
    const current = lstatSync(dest);
    if (current.isSymbolicLink() || current.isDirectory() || current.isFile()) {
      replacePath(dest);
    }
  } catch {
    // Dest does not exist yet.
  }
  try {
    symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
  } catch {
    cpSync(src, dest, { recursive: true });
  }
}

export function syncDshSkillCatalog({
  dshHome = process.env.DSH_HOME,
  disabledSkills = [],
  extraSkillPaths = [],
  resourceRoot = skillResourceRoot(),
} = {}) {
  const home = String(dshHome ?? "").trim();
  if (!home || !isAbsolute(home)) return [];
  const destRoot = join(home, "skills");
  mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  const enabled = [
    ...resolveCodingSkillPaths(
      resourceRoot,
      "",
      disabledSkills,
      extraSkillPaths,
    ),
    // DSH-only skills are appended the same way resolvePiCodingSkillPaths
    // appends the Pi-only ones: the shared base stays kernel-neutral.
    ...dshOnlyCodingSkillNames
      .filter(name => !disabledSkillNames(disabledSkills).has(name))
      .map(name => join(resourceRoot, "skills", name))
      .filter(path => existsSync(join(path, "SKILL.md"))),
  ];
  const enabledNames = new Set(enabled.map(path => basename(path)));
  for (const name of managedSkillNames) {
    if (enabledNames.has(name)) continue;
    replacePath(join(destRoot, name));
  }
  for (const src of enabled) {
    const name = basename(src);
    managedSkillNames.add(name);
    publishSkill(src, join(destRoot, name));
  }
  return [...enabledNames];
}

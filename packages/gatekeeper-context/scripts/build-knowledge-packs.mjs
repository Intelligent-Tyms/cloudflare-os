// Bundles a directory of knowledge packs (OKF bundles of markdown files) into a generated
// TypeScript module, so a deployment can seed them as public canonical collections with no
// network access when it first comes up (see src/knowledge-packs-install.ts).
//
// The directory defaults to this package's `knowledge-packs/` (typically absent upstream), and
// `KNOWLEDGE_PACKS_DIR` points somewhere else. Same fork contract as workshop-backend's
// FORMAT_BLUEPRINTS_DIR: this repo is often a submodule, so a fork keeps its packs in its own
// tree and points the build at them. Whatever directory is named *is* the deployment's pack set.
//
// Each subdirectory is one pack. Its root index.md must carry `pack: <dirname>` and a positive
// integer `pack_version` in frontmatter; the version is what makes "is this workspace's copy
// stale?" checkable later, so it is validated here where a typo fails the pack author's build.

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const explicitDir = process.env.KNOWLEDGE_PACKS_DIR;
const sourceDir = resolve(pkgRoot, explicitDir ?? "knowledge-packs");
const outFile = join(pkgRoot, "src", "generated", "knowledge-packs.ts");

// Text files a pack may contain. Binaries (originals in references/) are not bundled: seeded
// packs are templates, and originals only exist once an organization uploads its own.
const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "yaml", "yml", "csv"]);

// Bounds keep a mistyped pack from bloating the Worker bundle; generous for markdown templates.
const MAX_FILES_PER_PACK = 200;
const MAX_FILE_BYTES = 262_144;

async function listPackDirs() {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT" && !explicitDir) return null; // no default dir: ship no packs
    throw err;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();
}

async function readPackFiles(packDir) {
  let files = [];
  async function walk(dir) {
    for (let entry of (await readdir(dir, { withFileTypes: true })).toSorted(
        (a, b) => a.name.localeCompare(b.name))) {
      let full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      let ext = entry.name.split(".").at(-1)?.toLowerCase() ?? "";
      if (!TEXT_EXTENSIONS.has(ext)) {
        throw new Error(`${full}: unsupported file type (packs bundle text files only)`);
      }
      let size = (await stat(full)).size;
      if (size > MAX_FILE_BYTES) throw new Error(`${full}: ${size} bytes exceeds ${MAX_FILE_BYTES}`);
      files.push({
        path: relative(packDir, full).split(sep).join("/"),
        content: await readFile(full, "utf8"),
      });
    }
  }
  await walk(packDir);
  return files;
}

// The intro: the first plain paragraph of the index body (after frontmatter and headings).
function extractDescription(indexBody) {
  let content = indexBody.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "");
  for (let block of content.split(/\r?\n\s*\r?\n/)) {
    let text = block.trim();
    if (text && !text.startsWith("#") && !text.startsWith("*") && !text.startsWith("-")) {
      return text.replace(/\s+/g, " ");
    }
  }
  return "";
}

function parseIndexFrontmatter(packId, indexBody) {
  let match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(indexBody);
  if (!match) throw new Error(`${packId}/index.md: missing frontmatter`);
  let parsed = parseYaml(match[1]);
  if (parsed?.pack !== packId) {
    throw new Error(`${packId}/index.md: frontmatter pack ${JSON.stringify(parsed?.pack)} ` +
        `must equal the directory name`);
  }
  let version = parsed?.pack_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`${packId}/index.md: pack_version must be a positive integer`);
  }
  return { version };
}

let packDirs = await listPackDirs();
let packs = [];
if (packDirs === null) {
  console.warn(`No ${sourceDir} directory; the deployment will bundle no knowledge packs.`);
} else {
  if (packDirs.length === 0) {
    console.warn(`No pack directories in ${sourceDir}; the deployment will bundle no packs.`);
  }
  for (let packId of packDirs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(packId)) {
      throw new Error(`Pack directory ${packId} must be a lowercase [a-z0-9-] name.`);
    }
    let files = await readPackFiles(join(sourceDir, packId));
    if (files.length > MAX_FILES_PER_PACK) {
      throw new Error(`${packId}: ${files.length} files exceeds ${MAX_FILES_PER_PACK}`);
    }
    let index = files.find((file) => file.path === "index.md");
    if (!index) throw new Error(`${packId}: packs require a root index.md`);
    let { version } = parseIndexFrontmatter(packId, index.content);

    // Install order matters: index.md first, so its pack/pack_version frontmatter is present for
    // every subsequent regeneration to carry forward.
    files = [index, ...files.filter((file) => file !== index)];
    packs.push({
      id: packId,
      title: packId[0].toUpperCase() + packId.slice(1),
      description: extractDescription(index.content),
      version,
      files,
    });
  }
}

let generated = `// GENERATED by scripts/build-knowledge-packs.mjs -- do not edit.
//
// The deployment's bundled knowledge packs. Built from ${
    explicitDir ? "KNOWLEDGE_PACKS_DIR" : "knowledge-packs/"}.

// One bundled pack: the collection it seeds (title is the install identity) and its files, in
// install order (root index.md first).
export type BundledKnowledgePack = {
  id: string;
  title: string;
  description: string;
  // The pack's declared pack_version; part of the seed manifest, so bumping it re-runs the seed
  // pass (which only creates collections that don't exist yet).
  version: number;
  files: { path: string; content: string }[];
};

export const KNOWLEDGE_PACKS: BundledKnowledgePack[] = ${JSON.stringify(packs, null, 2)};
`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, generated);

console.log(`Bundled ${packs.length} knowledge pack(s) from ${sourceDir} -> ${outFile}`);

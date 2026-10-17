import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseBlueprintArchive, parseBlueprintKvRecord, sanitizeBlueprintOutput } from "../src/blueprint-archive.js";
import { deleteInstalledBlueprint, formatBlueprintsManifestVersion, installFormatBlueprints, RETIRED_BLUEPRINT_IDS } from "../src/format-blueprints.js";
import { FORMAT_BLUEPRINTS } from "../src/generated/format-blueprints.js";

async function readBlueprintFile(
  entry: (typeof FORMAT_BLUEPRINTS)[number],
  filename: string,
): Promise<string> {
  let archive = new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!;
  let {content} = await parseBlueprintArchive(archive);
  let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
  let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  return doc.getMap<Y.Text>().get(filename)?.toString() ?? "";
}

// Minimal in-memory stand-ins for the two bindings the installer writes to. They record what was
// written so the test can assert on the installed blueprint the way a reader would see it.
function makeEnv() {
  let kv = new Map<string, string>();
  let r2 = new Map<string, Uint8Array>();
  return {
    kv,
    r2,
    env: {
      BLUEPRINTS: {
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      BLUEPRINT_CONTENT: {
        // Deliberately strict: real R2 rejects a stream of unknown length, so accepting one here
        // would hide exactly the bug this stands in for.
        put: async (key: string, value: unknown) => {
          if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
            throw new TypeError(
                "Provided readable stream must have a known length " +
                "(request/response body or readable half of FixedLengthStream)");
          }
          r2.set(key, new Uint8Array(ArrayBuffer.isView(value)
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value));
        },
      },
    } as unknown as Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">,
  };
}

describe("bundled format blueprints", () => {
  it("installs every manifest entry as an ordinary blueprint", async () => {
    let {kv, r2, env} = makeEnv();

    let installed = await installFormatBlueprints(env);

    expect(installed).toHaveLength(FORMAT_BLUEPRINTS.length);
    for (let entry of FORMAT_BLUEPRINTS) {
      let raw = kv.get(entry.blueprintId);
      expect(raw, `${entry.blueprintId} metadata`).toBeDefined();

      let record = parseBlueprintKvRecord(raw!);
      // No owning user: these belong to the deployment, so the owner-anchored featured toggle
      // must not apply to them.
      expect(record.ownerId).toBeUndefined();
      // Presentation comes from the sidecar, not from whatever the archive was called in the
      // workspace it was exported from.
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      // The sidecar's declaration is written into the installed blueprint, so from here on the
      // blueprint declares its own format like any other.
      expect(record.metadata.output).toEqual(entry.output);
      // ...and it survives the same validation an uploaded archive's would.
      expect(sanitizeBlueprintOutput(record.metadata.output)).toEqual(entry.output);

      // Content lands where readBlueprintContent() looks for it.
      let content = r2.get(`${entry.blueprintId}/${record.metadata.version}`);
      expect(content, `${entry.blueprintId} content`).toBeDefined();
      expect(content!.byteLength).toBeGreaterThan(0);
    }
  });

  it("ships print layouts for every standard output format", async () => {
    for (let entry of FORMAT_BLUEPRINTS) {
      expect(await readBlueprintFile(entry, "client.js"), entry.blueprintId)
        .toContain("@media print");
    }
  });

  it("renders document HTML and PDF exports without the editor chrome", async () => {
    let entry = FORMAT_BLUEPRINTS.find(blueprint => blueprint.blueprintId === "format.document")!;
    let client = await readBlueprintFile(entry, "client.js");

    expect(client).toContain('["html", "pdf"].includes(globalThis.gadgetExportFormatId)');
    expect(client).toContain('document.documentElement.classList.add("document-export")');
    expect(client).toContain("app.replaceChildren(canvas)");
  });

  it("declares the intended export formats for every standard output format", async () => {
    let expectedFormats: Record<string, string[]> = {
      "format.document": [
        'id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown"',
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.slides": [
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.spreadsheet": [
        'const CSV_FORMAT_PREFIX = "csv:"',
        'mode: "server"',
        'contentType: "text/csv"',
      ],
    };

    for (let entry of FORMAT_BLUEPRINTS) {
      let serverCode = await readBlueprintFile(entry, "server.js");
      expect(serverCode, entry.blueprintId).toContain("export class ExportHandler");
      for (let declaration of expectedFormats[entry.blueprintId] ?? []) {
        expect(serverCode, `${entry.blueprintId}: ${declaration}`).toContain(declaration);
      }
    }
  });

  // Skipped when the deployment bundles nothing, which FORMAT_BLUEPRINTS_DIR makes a supported
  // configuration rather than a broken checkout.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when an entry's revision changes", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();
    expect(before).toContain(entry.blueprintId);

    let original = entry.revision;
    try {
      entry.revision = original + 1;
      expect(formatBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.revision = original;
    }
  });

  // Curated text is the input most likely to be edited -- it is the whole point of keeping it in a
  // text file -- and an edit that doesn't reach deployments which already installed would be
  // invisible: the build succeeds and the old wording stays put.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when curated presentation changes, with no revision bump", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();

    for (let mutate of [
      () => { entry.description += " Now with more detail."; },
      () => { entry.title += " (Beta)"; },
      () => { entry.output = {...entry.output, noun: "Document"}; },
    ]) {
      let restore = {...entry};
      try {
        mutate();
        expect(formatBlueprintsManifestVersion()).not.toBe(before);
        expect(entry.revision).toBe(restore.revision);
      } finally {
        Object.assign(entry, restore);
      }
    }

    expect(formatBlueprintsManifestVersion()).toBe(before);
  });
});

// KV and R2 stand-ins with the read, list and delete calls the withdrawal makes. `list` pages two
// keys at a time so the cursor loop is exercised; like R2's, the cursor marks a key, not an offset,
// so deleting a page before fetching the next skips nothing.
function makeStores(kvEntries: Record<string, string>, r2Keys: string[]) {
  let kv = new Map(Object.entries(kvEntries));
  let r2 = new Set(r2Keys);
  return {
    kv,
    r2,
    env: {
      BLUEPRINTS: {
        get: async (key: string) => kv.get(key) ?? null,
        delete: async (key: string) => { kv.delete(key); },
      },
      BLUEPRINT_CONTENT: {
        list: async ({prefix, cursor}: {prefix: string, cursor?: string}) => {
          let keys = [...r2].filter(key => key.startsWith(prefix) && (!cursor || key > cursor))
              .toSorted();
          let page = keys.slice(0, 2);
          let truncated = keys.length > 2;
          return {objects: page.map(key => ({key})), truncated, cursor: truncated ? page.at(-1) : undefined};
        },
        delete: async (keys: string[]) => { for (let key of keys) r2.delete(key); },
      },
    } as unknown as Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">,
  };
}

describe("retired blueprints", () => {
  it("never retires a blueprint the deployment still bundles", () => {
    for (let entry of FORMAT_BLUEPRINTS) {
      expect(RETIRED_BLUEPRINT_IDS).not.toContain(entry.blueprintId);
    }
  });

  it("deletes a deployment-installed blueprint's record and every content version", async () => {
    let {kv, r2, env} = makeStores(
        {"tyms.crm": JSON.stringify({metadata: {}}), "tyms.crmx": JSON.stringify({metadata: {}})},
        ["tyms.crm/1", "tyms.crm/2", "tyms.crm/3", "tyms.crmx/1"]);

    expect(await deleteInstalledBlueprint(env, "tyms.crm")).toBe(true);

    expect(kv.has("tyms.crm")).toBe(false);
    expect([...r2]).toEqual(["tyms.crmx/1"]);
    expect(kv.has("tyms.crmx")).toBe(true);
  });

  it("clears orphaned content when the record is already gone", async () => {
    let {r2, env} = makeStores({}, ["tyms.tasks/1"]);
    expect(await deleteInstalledBlueprint(env, "tyms.tasks")).toBe(true);
    expect(r2.size).toBe(0);
  });

  it("leaves a user-published blueprint alone", async () => {
    let {kv, r2, env} = makeStores(
        {"tyms.tasks": JSON.stringify({metadata: {}, ownerId: "abc"})}, ["tyms.tasks/1"]);
    expect(await deleteInstalledBlueprint(env, "tyms.tasks")).toBe(false);
    expect(kv.has("tyms.tasks")).toBe(true);
    expect(r2.has("tyms.tasks/1")).toBe(true);
  });
});

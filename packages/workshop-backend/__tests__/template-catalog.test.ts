import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseBlueprintArchive } from "../src/blueprint-archive.js";
import {
  buildTemplateArchive, catalogMetadata, parseCatalogPackage, parseCatalogTemplate,
} from "../src/template-catalog.js";

const manifest = {
  blueprintId: "tyms.crm",
  title: "CRM",
  description: "Track deals.",
  output: { id: "crm", noun: "CRM", plural: "CRMs", icon: "kanban" },
  author: { type: "user", name: "Tyms", id: "agent@tyms.ai" },
  revision: 2,
  created: "2026-08-17T00:00:00.000Z",
};

describe("template catalog parsing", () => {
  it("accepts a catalog row (id) and a package manifest (blueprintId) alike", () => {
    let row = parseCatalogTemplate({ ...manifest, blueprintId: undefined, id: "tyms.crm" });
    expect(row?.id).toBe("tyms.crm");
    expect(row?.revision).toBe(2);
    expect(row?.output).toEqual(manifest.output);
    expect(row?.created.toISOString()).toBe(manifest.created);
    expect(parseCatalogTemplate(manifest)?.id).toBe("tyms.crm");
  });

  it("drops rows that could not be installed", () => {
    expect(parseCatalogTemplate({ ...manifest, blueprintId: "bad id" })).toBeNull();
    expect(parseCatalogTemplate({ ...manifest, revision: 0 })).toBeNull();
    expect(parseCatalogTemplate({ ...manifest, title: " " })).toBeNull();
    expect(parseCatalogTemplate({ ...manifest, author: { name: "x" } })).toBeNull();
    expect(parseCatalogTemplate({ ...manifest, created: "soon" })).toBeNull();
    // An unusable output degrades to a generic app rather than refusing the template.
    expect(parseCatalogTemplate({ ...manifest, output: { id: "x" } })?.output).toBeUndefined();
  });

  it("validates a package's files against the shared bounds", () => {
    let files = { "server.js": "export default {}", "client.js": "render()", "README.md": "# hi" };
    expect(Object.keys(parseCatalogPackage({ manifest, files }).files)).toEqual(Object.keys(files));
    expect(() => parseCatalogPackage({ manifest, files: { "server.js": "x" } })).toThrow(/client\.js/);
    expect(() => parseCatalogPackage({ manifest, files: { ...files, "lib/util.js": "x" } })).toThrow(/invalid file/);
    expect(() => parseCatalogPackage({ manifest, files: { ...files, "big.js": "x".repeat(600 * 1024) } })).toThrow(/size/);
    expect(() => parseCatalogPackage({ manifest: { ...manifest, revision: "2" }, files })).toThrow(/manifest/);
    // A hostile filename is an ordinary key, never a prototype write.
    let hostile = parseCatalogPackage({ manifest, files: JSON.parse('{"server.js":"a","client.js":"b","__proto__":"x"}') });
    expect(Object.keys(hostile.files)).toContain("__proto__");
    expect(Object.getPrototypeOf(hostile.files)).toBeNull();
  });
});

describe("buildTemplateArchive", () => {
  it("packs files into an archive the ordinary reader decodes back to the same files", async () => {
    let entry = parseCatalogTemplate(manifest)!;
    let files = { "server.js": "export default { fetch() {} }", "client.js": "// ui", "README.md": "# CRM" };
    let archive = await buildTemplateArchive(catalogMetadata(entry), files);

    let { metadata, contentLength, content } = await parseBlueprintArchive(
        new Response(archive as BufferSource).body!);
    expect(metadata.title).toBe("CRM");
    expect(metadata.version).toBe(2);
    expect(metadata.output).toEqual(manifest.output);
    let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
    let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
    expect(contentLength).toBeGreaterThan(0);
    let doc = new Y.Doc();
    Y.applyUpdateV2(doc, update);
    let decoded: Record<string, string> = {};
    for (let [name, text] of doc.getMap<Y.Text>("")) decoded[name] = text.toString();
    expect(decoded).toEqual(files);
  });

  it("is deterministic for the same inputs", async () => {
    let entry = parseCatalogTemplate(manifest)!;
    let files = { "server.js": "a", "client.js": "b" };
    let a = await buildTemplateArchive(catalogMetadata(entry), files);
    let b = await buildTemplateArchive(catalogMetadata(entry), files);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

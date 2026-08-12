// Upload-as-import for binary documents in Drive.
//
// Drive's contract is that everything in it is agent-readable, so a .docx is a transport
// container, not an artifact: uploading one converts it to Markdown via the Workers AI
// toMarkdown() utility (free for these formats — the same call webFetch and the chat upload path
// use) and stores ONLY the Markdown, the way Notion or Google Docs import a Word file. One file,
// one format, nothing to diverge; byte-perfect file custody belongs to a real document store
// reached through connectors.
//
// Conversion requires the optional WORKERS_AI binding; deployments without it refuse the import.

import { Buffer } from "node:buffer";
import { isConvertibleDocumentContentType } from "./context-types.js";

// Which MIME types import: the toMarkdown()-convertible document set, declared in
// context-types.ts (browser-safe) as CONVERTIBLE_DOCUMENT_CONTENT_TYPES. Text types need no
// import (they store as themselves), images are excluded (conversion would invoke paid models;
// they store as images), and PDF is deliberately left out: agents read PDFs natively through
// most model providers, so PDFs also store as themselves.
export { isConvertibleDocumentContentType };

// Where an imported document lands: the same path with the source extension swapped for ".md"
// ("reports/q3.docx" → "reports/q3.md") — the import IS the document, so it takes the name.
export function importPathFor(path: string): string {
  let slash = path.lastIndexOf("/");
  let dot = path.lastIndexOf(".");
  return (dot > slash ? path.slice(0, dot) : path) + ".md";
}

// Convert an uploaded document body (base64) to Markdown. Throws when the conversion fails; the
// import then fails loudly rather than storing an agent-opaque blob.
export async function convertStoredDocumentToMarkdown(
  ai: Ai,
  name: string,
  base64Body: string,
  contentType: string,
): Promise<string> {
  let bytes = Buffer.from(base64Body, "base64");
  let result = await ai.toMarkdown(
    { name, blob: new Blob([bytes], { type: contentType }) },
    {
      conversionOptions: {
        // Never invoke paid per-image models; alt text is preserved.
        html: { images: { convert: false, convertOGImage: false } },
      },
    },
  );
  if (result.format === "error") {
    throw new Error(`Markdown conversion failed: ${result.error}`);
  }
  return result.data;
}

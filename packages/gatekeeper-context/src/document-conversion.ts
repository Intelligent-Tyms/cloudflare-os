// Markdown renditions for binary documents uploaded to Drive.
//
// A stored .docx is opaque to full-text search and to agents reading the collection, so uploads
// of convertible document types also store a sibling "<path>.md" rendition converted via the
// Workers AI toMarkdown() utility (free for these formats — the same call webFetch and the chat
// upload path use). The original bytes stay authoritative and byte-perfect for download; the
// rendition is derived, regenerated on every re-upload, and follows the original on move/delete.
//
// Conversion requires the optional WORKERS_AI binding; deployments without it simply store the
// original alone, exactly as before.

import { Buffer } from "node:buffer";

// MIME types worth a rendition: the binary document formats toMarkdown() converts for free.
// Text types don't need one (they are already searchable), images are excluded (conversion would
// invoke paid models), and PDF is deliberately left out for now: agents can read PDFs natively
// through most model providers, and its rendition value is lower than its conversion cost.
const CONVERTIBLE_DOCUMENT_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.ms-excel",                                                // .xls
  "application/vnd.ms-excel.sheet.macroenabled.12",                          // .xlsm
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",                   // .xlsb
  "application/vnd.oasis.opendocument.text",                                 // .odt
  "application/vnd.oasis.opendocument.spreadsheet",                          // .ods
  "application/vnd.apple.numbers",                                           // .numbers
]);

export function isConvertibleDocumentContentType(contentType: string): boolean {
  return CONVERTIBLE_DOCUMENT_CONTENT_TYPES.has(
    contentType.split(";", 1)[0].trim().toLowerCase());
}

// Where a document's Markdown rendition lives: a sibling file named after the original,
// extension included, so "report.docx" and "report.docx.md" sort together and the derivation
// is obvious in the file list.
export function renditionPathFor(path: string): string {
  return `${path}.md`;
}

// Convert a stored document body (base64, as Drive stores binary) to Markdown. Throws when the
// conversion fails; callers treat the rendition as best-effort.
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

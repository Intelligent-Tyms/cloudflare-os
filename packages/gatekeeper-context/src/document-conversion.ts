// Text extraction for binary documents stored in Knowledge.
//
// Knowledge is a context store: uploads are preserved byte-perfect, and edit means download → edit →
// re-upload. What makes a stored .docx useful to search and agents is a derived text extraction
// (ContextDocument.extractedText), generated at write time via the Workers AI toMarkdown()
// utility — free for these formats, the same call webFetch and the chat upload path use — and
// regenerated on every re-upload, so it can never diverge from the original. This is the Claude
// Projects / ChatGPT knowledge-files pattern: original as-is, internal extraction for reading.
//
// Which MIME types extract: the toMarkdown()-convertible document set, declared in
// context-types.ts (browser-safe) as CONVERTIBLE_DOCUMENT_CONTENT_TYPES. Text types need no
// extraction, images are excluded (conversion would invoke paid models), and PDF is left out:
// agents read PDFs natively through most model providers.
//
// Extraction requires the optional WORKERS_AI binding; deployments without it store originals
// with no extraction, exactly as before.

import { Buffer } from "node:buffer";
import { isConvertibleDocumentContentType } from "./context-types.js";

export { isConvertibleDocumentContentType };

// Convert a stored document body (base64) to Markdown. Throws when the conversion fails; the
// caller treats extraction as best-effort.
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

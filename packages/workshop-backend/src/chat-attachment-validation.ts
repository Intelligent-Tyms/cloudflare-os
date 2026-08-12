import { isTextLikeAttachmentMimeType } from "@gadgets/workshop-shared/api";
import type { AiModelConfig, AiModelProvider, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import { PDF_MIME_TYPE } from "./chat-attachment-pdf";

// Bounds attachment storage and the bytes replayed into model requests.
export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;

const IMAGE_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ["image/jpeg", [0xFF, 0xD8, 0xFF]],
  ["image/png", [0x89, 0x50, 0x4E, 0x47]],
  ["image/webp", [
    0x52, 0x49, 0x46, 0x46,
    null, null, null, null,
    0x57, 0x45, 0x42, 0x50,
  ]],
]);

// OOXML / OpenDocument / Numbers containers are ZIP archives ("PK\x03\x04").
const ZIP_SIGNATURE: readonly (number | null)[] = [0x50, 0x4B, 0x03, 0x04];

// Document types that upload converts to Markdown at the door (see uploadChatAttachment):
// no model ever sees these bytes, so — unlike PDFs — they are provider-independent. Matches the
// non-image, non-text portion of webFetch's toMarkdown allow-list.
const CONVERTIBLE_DOCUMENT_MIME_TYPES = new Map<string, readonly (number | null)[]>([
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ZIP_SIGNATURE], // .docx
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ZIP_SIGNATURE],       // .xlsx
  ["application/vnd.ms-excel.sheet.macroenabled.12", ZIP_SIGNATURE],                          // .xlsm
  ["application/vnd.ms-excel.sheet.binary.macroenabled.12", ZIP_SIGNATURE],                   // .xlsb
  ["application/vnd.oasis.opendocument.text", ZIP_SIGNATURE],                                 // .odt
  ["application/vnd.oasis.opendocument.spreadsheet", ZIP_SIGNATURE],                          // .ods
  ["application/vnd.apple.numbers", ZIP_SIGNATURE],                                           // .numbers
  // Legacy .xls is an OLE compound file.
  ["application/vnd.ms-excel", [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]],
]);

/** Whether upload must convert this attachment to Markdown before storing it. */
export function isConvertibleDocumentAttachment(mimeType: string): boolean {
  return CONVERTIBLE_DOCUMENT_MIME_TYPES.has(mimeType);
}

// Magic-number prefixes checked at upload. Like the image signatures, the PDF one ("%PDF-")
// only stops mislabeled uploads at the door; nothing here parses the content.
const CONTENT_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ...IMAGE_SIGNATURES,
  ...CONVERTIBLE_DOCUMENT_MIME_TYPES,
  [PDF_MIME_TYPE, [0x25, 0x50, 0x44, 0x46, 0x2D]],
]);

// Text, images, and convertible documents are universal: text and images are the content parts
// every provider takes, and convertible documents become text at upload.
const isUniversalMime = (mimeType: string) =>
  isTextLikeAttachmentMimeType(mimeType) || IMAGE_SIGNATURES.has(mimeType) ||
  CONVERTIBLE_DOCUMENT_MIME_TYPES.has(mimeType);

const isUniversalOrPdfMime = (mimeType: string) =>
  isUniversalMime(mimeType) || mimeType === PDF_MIME_TYPE;

// pi-ai encodes only text and image content parts, so text + images are universal, and
// convertible documents join them by becoming text at upload. PDFs ride an image part and are
// bridged to a provider's native document input where one exists: Gemini takes application/pdf
// inline data as-is, and Anthropic/OpenAI payloads are rewritten in flight (see
// chat-attachment-pdf.ts). Workers AI and Ollama chat endpoints have no document input at all.
const ATTACHMENT_SUPPORT_BY_PROVIDER = {
  anthropic: isUniversalOrPdfMime,
  openai: isUniversalOrPdfMime,
  google: isUniversalOrPdfMime,
  cloudflare: isUniversalMime,
  ollama: isUniversalMime,
} satisfies Record<AiModelProvider, (mimeType: string) => boolean>;

function sanitizeChatAttachmentMimeType(mimeType: string | undefined): string {
  if (!mimeType || /[\r\n]/.test(mimeType)) return "application/octet-stream";
  return mimeType.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

function sanitizeChatAttachmentName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let result = name.replace(/[\r\n]/g, " ").slice(0, 255).trim();
  return result || undefined;
}

/** Reject an attachment type that the selected provider cannot accept. */
export function assertChatAttachmentSupportedByProvider(
  provider: AiModelProvider | undefined,
  mimeType: string,
  byteLength: number,
): void {
  if (byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error("Chat attachment is too large.");
  }

  if (!provider) {
    if (isUniversalMime(mimeType)) return;
    throw new Error("Unsupported file type");
  }

  if (ATTACHMENT_SUPPORT_BY_PROVIDER[provider](mimeType)) return;

  throw new Error("Unsupported file type");
}

/** Normalize and validate attachment bytes before staging them in chat storage. */
export function validateChatAttachmentUpload(
  attachment: ChatAttachmentUpload,
  provider?: AiModelConfig["provider"],
): ChatAttachmentUpload {
  attachment.name = sanitizeChatAttachmentName(attachment.name);
  attachment.mimeType = sanitizeChatAttachmentMimeType(attachment.mimeType);
  assertChatAttachmentSupportedByProvider(provider, attachment.mimeType, attachment.content.byteLength);

  let signature = CONTENT_SIGNATURES.get(attachment.mimeType);
  if (signature) {
    for (let [index, expected] of signature.entries()) {
      if (expected !== null && attachment.content[index] !== expected) {
        throw new Error("Chat attachment content does not match its MIME type.");
      }
    }
  }

  return attachment;
}

/** Whether a MIME type is one of the image encodings Workshop accepts for chat attachments. */
export function isAllowedChatAttachmentImageMimeType(mimeType: string | undefined): boolean {
  return IMAGE_SIGNATURES.has(sanitizeChatAttachmentMimeType(mimeType));
}

import { describe, expect, it } from "vitest";
import {
  isConvertibleDocumentContentType, renditionPathFor,
} from "../src/document-conversion";
import { contentTypeFromPath, knownContentTypeFromPath } from "../src/context-types";

describe("knownContentTypeFromPath", () => {
  it("names Office and OpenDocument containers so uploads store them as binary", () => {
    expect(knownContentTypeFromPath("reports/q3.docx"))
        .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(knownContentTypeFromPath("book.XLSX"))
        .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(knownContentTypeFromPath("deck.pptx"))
        .toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  // The distinction the upload corruption fix rests on: unknown extensions return undefined here
  // (so the uploader can sniff the bytes), while contentTypeFromPath keeps its markdown default
  // for the in-app editor paths that create text.
  it("returns undefined for unknown extensions, unlike contentTypeFromPath", () => {
    expect(knownContentTypeFromPath("data.bin")).toBeUndefined();
    expect(knownContentTypeFromPath("no-extension")).toBeUndefined();
    expect(contentTypeFromPath("data.bin")).toBe("text/markdown");
  });
});

describe("document renditions", () => {
  it("marks exactly the convertible document types", () => {
    expect(isConvertibleDocumentContentType(knownContentTypeFromPath("a.docx")!)).toBe(true);
    expect(isConvertibleDocumentContentType(knownContentTypeFromPath("a.ods")!)).toBe(true);
    expect(isConvertibleDocumentContentType("application/vnd.ms-excel; charset=x")).toBe(true);
    // Text is already searchable, images would invoke paid models, and PDF reads natively
    // through most providers — none get renditions.
    expect(isConvertibleDocumentContentType("text/markdown")).toBe(false);
    expect(isConvertibleDocumentContentType("image/png")).toBe(false);
    expect(isConvertibleDocumentContentType("application/pdf")).toBe(false);
    // PowerPoint isn't in toMarkdown's supported set: stored intact, but no rendition.
    expect(isConvertibleDocumentContentType(knownContentTypeFromPath("a.pptx")!)).toBe(false);
  });

  it("derives the sibling rendition path with the original extension kept", () => {
    expect(renditionPathFor("reports/q3.docx")).toBe("reports/q3.docx.md");
  });
});

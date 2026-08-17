import { describe, expect, it } from "vitest";

import { connectFormHtml } from "../src/connect-form.js";

describe("connect form", () => {
  it("offers an optional API key field alongside the URL", () => {
    const html = connectFormHtml("/connect/x/y");
    expect(html).toContain('name="url"');
    expect(html).toContain('name="token"');
    // A key is a secret: masked input, no autocomplete, and clearly optional.
    expect(html).toMatch(/id="token"[^>]*type="password"/s);
    expect(html).toMatch(/id="token"[^>]*autocomplete="off"/s);
    expect(html).toContain("only if the server uses");
  });

  it("keeps the token field with a vetted catalog present", () => {
    const html = connectFormHtml("/connect/x/y", undefined, [
      { name: "Stripe", endpoint: "https://mcp.stripe.com/v1" },
    ]);
    expect(html).toContain("Stripe");
    expect(html).toContain('name="token"');
  });
});

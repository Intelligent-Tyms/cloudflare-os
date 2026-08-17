// The one page this gatekeeper serves that asks the user something: which MCP server to connect.
// Lives here rather than in `@gadgets/mcp-shared/html` because the gateway connector, whose endpoint
// is a deployment setting, has no equivalent page.

import { escapeHtml, PAGE_STYLE } from "@gadgets/mcp-shared/html";

// Form controls, on top of the palette and page frame every connect page shares.
const FORM_STYLE = `
  label { display: block; font-size: 14px; font-weight: 600; color: var(--strong); margin: 0 0 6px; }
  p.hint { margin: 6px 0 0; font-size: 13px; color: var(--subtle); }

  input[type=url], input[type=password] {
                    width: 100%; box-sizing: border-box; padding: 9px 11px; font: inherit;
                    background: var(--control); color: var(--text);
                    border: 1px solid var(--line); border-radius: 8px; }
  input[type=url]::placeholder, input[type=password]::placeholder { color: var(--subtle); }
  input[type=url]:focus, input[type=password]:focus { outline: 0; border-color: var(--brand);
                          box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }
  label.later { margin-top: 14px; }
  label .optional { font-weight: 400; color: var(--subtle); }

  button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px;
           background: var(--contrast); color: var(--on-contrast); font: inherit; font-weight: 600;
           cursor: pointer; }
  button:hover { opacity: .9; }
`;

// One vetted-catalog choice on the connect form.
export type ConnectFormChoice = {
  name: string;
  endpoint: string;
  description?: string;
};

// Renders the endpoint prompt shown when the user starts connecting. When the deployment has a
// vetted catalog, its servers appear first as one-click choices; the free URL field remains the
// bring-your-own path with its trust warning (a vetted pick doesn't need it — someone reviewed
// that server before listing it).
export function connectFormHtml(path: string, error?: string,
                                catalog: ConnectFormChoice[] = []): string {
  const choices = catalog.map((server) => `
    <button class="choice" type="submit" name="url" value="${escapeHtml(server.endpoint)}">
      <span class="choice-name">${escapeHtml(server.name)}</span>
      ${server.description ? `<span class="choice-desc">${escapeHtml(server.description)}</span>` : ""}
    </button>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an MCP server</title><style>${PAGE_STYLE}${FORM_STYLE}${CHOICE_STYLE}</style></head>
<body><main>
  <h1>Connect an MCP server</h1>
  <p class="sub">We will discover the server's tools and, if it requires authorization, take you
  through its sign-in.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(path)}">
    ${catalog.length ? `
    <label>Vetted by your organization</label>
    <div class="choices">${choices}</div>
    <p class="divider">or connect any MCP server</p>` : ""}
    <label for="url">Server URL</label>
    <input id="url" type="url" name="url" placeholder="https://example.com/mcp"
           ${catalog.length ? "" : "required autofocus"}>
    <p class="hint">Only connect a server you trust. Its own annotations decide which of its tools
    run without asking you and which wait for your approval, and an annotation is only as
    trustworthy as the server that sent it.</p>
    <label class="later" for="token">API key <span class="optional">— only if the server uses
    one</span></label>
    <input id="token" type="password" name="token" autocomplete="off"
           placeholder="Leave empty for public or sign-in servers">
    <p class="hint">Some servers authenticate with a preissued key instead of a sign-in. The key
    is stored with this connection and sent only to this server, as a bearer token.</p>
    <button type="submit">Continue</button>
  </form>
</main></body></html>`;
}

const CHOICE_STYLE = `
  .choices { display: grid; gap: 8px; }
  button.choice { width: 100%; margin: 0; padding: 10px 12px; text-align: left; font-weight: 400;
                  background: var(--control); color: var(--text);
                  border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
  button.choice:hover { border-color: var(--brand); opacity: 1; }
  .choice-name { display: block; font-weight: 600; color: var(--strong); }
  .choice-desc { display: block; font-size: 13px; color: var(--subtle); margin-top: 2px; }
  p.divider { margin: 16px 0 12px; font-size: 13px; color: var(--subtle); text-align: center; }
`;

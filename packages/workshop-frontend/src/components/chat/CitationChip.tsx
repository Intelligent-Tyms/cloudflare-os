import type { AnchorHTMLAttributes, ReactNode } from "react";
import styles from "../../ChatInterface.module.css";

// A citation of the organization's wiki: the assistant is told to cite precedents as
// `[Title · trust tier](url)`, and links onto the Intelligence cell render as this chip —
// the page title with its trust tier as a badge — opening the page in a new tab.
export const CITATION_TIER_SEPARATOR = " · ";

export function splitCitationText(text: string): { title: string; tier: string | null } {
  const at = text.lastIndexOf(CITATION_TIER_SEPARATOR);
  if (at <= 0) return { title: text, tier: null };
  const tier = text.slice(at + CITATION_TIER_SEPARATOR.length).trim();
  const title = text.slice(0, at).trim();
  return tier && title ? { title, tier } : { title: text, tier: null };
}

// The plain text of a link's children (ReactMarkdown hands us strings for `[text](url)`).
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

export function CitationChip({ href, children, ...props }: {
  href: string;
  children?: ReactNode;
} & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const text = textOf(children);
  const { title, tier } = text ? splitCitationText(text) : { title: "", tier: null };
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.citationChip}
      data-citation="wiki"
      title={tier ? `${title} (${tier})` : undefined}
    >
      <span className={styles.citationTitle}>{title || children}</span>
      {tier && <span className={styles.citationTier}>{tier}</span>}
    </a>
  );
}

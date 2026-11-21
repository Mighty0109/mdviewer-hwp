import { maskMarkdownCode } from './markdown-code';

export type UnsupportedKind = 'frontmatter' | 'html' | 'footnote' | 'math' | 'too-large';
export const RICH_DOCUMENT_LIMIT = 300 * 1024;

export function isTooLargeForRich(markdown: string): boolean {
  return new TextEncoder().encode(markdown).byteLength > RICH_DOCUMENT_LIMIT;
}

/** Conservative: an uncertain construct opens as source rather than losing data. */
export function detectUnsupportedSyntax(markdown: string): UnsupportedKind[] {
  const kinds: UnsupportedKind[] = [];
  if (/^\uFEFF?(?:---|\+\+\+)[ \t]*(?:\r?\n|\r)/.test(markdown)) kinds.push('frontmatter');
  const text = maskMarkdownCode(markdown).replace(/\\[\\$<>\[\]]/g, '  ');
  // Autolinks (<https://...>, <mail@example.com>) are not HTML tags.
  // Plain line breaks are represented by TipTap hardBreak nodes and serialized
  // back into Markdown. Keep tags with attributes in source-only mode.
  const withoutBreaks = text.replace(/<br\s*\/?>/gi, '');
  if (/<!--|<![A-Z]|<\?|<\/?[A-Za-z][\w:-]*(?=\s|\/?>|$)/.test(withoutBreaks)) kinds.push('html');
  if (/\[\^[^\]\r\n]+\]/.test(text)) kinds.push('footnote');
  if (/\$\$|\$[^$\r\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/.test(text)) kinds.push('math');
  if (isTooLargeForRich(markdown)) kinds.push('too-large');
  return kinds;
}

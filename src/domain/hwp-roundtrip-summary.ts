export interface HwpRoundtripSummary { headings: number; paragraphs: number; tables: { rows: number; cols: number }[]; images: number }
/** Counts semantic blocks in the supported Markdown subset, including list paragraphs. */
export function summarizeMarkdown(markdown: string): HwpRoundtripSummary {
  const result: HwpRoundtripSummary = { headings: 0, paragraphs: 0, tables: [], images: 0 };
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  // Count pictures independently of table traversal; image-only cell rows are skipped below.
  let inCode = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (!inCode) result.images += (line.match(/!\[(?:\\.|[^\]])*\]\([^)]*\)/g) || []).length;
  }
  let paragraph = false; let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; paragraph = false; continue; }
    if (fence) continue;

    if (/^#{1,6}\s/.test(line)) { result.headings++; paragraph = false; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1] || '')) {
      const cols = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
      let rows = 1; i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows++; i++; }
      i--; result.tables.push({ rows, cols }); paragraph = false; continue;
    }
    if (!line.trim() || /^!\[/.test(line)) { paragraph = false; continue; }
    if (/^\s*(?:[-+*]|\d+\.)\s/.test(line)) { result.paragraphs++; paragraph = false; continue; }
    if (!paragraph) result.paragraphs++;
    paragraph = true;
  }
  return result;
}
export const summarizeHwpMarkdown = summarizeMarkdown;

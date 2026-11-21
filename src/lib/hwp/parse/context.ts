import { IMPORT_ASSET_PREFIX, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_TOTAL_IMAGES, imageFormat, imagePlaceholder, type ImportAsset } from '@/domain/hwp-assets';
import { HwpImportError, MAX_UNPACKED_BYTES, type HwpImportResult, type ImportWarning, type ImportWarningCode } from '@/domain/hwp-warnings';
import { escapeHwpMarkdown, escapeHwpHtml } from '@/domain/hwp-escape';
import type { HwpParagraphStyle } from '@/domain/hwp-style-map';

export interface Cell { row: number; col: number; rowSpan: number; colSpan: number; blocks: Block[] }
export type Block = { type: 'paragraph'; text: string; style?: HwpParagraphStyle }
  | { type: 'image'; name: string; alt: string }
  | { type: 'table'; rows: number; cols: number; cells: Cell[] };
export class ParseContext {
  warnings: ImportWarning[] = [];
  assets: ImportAsset[] = [];
  stats = { headings: 0, paragraphs: 0, tables: 0, images: 0, imageReferences: 0, imageMappings: 0, skippedImages: 0 };
  private images = new Map<string, Extract<Block, { type: 'image' }>>();
  private imageBytes = 0;
  private unpacked = 0;
  private headers: Block[][] = [];
  private footers: Block[][] = [];
  headerFooter(kind: 'header' | 'footer', blocks: Block[]): void {
    (kind === 'header' ? this.headers : this.footers).push(blocks);
  }
  warn(code: ImportWarningCode, detail?: string): void {
    const old = this.warnings.find(w => w.code === code && w.detail === detail);
    if (old) old.count++; else this.warnings.push({ code, count: 1, ...(detail ? { detail } : {}) });
  }
  budget(bytes: number): void {
    this.unpacked += bytes;
    if (this.unpacked > MAX_UNPACKED_BYTES) throw new HwpImportError('unpacked-too-large', '압축 해제 합계가 200MB를 초과합니다.');
  }
  image(key: string, filename: string, data?: Uint8Array): Block {
    this.stats.imageReferences++;
    const cached = this.images.get(key);
    if (cached) { this.stats.imageMappings++; this.stats.images++; return cached; }
    const format = imageFormat(filename);
    const reason = !data ? 'missing' : !format ? 'format'
      : data.length > MAX_IMAGE_BYTES || this.imageBytes + data.length > MAX_TOTAL_IMAGE_BYTES ? 'size'
      : this.assets.length >= MAX_TOTAL_IMAGES ? 'count' : undefined;
    if (reason) {
      this.stats.skippedImages++; this.warn('image-skipped', reason);
      return { type: 'paragraph', text: imagePlaceholder(this.stats.imageReferences, reason) };
    }
    const name = `img-${String(this.assets.length + 1).padStart(3, '0')}.${format!.extension}`;
    this.assets.push({ name, mimeType: format!.mimeType, bytes: data!.slice() });
    this.imageBytes += data!.length; this.stats.imageMappings++; this.stats.images++;
    const block: Extract<Block, { type: 'image' }> = { type: 'image', name, alt: `이미지 ${this.stats.imageReferences}` };
    this.images.set(key, block);
    return block;
  }
  excluded(code: ImportWarningCode, text: string, detail?: string): Block {
    this.warn(code, detail); return { type: 'paragraph', text: `[${text}]` };
  }
  result(blocks: Block[]): HwpImportResult {
    // Compare complete regions: repeated paragraphs inside a header are content,
    // while the same header on another page/section is only rendered once.
    const unique = (regions: Block[][]) => [...new Map(regions.map(region => [JSON.stringify(region), region])).values()].flat();
    return { markdown: renderBlocks([...unique(this.headers), ...blocks, ...unique(this.footers)], this).trim(), warnings: this.warnings, assets: this.assets, stats: this.stats };
  }
}
function renderBlocks(blocks: Block[], ctx: ParseContext, nested = false, html = false, tableNotices?: Block[]): string {
  return blocks.map(block => {
    if (block.type === 'image') {
      const path = IMPORT_ASSET_PREFIX + block.name;
      return html ? `<img src="${path}" alt="${escapeHwpHtml(block.alt)}">` : `![${block.alt}](${path})`;
    }
    if (block.type === 'paragraph') {
      if (!block.text.trim()) return '';
      const text = html ? escapeHwpHtml(block.text).replace(/\n/g, '<br>') : escapeHwpMarkdown(block.text).replace(/\n/g, '  \n');
      if (block.style?.heading) {
        ctx.stats.headings++;
        return html ? `<h${block.style.heading}>${text}</h${block.style.heading}>` : `${'#'.repeat(block.style.heading)} ${text}`;
      }
      ctx.stats.paragraphs++;
      if (block.style?.list) return `${'  '.repeat(block.style.level)}${block.style.list === 'ordered' ? '1.' : '-'} ${text}`;
      return text;
    }
    ctx.stats.tables++;
    if (nested) ctx.warn('table-nested-flattened');
    if (!Number.isInteger(block.rows) || !Number.isInteger(block.cols) || block.rows < 1 || block.cols < 1 || block.rows > 500 || block.cols > 100)
      throw new HwpImportError('corrupt', '표의 행·열 범위가 잘못되었습니다.');
    const grid = Array.from({ length: block.rows }, () => Array<Cell | undefined>(block.cols).fill(undefined));
    for (const cell of block.cells) {
      if (![cell.row, cell.col, cell.rowSpan, cell.colSpan].every(Number.isInteger)
        || cell.row < 0 || cell.col < 0 || cell.rowSpan < 1 || cell.colSpan < 1
        || cell.row + cell.rowSpan > block.rows || cell.col + cell.colSpan > block.cols)
        throw new HwpImportError('corrupt', '표 셀 주소·병합 범위가 잘못되었습니다.');
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++) for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        if (grid[r][c]) throw new HwpImportError('corrupt', '표 셀 주소가 중복되었습니다.');
        grid[r][c] = cell;
      }
    }
    const raw = !nested && block.cells.some(c => c.colSpan > 1 || c.rowSpan > 1);
    const flattened = !html && !raw && block.cells.some(cell => {
      const paragraphs = cell.blocks.filter((b): b is Extract<Block, { type: 'paragraph' }> => b.type === 'paragraph' && !!b.text.trim());
      return paragraphs.length > 1 || paragraphs.some(p => p.text.includes('\n') || p.style?.heading || p.style?.list);
    });
    // Nested tables share their containing table's notices so labels never become
    // GFM cell text. Emit each affected table's notice once after the outer table.
    const notices = tableNotices ?? [];
    if (flattened) notices.push(ctx.excluded('table-cell-flattened', '표 셀 구조 평탄화'));
    const contents = new Map(block.cells.map(cell => [cell, renderBlocks(cell.blocks, ctx, true, html || raw, notices).replace(/\n+/g, ' ')]));
    if (nested) {
      const label = html ? '[중첩 표: 텍스트만 가져옴]' : escapeHwpMarkdown('[중첩 표: 텍스트만 가져옴]');
      return `${label} ${[...contents.values()].join(' / ')}`;
    }
    if (raw) {
      ctx.warn('table-raw-html');
      return `<table>\n${grid.map((row, r) => '<tr>' + row.map((cell, c) => {
        if (!cell) return '<td></td>';
        if (cell.row !== r || cell.col !== c) return '';
        return `<td rowspan="${cell.rowSpan}" colspan="${cell.colSpan}">${contents.get(cell)}</td>`;
      }).join('') + '</tr>').join('\n')}\n</table>`;
    }
    const lines = grid.map(row => `| ${row.map(cell => cell ? contents.get(cell) : '').join(' | ')} |`);
    lines.splice(1, 0, `| ${grid[0].map(() => '---').join(' | ')} |`);
    return lines.join('\n') + (notices.length ? '\n\n' + renderBlocks(notices, ctx) : '');
  }).filter(Boolean).join(html ? '<br>' : '\n\n');
}

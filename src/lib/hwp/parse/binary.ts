import * as CFB from 'cfb';
import { HwpImportError, MAX_ENTRY_BYTES, type HwpImportResult, type HwpProgress } from '@/domain/hwp-warnings';
import { headingLevelForStyle, paragraphStyleFromFlags, type HwpParagraphStyle } from '@/domain/hwp-style-map';
import { ParseContext, type Block, type Cell } from './context';
import { inflateBounded } from './archive';
import { preflightCfb } from './cfb-preflight';
export interface HwpRecord { tag: number; level: number; data: Uint8Array }
const corrupt = (message = '손상된 HWP 레코드입니다.'): never => { throw new HwpImportError('corrupt', message); };
const u16 = (b: Uint8Array, p: number) => p + 2 <= b.length ? b[p] | b[p + 1] << 8 : corrupt();
const u32 = (b: Uint8Array, p: number) => p + 4 <= b.length ? (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0 : corrupt();
export function readRecords(bytes: Uint8Array): HwpRecord[] {
  const result: HwpRecord[] = []; let p = 0;
  while (p < bytes.length) {
    const header = u32(bytes, p); p += 4;
    let size = header >>> 20;
    if (size === 4095) { size = u32(bytes, p); p += 4; }
    if (p + size > bytes.length || result.length >= 1_000_000) corrupt();
    result.push({ tag: header & 1023, level: (header >>> 10) & 1023, data: bytes.subarray(p, p + size) });
    p += size;
  }
  return result;
}
export function readParaText(data: Uint8Array): string {
  if (data.length % 2) corrupt();
  let text = '';
  for (let p = 0; p < data.length; p += 2) {
    const ch = u16(data, p);
    if (ch >= 32) { text += String.fromCharCode(ch); continue; }
    if (ch === 10) text += '\n';
    else if (ch === 9) { text += '\t'; if (p + 16 <= data.length && u16(data, p + 14) === 9) p += 14; }
    else if ((ch >= 1 && ch <= 8) || ch === 11 || ch === 12 || (ch >= 14 && ch <= 23)) {
      if (p + 16 > data.length) corrupt();
      text += '\x01'; p += 14;
    } else if (ch === 24) text += '-';
    else if (ch === 30 || ch === 31) text += ' ';
  }
  return text;
}
function utf16(data: Uint8Array, offset: number): [string, number] {
  const len = u16(data, offset); const end = offset + 2 + len * 2;
  if (end > data.length) corrupt();
  return [new TextDecoder('utf-16le').decode(data.subarray(offset + 2, end)), end];
}
export function parseBinary(bytes: Uint8Array, onProgress?: HwpProgress): HwpImportResult {
  const ctx = new ParseContext();
  // cfb's reader can normalise its input; never pass the caller's buffer.
  preflightCfb(bytes);
  const cfb = CFB.read(bytes.slice(), { type: 'array' });
  const stream = (path: string): Uint8Array => {
    const entry = CFB.find(cfb, path);
    if (!entry?.content) return corrupt('HWP 필수 스트림이 없습니다.');
    return Uint8Array.from(entry.content as ArrayLike<number>);
  };
  if (!CFB.find(cfb, 'FileHeader')) throw new HwpImportError('unsupported-format', 'HWP 문서가 아닌 CFB 파일입니다.');
  const header = stream('FileHeader');
  if (header.length < 40 || new TextDecoder().decode(header.subarray(0, 17)) !== 'HWP Document File')
    throw new HwpImportError('unsupported-format', 'HWP 5.x 문서가 아닙니다.');
  if (header[35] !== 5) throw new HwpImportError('unsupported-format', 'HWP 5.x만 지원합니다.');
  const flags = u32(header, 36);
  if (flags & 2) throw new HwpImportError('encrypted', '암호화된 HWP 문서는 가져올 수 없습니다.');
  if (flags & 0x14) throw new HwpImportError('drm-distribution', '배포용 또는 DRM HWP 문서는 가져올 수 없습니다.');
  const compressed = !!(flags & 1);
  const unpack = (data: Uint8Array, shouldInflate = compressed) => {
    const result = shouldInflate ? inflateBounded(data) : data;
    if (result.length > MAX_ENTRY_BYTES) throw new HwpImportError('unpacked-too-large', 'HWP 스트림 크기를 초과했습니다.');
    ctx.budget(result.length); return result;
  };
  const docInfo = readRecords(unpack(stream('DocInfo')));
  const styles: number[] = []; const paraStyles: HwpParagraphStyle[] = [];
  const bins = new Map<number, { storage: number; ext: string; compression: number }>();
  let binIndex = 0;
  for (const record of docInfo) {
    if (record.tag === 26) { const [name] = utf16(record.data, 0); styles.push(headingLevelForStyle(name)); }
    if (record.tag === 25) paraStyles.push(paragraphStyleFromFlags(u32(record.data, 0)));
    if (record.tag === 18) {
      binIndex++; const flags = u16(record.data, 0); const kind = flags & 15;
      if (kind === 1 || kind === 2) {
        const storage = u16(record.data, 2); const ext = kind === 1 ? utf16(record.data, 4)[0] : '';
        bins.set(binIndex, { storage, ext, compression: (flags >>> 4) & 3 });
      }
    }
  }
  const imageStreams = new Map<number, { name: string; data: Uint8Array }>();
  cfb.FullPaths.forEach((path, i) => {
    const match = /\/BinData\/BIN([0-9a-f]+)\.(\w+)$/i.exec(path);
    if (match && cfb.FileIndex[i]?.content) imageStreams.set(parseInt(match[1], 16), { name: path, data: Uint8Array.from(cfb.FileIndex[i].content as ArrayLike<number>) });
  });
  const decodedImages = new Map<number, Uint8Array>();
  const image = (id: number): Block => {
    const mapping = bins.get(id); const item = mapping ? imageStreams.get(mapping.storage) : undefined;
    if (!item || !mapping) return ctx.image(String(id), '', undefined);
    let data = decodedImages.get(id);
    if (!data) {
      data = unpack(item.data, mapping.compression === 1 || (mapping.compression === 0 && compressed));
      decodedImages.set(id, data);
    }
    return ctx.image(String(id), mapping.ext ? `image.${mapping.ext}` : item.name, data);
  };
  const extent = (records: HwpRecord[], index: number, end: number) => {
    let j = index + 1; while (j < end && records[j].level > records[index].level) j++; return j;
  };
  let masterpageReported = false;
  const handled = new Set<HwpRecord>();
  const accountFor = (records: HwpRecord[], start: number, end: number) => {
    for (let i = start; i < end; i++) handled.add(records[i]);
  };
  const process = (records: HwpRecord[], start: number, end: number, depth = 0): Block[] => {
    if (depth > 64) corrupt('HWP 문서 중첩이 너무 깊습니다.');
    const blocks: Block[] = [];
    for (let i = start; i < end;) {
      const rec = records[i];
      if (rec.tag !== 66) { i++; continue; }
      const paraEnd = extent(records, i, end);
      const style: HwpParagraphStyle = { ...(paraStyles[u16(rec.data, 8)] || { heading: 0, level: 0 }), heading: styles[rec.data[10]] || 0 };
      const ownText = records.slice(i + 1, paraEnd).filter(r => r.tag === 67 && r.level === rec.level + 1)
        .map(r => { handled.add(r); return readParaText(r.data); }).join('');
      const controls: Block[][] = [];
      for (let j = i + 1; j < paraEnd;) {
        if (records[j].tag === 71 && records[j].level === rec.level + 1) {
          const ctrlEnd = extent(records, j, paraEnd); controls.push(control(records, j, ctrlEnd, depth + 1)); j = ctrlEnd;
        } else j++;
      }
      const parts = ownText.split('\x01'); let controlIndex = 0;
      for (let p = 0; p < parts.length; p++) {
        if (parts[p].trim()) blocks.push({ type: 'paragraph', text: parts[p], style });
        if (p < parts.length - 1 && controlIndex < controls.length) blocks.push(...controls[controlIndex++]);
      }
      while (controlIndex < controls.length) blocks.push(...controls[controlIndex++]);
      i = paraEnd;
    }
    return blocks;
  };
  const control = (records: HwpRecord[], start: number, end: number, depth: number): Block[] => {
    handled.add(records[start]);
    const id = String.fromCharCode(...records[start].data.subarray(0, 4)).split('').reverse().join('').trim();
    if (['fn', 'en', 'eqed', 'pgnp'].includes(id)) accountFor(records, start, end);
    if (id === 'head' || id === 'foot') {
      ctx.headerFooter(id === 'head' ? 'header' : 'footer', process(records, start + 1, end, depth));
      return [];
    }
    if (id === 'fn' || id === 'en') return [ctx.excluded('footnote-skipped', '각주/미주 제외')];
    if (id === 'eqed') return [ctx.excluded('equation-skipped', '수식 제외')];
    if (id === 'pgnp') return [ctx.excluded('object-skipped', '자동 번호 필드 제외')];
    if (id === 'tbl') {
      // A caption can itself contain a table; only this control's TABLE defines its cells.
      const tableIndex = records.findIndex((r, n) => n > start && n < end && r.tag === 77 && r.level === records[start].level + 1);
      if (tableIndex < 0) return corrupt('표 레코드가 없습니다.');
      handled.add(records[tableIndex]);
      const captions: Block[] = [];
      // Caption LIST_HEADERs precede TABLE and have a different payload from cell lists.
      // Read their paragraphs as content instead of dropping them or interpreting cell offsets.
      for (let i = start + 1; i < tableIndex;) {
        if (records[i].tag === 72 && records[i].level === records[start].level + 1) {
          const captionEnd = extent(records, i, tableIndex);
          captions.push(ctx.excluded('object-skipped', '캡션 배치 제외: 텍스트만 가져옴', 'caption-layout'),
            ...process(records, i + 1, captionEnd, depth));
          i = captionEnd;
        } else i++;
      }
      const data = records[tableIndex].data; const rows = u16(data, 4), cols = u16(data, 6);
      const cells: Cell[] = []; let cellLevel: number | undefined;
      for (let i = tableIndex + 1; i < end;) {
        const r = records[i];
        if (r.tag !== 72 || (cellLevel !== undefined && r.level !== cellLevel)) { i++; continue; }
        cellLevel = r.level;
        let cellEnd = i + 1;
        while (cellEnd < end && !(records[cellEnd].tag === 72 && records[cellEnd].level <= cellLevel)) cellEnd++;
        cells.push({ col: u16(r.data, 8), row: u16(r.data, 10), colSpan: u16(r.data, 12), rowSpan: u16(r.data, 14), blocks: process(records, i + 1, cellEnd, depth) });
        i = cellEnd;
      }
      return [...captions, { type: 'table', rows, cols, cells }];
    }
    if (id === 'gso') {
      const blocks: Block[] = [];
      for (let i = start + 1; i < end; i++) {
        if (records[i].tag === 71) { i = extent(records, i, end) - 1; continue; }
        if ((records[i].tag >= 78 && records[i].tag <= 86) || records[i].tag === 88) handled.add(records[i]);
        // HWPTAG_SHAPE_COMPONENT_PICTURE = 85; BinData reference is UINT16 at byte 71.
        if (records[i].tag === 85) blocks.push(image(u16(records[i].data, 71)));
        if ((records[i].tag >= 78 && records[i].tag <= 83) || records[i].tag === 86)
          blocks.push(ctx.excluded('shape-skipped', '도형 제외'));
        if (records[i].tag === 84) blocks.push(ctx.excluded('object-skipped', 'OLE 개체 제외'));
        if (records[i].tag === 88) blocks.push(ctx.excluded('equation-skipped', '수식 제외'));
      }
      const text = process(records, start + 1, end, depth);
      if (text.length) { blocks.push(ctx.excluded('textbox-text-only', '글상자 텍스트만 가져옴'), ...text); }
      if (!blocks.length) blocks.push(ctx.excluded('shape-skipped', '도형 제외'));
      return blocks;
    }
    if (id === 'secd') {
      // Master-page LIST_HEADER paragraphs live under the section definition.
      // Inspect without importing: these paragraphs and objects are not body content.
      const hasContent = records.slice(start + 1, end).some(r => r.tag === 67
        ? !!readParaText(r.data).replace(/\x01/g, '').trim() : r.tag === 71
          && !['secd', 'cold', 'pgct', 'pghd', 'bokm'].includes(String.fromCharCode(...r.data.subarray(0, 4)).split('').reverse().join('').trim()));
      if (hasContent && !masterpageReported) {
        masterpageReported = true;
        accountFor(records, start, end);
        return [ctx.excluded('masterpage-skipped', '바탕쪽 제외')];
      }
      if (hasContent) accountFor(records, start, end); // Already reported for this section.
      else for (const r of records.slice(start + 1, end)) if (r.tag === 71) handled.add(r);
      return [];
    }
    if (['cold', 'pgct', 'pghd', 'bokm'].includes(id)) return [];
    accountFor(records, start, end); // The generic exclusion covers unknown control payloads.
    return [ctx.excluded('object-skipped', '개체 제외'), ...process(records, start + 1, end, depth)];
  };
  const sections = cfb.FullPaths.filter(path => /\/BodyText\/Section\d+$/i.test(path)).sort((a, b) => Number(a.match(/Section(\d+)$/i)?.[1]) - Number(b.match(/Section(\d+)$/i)?.[1]));
  if (!sections.length) corrupt('HWP 본문 섹션이 없습니다.');
  const blocks: Block[] = [];
  sections.forEach((path, index) => {
    masterpageReported = false;
    handled.clear();
    onProgress?.(20 + Math.floor(index / sections.length * 70), 'HWP 본문 읽는 중');
    const records = readRecords(unpack(stream(path))); blocks.push(...process(records, 0, records.length));
    // Audit every bypass (paragraph/table/gso fast paths) once. These tags contain
    // headers, layout, range/shape properties or control parameters, never body text.
    const metadata = new Set([66, 68, 69, 70, 72, 73, 74, 75, 76, 87]);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (handled.has(r) || metadata.has(r.tag)) continue;
      if (r.tag === 67 && !readParaText(r.data).replace(/\x01/g, '').trim()) continue;
      if (r.tag !== 67 && r.tag !== 71 && !r.data.length) continue;
      blocks.push(ctx.excluded('object-skipped', '개체 제외', `record-${r.tag}`));
      // One notice covers the whole unhandled subtree, including any nested text.
      const next = extent(records, i, records.length); accountFor(records, i, next); i = next - 1;
    }
  });
  return ctx.result(blocks);
}

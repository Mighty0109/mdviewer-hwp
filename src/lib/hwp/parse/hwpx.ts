import { HwpImportError, type HwpImportResult, type HwpProgress } from '@/domain/hwp-warnings';
import { headingLevelForStyle, type HwpParagraphStyle } from '@/domain/hwp-style-map';
import { ParseContext, type Block, type Cell } from './context';
import { openZip } from './archive';
import { parseXml, NS, elements, descendants, type XmlElement } from './xml';

export function parseHwpxBytes(bytes: Uint8Array, onProgress?: HwpProgress): HwpImportResult {
  const ctx = new ParseContext(); const zip = openZip(bytes, ctx);
  const text = (name: string) => {
    const entry = zip.get(name); if (!entry) throw new HwpImportError('corrupt', 'HWPX 필수 항목이 없습니다.');
    return new TextDecoder('utf-8', { fatal: true }).decode(entry());
  };
  if (!zip.has('mimetype') || text('mimetype').trim() !== 'application/hwp+zip') throw new HwpImportError('unsupported-format', 'HWPX 패키지가 아닙니다.');
  if (zip.has('META-INF/manifest.xml')) {
    const manifest = parseXml(text('META-INF/manifest.xml'));
    const encryption = (node: XmlElement): boolean => /encrypt/i.test(node.local)
      || Object.entries(node.attrs).some(([key, value]) => /encrypt/i.test(key) && !/^(false|0)$/i.test(value))
      || elements(node).some(encryption);
    if (encryption(manifest)) throw new HwpImportError('encrypted', '암호화된 HWPX 문서는 가져올 수 없습니다.');
  }
  const header = parseXml(text('Contents/header.xml'));
  const hpf = parseXml(text('Contents/content.hpf'));
  const items = new Map<string, string>();
  for (const item of descendants(hpf, 'item')) {
    const href = item.attrs.href || '';
    const path = href.startsWith('Contents/') || href.startsWith('BinData/') ? href : href.startsWith('../BinData/') ? href.slice(3) : `Contents/${href}`;
    items.set(item.attrs.id, path);
  }
  const styles = new Map<string, number>();
  for (const style of descendants(header, 'style', NS.head)) styles.set(style.attrs.id, headingLevelForStyle(style.attrs.name || ''));
  const paraStyles = new Map<string, HwpParagraphStyle>();
  for (const para of descendants(header, 'paraPr', NS.head)) {
    const heading = descendants(para, 'heading')[0];
    paraStyles.set(para.attrs.id, { heading: 0, level: Math.min(7, Math.max(0, Number(heading?.attrs.level) || 0)),
      list: heading?.attrs.type === 'NUMBER' ? 'ordered' : heading?.attrs.type === 'BULLET' ? 'bullet' : undefined });
  }
  const pictureImage = (node: XmlElement): XmlElement | undefined => {
    for (const child of elements(node)) {
      // A picture inside a caption is a separate image, never the parent picture's source.
      if (child.local === 'caption' && child.ns === NS.paragraph) continue;
      if (child.local === 'img' && (child.ns === NS.core || child.ns === NS.paragraph)) return child;
      const found = pictureImage(child); if (found) return found;
    }
  };
  const picture = (node: XmlElement): Block => {
    const img = pictureImage(node) || node;
    const ref = img.attrs.binaryItemIDRef || img.attrs.binItemIDRef || '';
    const path = items.get(ref);
    return ctx.image(ref, path || ref, path ? zip.get(path)?.() : undefined);
  };
  let deleted = 0;
  let masterpageReported = false;
  const hasMasterContent = (node: XmlElement): boolean => node.children.some(child => {
    if (typeof child === 'string') return node.local !== 'shapeComment' && !!child.trim();
    const emptyContainer = child.ns === NS.paragraph
      && /^(?:p|run|t|ctrl|subList|masterPage|tab|lineBreak|nbSpace|fwSpace|bookmark|fieldEnd|markpenBegin|markpenEnd)$/.test(child.local);
    const layout = (child.ns === NS.paragraph || child.ns === NS.core) && metadata.test(child.local);
    return (!emptyContainer && !layout) || hasMasterContent(child);
  });
  const masterPages = new Map<string, boolean>();
  const hasMasterText = (sectionProperties: XmlElement): boolean => {
    let hasText = false;
    for (const master of descendants(sectionProperties, 'masterPage', NS.paragraph)) {
      hasText = hasMasterContent(master) || hasText;
      if (!master.attrs.idRef) continue; // Inline master page; its paragraphs were checked above.
      const path = items.get(master.attrs.idRef);
      if (!path) throw new HwpImportError('corrupt', '바탕쪽 참조 항목이 없습니다.');
      if (!masterPages.has(path)) masterPages.set(path, hasMasterContent(parseXml(text(path))));
      hasText = masterPages.get(path)! || hasText;
    }
    return hasText;
  };
  // Fast paths must account for children they do not render. Only known geometry
  // and layout nodes are silent; extension objects get a visible exclusion.
  const metadata = /^(?:offset|orgSz|curSz|flip|rotationInfo|renderingInfo|transMatrix|scaMatrix|rotMatrix|imgRect|pt0|pt1|pt2|pt3|imgClip|inMargin|imgDim|effects|shadow|glow|softEdge|reflection|skew|sz|pos|outMargin|shapeComment|cellAddr|cellSpan|cellSz|cellMargin|inCellMargin|cellzoneList|cellzone|linesegarray|lineseg|startNum|grid|visibility|lineNumberShape|pagePr|margin|footNotePr|endNotePr|autoNumFormat|noteLine|noteSpacing|numbering|placement|pageBorderFill)$/;
  const skippedChildren = (node: XmlElement, handled: string[] = [], retainedImage?: XmlElement): Block[] => node.children.flatMap(child => {
    if (typeof child === 'string') return child.trim() && node.local !== 'shapeComment'
      ? [ctx.excluded('object-skipped', '개체 일부 제외')] : [];
    const native = child.ns === NS.paragraph || child.ns === NS.core;
    if (child.ns === NS.paragraph && handled.includes(child.local)) return [];
    if (child === retainedImage || (native && metadata.test(child.local))) return skippedChildren(child, [], retainedImage);
    return [ctx.excluded('object-skipped', '개체 일부 제외')];
  });
  const paragraph = (node: XmlElement, depth: number): Block[] => {
    if (depth > 64) throw new HwpImportError('corrupt', '문서 중첩이 너무 깊습니다.');
    const blocks: Block[] = []; let buffer = '';
    const style = { ...(paraStyles.get(node.attrs.paraPrIDRef) || { heading: 0, level: 0 }), heading: styles.get(node.attrs.styleIDRef) || 0 };
    const flush = () => { if (buffer.trim()) blocks.push({ type: 'paragraph', text: buffer, style }); buffer = ''; };
    const walk = (n: XmlElement, inText = false): void => {
      if (n.ns === NS.paragraph) {
        if (/^(?:deleteBegin|deletionBegin)$/.test(n.local)) {
          flush(); deleted++; blocks.push(ctx.excluded('change-tracking-ignored', '변경추적 삭제 내용 제외')); return;
        }
        if (/^(?:deleteEnd|deletionEnd)$/.test(n.local)) { deleted = Math.max(0, deleted - 1); return; }
        if (deleted) { for (const child of elements(n)) walk(child, inText || n.local === 't'); return; }
        if (n.local === 'header' || n.local === 'footer') {
          flush(); ctx.headerFooter(n.local, topParagraphs(n, depth + 1)); return;
        }
        if (n.local === 'footNote' || n.local === 'endNote') { flush(); blocks.push(ctx.excluded('footnote-skipped', '각주/미주 제외')); return; }
        if (n.local === 'equation') { flush(); blocks.push(ctx.excluded('equation-skipped', '수식 제외')); return; }
        if (n.local === 'caption') {
          flush(); blocks.push(...caption(n, depth + 1)); return;
        }
        if (n.local === 'pic') { flush(); blocks.push(...captions(n, depth + 1), picture(n), ...skippedChildren(n, ['caption'], pictureImage(n))); return; }
        if (n.local === 'tbl') { flush(); blocks.push(...captions(n, depth + 1), ...table(n, depth + 1)); return; }
        if (/^(?:rect|ellipse|polygon|arc|curve|line|connectLine|container|textBox)$/.test(n.local)) {
          flush(); const paras = descendants(n, 'p', NS.paragraph);
          if (paras.length) { blocks.push(ctx.excluded('textbox-text-only', '글상자 텍스트만 가져옴')); blocks.push(...topParagraphs(n, depth + 1)); }
          else blocks.push(ctx.excluded('shape-skipped', '도형 제외'));
          return;
        }
        if (n.local === 'ole' || n.local === 'video') { flush(); blocks.push(ctx.excluded('object-skipped', '개체 제외')); return; }
        if (/^(?:delete|deletedText|del)$/.test(n.local)) { flush(); blocks.push(ctx.excluded('change-tracking-ignored', '변경추적 삭제 내용 제외')); return; }
        if (/^(?:insert|insertBegin|insertEnd|insertionBegin|insertionEnd|trackChange)$/.test(n.local)) {
          flush(); blocks.push(ctx.excluded('change-tracking-ignored', '변경추적 최종본만 가져옴'));
        }
        if (n.local === 'hyphen') { buffer += '-'; return; }
        if (n.local === 'nbSpace' || n.local === 'fwSpace') { buffer += ' '; return; }
        if (n.local === 'tab') { buffer += '\t'; return; }
        if (n.local === 'lineBreak') { buffer += '\n'; return; }
        if (n.local === 'autoNum' || n.local === 'newNum' || n.local === 'pageNum') { flush(); blocks.push(ctx.excluded('object-skipped', '자동 번호 필드 제외')); return; }
        if (n.local === 'fieldBegin') {
          // Field parameters (e.g. hyperlink targets) are metadata; their display text is
          // in the following runs. Report the reduction once, without exposing parameters.
          flush(); blocks.push(ctx.excluded('object-skipped', '필드 정보 제외: 표시 글만 가져옴', 'field-metadata')); return;
        }
        if (n.local === 'p' && n !== node) { flush(); blocks.push(...paragraph(n, depth + 1)); return; }
        if (n.local === 't') inText = true;
        const known = /^(?:p|run|t|ctrl|subList|secPr|colPr|linesegarray|lineseg|pageNum|autoNum|newNum|bookmark|fieldEnd|markpenBegin|markpenEnd|insert|insertBegin|insertEnd|insertionBegin|insertionEnd|trackChange)$/;
        if (!known.test(n.local)) { flush(); blocks.push(ctx.excluded('object-skipped', '개체 일부 제외')); }
        if (n.local === 'secPr') {
          if (hasMasterText(n) && !masterpageReported) {
            flush(); masterpageReported = true; blocks.push(ctx.excluded('masterpage-skipped', '바탕쪽 제외'));
          }
          const skipped = skippedChildren(n, ['masterPage']);
          if (skipped.length) { flush(); blocks.push(...skipped); }
          return;
        }
        if (n.local === 'linesegarray') {
          const skipped = skippedChildren(n);
          if (skipped.length) { flush(); blocks.push(...skipped); }
          return;
        }
      } else if (n !== node) {
        flush(); blocks.push(ctx.excluded('object-skipped', '알 수 없는 확장 개체 제외'));
        if (!inText) return;
      }
      for (const child of n.children) {
        if (typeof child === 'string') {
          if (inText && !deleted) buffer += child;
          else if (!deleted && child.trim()) { flush(); blocks.push(ctx.excluded('object-skipped', '개체 일부 제외')); }
        } else walk(child, inText);
      }
    };
    walk(node); flush(); return blocks;
  };
  const topParagraphs = (node: XmlElement, depth: number): Block[] => {
    const blocks: Block[] = [];
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child.trim()) blocks.push(ctx.excluded('object-skipped', '개체 일부 제외'));
        continue;
      }
      if (child.local === 'p' && child.ns === NS.paragraph) blocks.push(...paragraph(child, depth));
      else if ((child.ns === NS.paragraph && (child.local === 'subList' || child.local === 'tc'))
        || (child.ns === NS.section && child.local === 'sec')) blocks.push(...topParagraphs(child, depth));
      else if (child.ns === NS.paragraph && /^(?:cellAddr|cellSpan|cellSz|cellMargin)$/.test(child.local)) blocks.push(...skippedChildren(child));
      else blocks.push(...paragraph({ name: 'p', local: 'p', ns: NS.paragraph, attrs: {}, children: [child] }, depth));
    }
    return blocks;
  };
  // Caption containers are siblings of image metadata / table rows. Those fast paths
  // do not traverse them, so explicitly retain their content with the normal policies.
  const caption = (node: XmlElement, depth: number): Block[] => [
    ctx.excluded('object-skipped', '캡션 배치 제외: 텍스트만 가져옴', 'caption-layout'), ...topParagraphs(node, depth),
  ];
  const captions = (node: XmlElement, depth: number): Block[] => elements(node)
    .filter(child => child.local === 'caption' && child.ns === NS.paragraph)
    .flatMap(child => caption(child, depth));
  const table = (node: XmlElement, depth: number): Block[] => {
    const cells: Cell[] = []; const rows = elements(node).filter(n => n.local === 'tr' && n.ns === NS.paragraph);
    rows.forEach((row, r) => elements(row).filter(n => n.local === 'tc' && n.ns === NS.paragraph).forEach((cell, c) => {
      const addr = descendants(cell, 'cellAddr', NS.paragraph)[0], span = descendants(cell, 'cellSpan', NS.paragraph)[0];
      cells.push({ row: Number(addr?.attrs.rowAddr ?? r), col: Number(addr?.attrs.colAddr ?? c),
        rowSpan: Number(span?.attrs.rowSpan || 1), colSpan: Number(span?.attrs.colSpan || 1), blocks: topParagraphs(cell, depth) });
    }));
    return [{ type: 'table', rows: Number(node.attrs.rowCnt || rows.length), cols: Number(node.attrs.colCnt || Math.max(0, ...cells.map(c => c.col + c.colSpan))), cells },
      ...skippedChildren(node, ['tr', 'caption']), ...rows.flatMap(row => skippedChildren(row, ['tc']))];
  };
  const allSections = [...zip.keys()].filter(p => /^Contents\/section\d+\.xml$/i.test(p)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const spine = descendants(hpf, 'itemref').map(n => items.get(n.attrs.idref)).filter((p): p is string => !!p && allSections.includes(p));
  const sections = [...new Set([...spine, ...allSections])];
  if (!sections.length) throw new HwpImportError('corrupt', '본문 섹션이 없습니다.');
  const blocks: Block[] = [];
  sections.forEach((path, i) => {
    masterpageReported = false;
    onProgress?.(20 + Math.floor(i / sections.length * 70), 'HWPX 본문 읽는 중');
    const root = parseXml(text(path));
    if (root.ns !== NS.section || root.local !== 'sec') throw new HwpImportError('corrupt', 'HWPX 섹션 네임스페이스가 잘못되었습니다.');
    blocks.push(...topParagraphs(root, 0));
  });
  if (deleted) throw new HwpImportError('corrupt', '변경추적 삭제 범위가 닫히지 않았습니다.');
  return ctx.result(blocks);
}

import type { EmbeddedImage, ExportDocument, Inline, Paragraph, Table } from './types';
import { XML, element as el, escapeXml, namespaces } from './xml';

// HWPUNIT is 1/7200 inch (not 1/100 mm). A4 with 20 mm side margins.
const PAGE_WIDTH = 59528;
const PAGE_HEIGHT = 84186;
const PAGE_MARGIN = 5669;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;
const CONTENT_HEIGHT = PAGE_HEIGHT - 2 * PAGE_MARGIN;
const margin = (name: string, value: number) => el(name, { left: value, right: value, top: value, bottom: value });
const scripts = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];

interface ParaShape { heading: number; quote: number; code: boolean; list?: Paragraph['list'] }

export function documentXml(document: ExportDocument): { header: string; section: string } {
  let paragraphId = 0;
  let objectId = 1;
  let sectionPropertiesWritten = false;
  const shapes: ParaShape[] = Array.from({ length: 9 }, (_, id) => ({
    heading: id >= 1 && id <= 6 ? id : 0, quote: id === 8 ? 1 : 0, code: id === 7,
  }));
  function shapeId(paragraph: Paragraph): number {
    const shape: ParaShape = { heading: paragraph.heading ?? 0, quote: paragraph.quote ?? 0, code: !!paragraph.code, list: paragraph.list };
    let id = shapes.findIndex(s => s.heading === shape.heading && s.quote === shape.quote && s.code === shape.code
      && s.list?.ordered === shape.list?.ordered && s.list?.level === shape.list?.level && s.list?.numbering === shape.list?.numbering);
    if (id < 0) { id = shapes.length; shapes.push(shape); }
    return id;
  }

  function sectionProperties(): string {
    return el('hp:secPr', { id: '', textDirection: 'HORIZONTAL', spaceColumns: 1134, tabStop: 8000, tabStopVal: 4000,
      tabStopUnit: 'HWPUNIT', outlineShapeIDRef: 1, memoShapeIDRef: 0, textVerticalWidthHead: 0, masterPageCnt: 0 },
    el('hp:grid', { lineGrid: 0, charGrid: 0, wonggojiFormat: 0 })
      + el('hp:startNum', { pageStartsOn: 'BOTH', page: 0, pic: 0, tbl: 0, equation: 0 })
      + el('hp:visibility', { hideFirstHeader: 0, hideFirstFooter: 0, hideFirstMasterPage: 0,
        border: 'SHOW_ALL', fill: 'SHOW_ALL', hideFirstPageNum: 0, hideFirstEmptyLine: 0, showLineNumber: 0 })
      // lineNumberShape, footNotePr, endNotePr and pageBorderFill values/order follow a Hancom-format secPr verbatim.
      + el('hp:lineNumberShape', { restartType: 0, countBy: 0, distance: 0, startNumber: 0 })
      + el('hp:pagePr', { landscape: 'WIDELY', width: PAGE_WIDTH, height: PAGE_HEIGHT, gutterType: 'LEFT_ONLY' },
        el('hp:margin', { header: 0, footer: 0, gutter: 0, left: PAGE_MARGIN, right: PAGE_MARGIN, top: PAGE_MARGIN, bottom: PAGE_MARGIN }))
      + el('hp:footNotePr', {}, el('hp:autoNumFormat', { type: 'DIGIT', userChar: '', prefixChar: '', suffixChar: ')', supscript: 0 })
        + el('hp:noteLine', { length: -1, type: 'SOLID', width: '0.12 mm', color: '#000000' })
        + el('hp:noteSpacing', { betweenNotes: 284, belowLine: 568, aboveLine: 852 })
        + el('hp:numbering', { type: 'CONTINUOUS', newNum: 1 })
        + el('hp:placement', { place: 'EACH_COLUMN', beneathText: 0 }))
      + el('hp:endNotePr', {}, el('hp:autoNumFormat', { type: 'DIGIT', userChar: '', prefixChar: '', suffixChar: ')', supscript: 0 })
        + el('hp:noteLine', { length: 0, type: 'NONE', width: '0.12 mm', color: '#000000' })
        + el('hp:noteSpacing', { betweenNotes: 0, belowLine: 576, aboveLine: 864 })
        + el('hp:numbering', { type: 'CONTINUOUS', newNum: 1 })
        + el('hp:placement', { place: 'END_OF_DOCUMENT', beneathText: 0 }))
      + ['BOTH', 'EVEN', 'ODD'].map(type => el('hp:pageBorderFill', { type, borderFillIDRef: 1, textBorder: 'PAPER',
        headerInside: 0, footerInside: 0, fillArea: 'PAPER' }, el('hp:offset', { left: 1417, right: 1417, top: 1417, bottom: 1417 }))).join(''))
      + el('hp:ctrl', {}, el('hp:colPr', { id: '', type: 'NEWSPAPER', layout: 'LEFT', colCount: 1, sameSz: 1, sameGap: 0 }));
  }

  function textXml(text: string): string {
    const content = text.split(/(\r\n|\r|\n|\t)/).map(part => {
      if (part === '\t') return el('hp:tab', { width: 4000, leader: 0, type: 1 });
      if (/^(?:\r\n|\r|\n)$/.test(part)) return el('hp:lineBreak');
      return escapeXml(part);
    }).join('');
    return el('hp:t', {}, content);
  }

  function objectAttrs(type: 'PICTURE' | 'TABLE', id: number) {
    return { id, zOrder: 0, numberingType: type, textWrap: 'TOP_AND_BOTTOM', textFlow: 'BOTH_SIDES', lock: 0, dropcapstyle: 'None' };
  }
  function objectSize(width: number, height: number) {
    return el('hp:sz', { width, widthRelTo: 'ABSOLUTE', height, heightRelTo: 'ABSOLUTE', protect: 0 })
      + el('hp:pos', { treatAsChar: 1, affectLSpacing: 0, flowWithText: 1, allowOverlap: 0, holdAnchorAndSO: 0,
        vertRelTo: 'PARA', horzRelTo: 'PARA', vertAlign: 'TOP', horzAlign: 'LEFT', vertOffset: 0, horzOffset: 0 })
      + margin('hp:outMargin', 0);
  }

  function picture(image: EmbeddedImage, availableWidth: number): string {
    // 96 dpi intrinsic dimensions, shrink to fit both page dimensions.
    const ratio = Math.min(75, availableWidth / image.width, CONTENT_HEIGHT / image.height);
    const width = Math.max(1, Math.round(image.width * ratio));
    const height = Math.max(1, Math.round(image.height * ratio));
    const id = objectId++;
    const matrix = { e1: 1, e2: 0, e3: 0, e4: 0, e5: 1, e6: 0 };
    return el('hp:pic', { ...objectAttrs('PICTURE', id), href: '', groupLevel: 0, instid: id, reverse: 0 },
      el('hp:offset', { x: 0, y: 0 })
      + el('hp:orgSz', { width, height }) + el('hp:curSz', { width, height })
      + el('hp:flip', { horizontal: 0, vertical: 0 })
      + el('hp:rotationInfo', { angle: 0, centerX: Math.round(width / 2), centerY: Math.round(height / 2), rotateimage: 1 })
      + el('hp:renderingInfo', {}, el('hc:transMatrix', matrix) + el('hc:scaMatrix', matrix) + el('hc:rotMatrix', matrix))
      + el('hp:imgRect', {}, el('hc:pt0', { x: 0, y: 0 }) + el('hc:pt1', { x: width, y: 0 })
        + el('hc:pt2', { x: width, y: height }) + el('hc:pt3', { x: 0, y: height }))
      + el('hp:imgClip', { left: 0, right: width, top: 0, bottom: height })
      + margin('hp:inMargin', 0)
      + el('hc:img', { binaryItemIDRef: image.id, bright: 0, contrast: 0, effect: 'REAL_PIC', alpha: 0 })
      + el('hp:imgDim', { dimwidth: width, dimheight: height })
      + el('hp:effects') + objectSize(width, height) + el('hp:shapeComment', {}, escapeXml(image.alt || '이미지')));
  }

  function inlines(content: Inline[], charPrId: number, width: number): string {
    return content.length ? content.map(item => el('hp:run', { charPrIDRef: charPrId },
      item.kind === 'text' ? textXml(item.text) : picture(item.image, width))).join('')
      : el('hp:run', { charPrIDRef: charPrId }, textXml(''));
  }

  function paragraph(par: Paragraph, width = CONTENT_WIDTH, objectXml?: string, allowSectionProperties = true): string {
    const id = paragraphId++;
    const paraPrIDRef = shapeId(par);
    const styleIDRef = par.heading || (par.code ? 7 : par.quote ? 8 : 0);
    const charPrId = par.heading || (par.code ? 7 : 0);
    let prefix = '';
    if (allowSectionProperties && !sectionPropertiesWritten) {
      sectionPropertiesWritten = true;
      prefix = el('hp:run', { charPrIDRef: 0 }, sectionProperties());
    }
    return el('hp:p', { id, paraPrIDRef, styleIDRef, pageBreak: 0, columnBreak: 0, merged: 0 },
      prefix + (objectXml ? el('hp:run', { charPrIDRef: 0 }, objectXml) : inlines(par.content, charPrId, width)));
  }

  function table(table: Table): string {
    const columns = Math.max(...table.rows.map(row => row.length), 1);
    const columnWidth = Math.floor(CONTENT_WIDTH / columns);
    const id = objectId++;
    // Serialize nested cell paragraphs without stealing the document's secPr.
    const rows = table.rows.map((row, rowAddr) => el('hp:tr', {}, Array.from({ length: columns }, (_, colAddr) => {
      const width = colAddr === columns - 1 ? CONTENT_WIDTH - columnWidth * colAddr : columnWidth;
      return el('hp:tc', { name: '', header: rowAddr === 0 ? 1 : 0, hasMargin: 0, protect: 0, editable: 0, dirty: 0, borderFillIDRef: 2 },
        el('hp:subList', { id: '', textDirection: 'HORIZONTAL', lineWrap: 'BREAK', vertAlign: 'CENTER', linkListIDRef: 0,
          linkListNextIDRef: 0, textWidth: Math.max(1, width - 282), textHeight: 1200, hasTextRef: 0, hasNumRef: 0 },
        paragraph({ kind: 'paragraph', content: row[colAddr] ?? [] }, Math.max(1, width - 282), undefined, false))
        + el('hp:cellAddr', { colAddr, rowAddr }) + el('hp:cellSpan', { colSpan: 1, rowSpan: 1 })
        + el('hp:cellSz', { width, height: 1600 }) + margin('hp:cellMargin', 141));
    }).join(''))).join('');
    const xml = el('hp:tbl', { ...objectAttrs('TABLE', id), pageBreak: 'CELL', repeatHeader: 1,
      rowCnt: table.rows.length, colCnt: columns, cellSpacing: 0, borderFillIDRef: 2, noAdjust: 0 },
    objectSize(CONTENT_WIDTH, table.rows.length * 1600) + margin('hp:inMargin', 141) + rows);
    return paragraph({ kind: 'paragraph', content: [] }, CONTENT_WIDTH, xml);
  }

  const body = document.blocks.map(block => block.kind === 'table' ? table(block) : paragraph(block)).join('');
  const section = XML + el('hs:sec', namespaces, body);

  function charProperty(id: number): string {
    const heights = [1000, 2400, 2000, 1600, 1400, 1200, 1100, 900];
    const values = (n: number) => Object.fromEntries(scripts.map(script => [script, n]));
    return el('hh:charPr', { id, height: heights[id], textColor: '#000000', shadeColor: 'none', useFontSpace: 0, useKerning: 0,
      symMark: 'NONE', borderFillIDRef: 1 },
    el('hh:fontRef', values(id === 7 ? 1 : 0)) + el('hh:ratio', values(100))
      + el('hh:spacing', values(0)) + el('hh:relSz', values(100)) + el('hh:offset', values(0))
      + (id >= 1 && id <= 6 ? el('hh:bold') : '')
      + el('hh:underline', { type: 'NONE', shape: 'SOLID', color: '#000000' })
      + el('hh:strikeout', { shape: 'NONE', color: '#000000' })
      + el('hh:outline', { type: 'NONE' }) + el('hh:shadow', { type: 'NONE', color: '#B2B2B2', offsetX: 10, offsetY: 10 }));
  }

  function paraProperty(shape: ParaShape, id: number): string {
    const indentation = shape.quote * 2000 + (shape.list ? (shape.list.level + 1) * 1400 : 0);
    const heading = shape.list ? { type: shape.list.ordered ? 'NUMBER' : 'BULLET', idRef: shape.list.ordered ? shape.list.numbering : 1,
      level: shape.list.level } : { type: 'NONE', idRef: 0, level: 0 };
    const length = (name: string, value: number) => el(`hc:${name}`, { value, unit: 'HWPUNIT' });
    return el('hh:paraPr', { id, tabPrIDRef: 0, condense: 0, fontLineHeight: 0, snapToGrid: 1, suppressLineNumbers: 0, checked: 0 },
      el('hh:align', { horizontal: 'LEFT', vertical: 'BASELINE' }) + el('hh:heading', heading)
      + el('hh:breakSetting', { breakLatinWord: 'KEEP_WORD', breakNonLatinWord: 'KEEP_WORD', widowOrphan: 0,
        keepWithNext: shape.heading ? 1 : 0, keepLines: 0, pageBreakBefore: 0, lineWrap: 'BREAK' })
      + el('hh:autoSpacing', { eAsianEng: 0, eAsianNum: 0 })
      + el('hh:margin', {}, length('intent', shape.list ? -700 : 0) + length('left', indentation) + length('right', 0)
        + length('prev', shape.heading ? 800 : 0) + length('next', 400))
      + el('hh:lineSpacing', { type: 'PERCENT', value: 160, unit: 'HWPUNIT' })
      + el('hh:border', { borderFillIDRef: 1, offsetLeft: 0, offsetRight: 0, offsetTop: 0, offsetBottom: 0, connect: 0, ignoreMargin: 0 }));
  }

  const fontfaces = el('hh:fontfaces', { itemCnt: 7 },
    ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'].map(lang => el('hh:fontface', { lang, fontCnt: 2 },
      el('hh:font', { id: 0, face: '함초롬바탕', type: 'TTF', isEmbedded: 0 })
      + el('hh:font', { id: 1, face: 'D2Coding', type: 'TTF', isEmbedded: 0 }))).join(''));
  const borderFills = el('hh:borderFills', { itemCnt: 2 }, [1, 2].map(id => el('hh:borderFill', {
    id, threeD: 0, shadow: 0, centerLine: 'NONE', breakCellSeparateLine: 0 },
  el('hh:slash', { type: 'NONE', Crooked: 0, isCounter: 0 }) + el('hh:backSlash', { type: 'NONE', Crooked: 0, isCounter: 0 })
    + ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder', 'diagonal'].map(side => el(`hh:${side}`, {
      type: id === 2 && side !== 'diagonal' ? 'SOLID' : 'NONE', width: '0.1 mm', color: '#000000' })).join(''))).join(''));
  const starts = document.numberings.length ? document.numberings : [1];
  const numbering = el('hh:numberings', { itemCnt: starts.length }, starts.map((start, index) => el('hh:numbering', { id: index + 1, start },
    Array.from({ length: 7 }, (_, level) => el('hh:paraHead', { level: level + 1, align: 'LEFT', useInstWidth: 1, autoIndent: 1,
      widthAdjust: 0, textOffsetType: 'PERCENT', textOffset: 50, numFormat: 'DIGIT', charPrIDRef: 0, checkable: 0, start },
    escapeXml(`^${level + 1}.`))).join(''))).join(''));
  const bullets = el('hh:bullets', { itemCnt: 1 }, el('hh:bullet', { id: 1, char: '•', useImage: 0 },
    el('hh:paraHead', { level: 0, align: 'LEFT', useInstWidth: 1, autoIndent: 1, widthAdjust: 0,
      textOffsetType: 'PERCENT', textOffset: 50, numFormat: 'DIGIT', charPrIDRef: 0, checkable: 0 })));
  const styles = el('hh:styles', { itemCnt: 9 }, Array.from({ length: 9 }, (_, id) => el('hh:style', {
    id, type: 'PARA', name: id >= 1 && id <= 6 ? `제목 ${id}` : id === 7 ? '코드' : id === 8 ? '인용' : '바탕글',
    engName: id >= 1 && id <= 6 ? `Heading ${id}` : id === 7 ? 'Code' : id === 8 ? 'Quote' : 'Normal',
    paraPrIDRef: id, charPrIDRef: id <= 7 ? id : 0, nextStyleIDRef: 0, langID: 1042, lockForm: 0,
  })).join(''));
  const header = XML + el('hh:head', { ...namespaces, version: '1.4', secCnt: 1 },
    el('hh:beginNum', { page: 1, footnote: 1, endnote: 1, pic: 1, tbl: 1, equation: 1 })
      + el('hh:refList', {}, fontfaces + borderFills
        + el('hh:charProperties', { itemCnt: 8 }, Array.from({ length: 8 }, (_, id) => charProperty(id)).join(''))
        + el('hh:tabProperties', { itemCnt: 1 }, el('hh:tabPr', { id: 0, autoTabLeft: 0, autoTabRight: 0 }))
        + numbering + bullets
        + el('hh:paraProperties', { itemCnt: shapes.length }, shapes.map(paraProperty).join('')) + styles)
      + el('hh:compatibleDocument', { targetProgram: 'HWP201X' }, el('hh:layoutCompatibility'))
      + el('hh:docOption', {}, el('hh:linkinfo', { path: '', pageInherit: 0, footnoteInherit: 0 })));
  return { header, section };
}

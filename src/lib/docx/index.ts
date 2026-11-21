import JSZip from 'jszip';
import { Lexer, type Token, type Tokens } from 'marked';
import { createImageLoader } from '@/lib/hwp/generate/images';
import { XML, element as el, escapeXml, cleanXml } from '@/lib/hwp/generate/xml';
import type { ExportWarning, GenerateResult, ResolveImage, EmbeddedImage } from '@/lib/hwp/generate/types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const ns = { 'xmlns:w': W, 'xmlns:r': R };
type Format = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: boolean };

export async function generateDocx(markdown: string, resolveImage?: ResolveImage): Promise<GenerateResult> {
  const warnings: ExportWarning[] = [];
  const loader = createImageLoader(resolveImage, warnings);
  const relationships: string[] = [];
  const numbers: { id: number; start: number }[] = [];
  let relationship = 0; let drawing = 0;
  const warn = (code: ExportWarning['code'], detail: string) => { const w = warnings.find(x => x.code === code && x.detail === detail); if (w) w.count++; else warnings.push({ code, detail, count: 1 }); };
  const rel = (type: string, target: string, external = false) => {
    const id = `rId${++relationship}`;
    relationships.push(el('Relationship', { Id: id, Type: `${R}/${type}`, Target: target, ...(external ? { TargetMode: 'External' } : {}) }));
    return id;
  };
  const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? cleanXml(String.fromCodePoint(n)) : '�'; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' } as Record<string, string>)[e.toLowerCase()] ?? m;
  });
  const run = (text: string, f: Format = {}) => {
    const props = (f.link ? el('w:rStyle', { 'w:val': 'Hyperlink' }) : f.code ? el('w:rStyle', { 'w:val': 'CodeChar' }) : '')
      + (f.bold ? el('w:b') : '') + (f.italic ? el('w:i') : '') + (f.strike ? el('w:strike') : '');
    const body = text.split(/([\n\t])/).map(s => s === '\n' ? el('w:br') : s === '\t' ? el('w:tab') : s ? el('w:t', { 'xml:space': 'preserve' }, escapeXml(s)) : '').join('');
    return el('w:r', {}, (props ? el('w:rPr', {}, props) : '') + body);
  };
  const link = (url: string, content: string) => /^(?:https?:|mailto:|\/\/)/i.test(url) ? el('w:hyperlink', { 'r:id': rel('hyperlink', url, true) }, content) : content;
  const imageXml = (img: EmbeddedImage) => {
    const ext = img.path.split('.').pop()!; const id = rel('image', `media/${img.id}.${ext}`);
    const scale = Math.min(1, 5753100 / (img.width * 9525)); const cx = Math.round(img.width * 9525 * scale); const cy = Math.round(img.height * 9525 * scale);
    const n = ++drawing;
    return `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${escapeXml(img.alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${escapeXml(img.id)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  async function inline(tokens: Token[], f: Format = {}): Promise<string> {
    let out = '';
    for (const t of tokens) {
      if (t.type === 'strong' || t.type === 'em' || t.type === 'del') out += await inline(t.tokens ?? [], { ...f, [t.type === 'strong' ? 'bold' : t.type === 'em' ? 'italic' : 'strike']: true });
      else if (t.type === 'link') out += link(t.href, await inline(t.tokens ?? [], { ...f, link: /^(?:https?:|mailto:|\/\/)/i.test(t.href) }));
      else if (t.type === 'image') {
        const url = decode(t.href); const alt = decode(t.text);
        if (/^(?:https?:|\/\/)/i.test(url.trim())) { warn('image-remote', '원격 그림은 링크로 남겼습니다.'); out += link(url, run(alt || url, { ...f, link: true })); }
        else { const img = await loader.load(url, alt); out += img ? imageXml(img) : run(`[그림: ${alt}]`, f); }
      } else if (t.type === 'br') out += el('w:r', {}, el('w:br'));
      else if (t.type === 'codespan') out += run(t.text, { ...f, code: true });
      else if (t.type === 'text' && t.tokens) out += await inline(t.tokens, f);
      else if (t.type === 'html') { warn('unsupported-markdown', 'HTML을 글자로 보존했습니다.'); out += run(t.raw, f); }
      else out += run(decode('text' in t && typeof t.text === 'string' ? t.text : t.raw), f);
    }
    return out;
  }
  const paragraph = (content: string, opts: { style?: string; num?: number; level?: number; quote?: number; align?: string; hr?: boolean; task?: boolean } = {}) => {
    const p = (opts.style ? el('w:pStyle', { 'w:val': opts.style }) : '')
      + (opts.num ? el('w:numPr', {}, el('w:ilvl', { 'w:val': opts.level ?? 0 }) + el('w:numId', { 'w:val': opts.num })) : '')
      + (opts.hr ? el('w:pBdr', {}, el('w:bottom', { 'w:val': 'single', 'w:sz': 6, 'w:space': 1, 'w:color': 'auto' })) : '')
      + (opts.quote || opts.task ? el('w:ind', { 'w:left': opts.task ? 720 * ((opts.level ?? 0) + 1) : 720 * (opts.quote ?? 1) }) : '')
      + (opts.align ? el('w:jc', { 'w:val': opts.align }) : '');
    return el('w:p', {}, (p ? el('w:pPr', {}, p) : '') + content);
  };
  async function blocks(tokens: Token[], quote = 0, depth = 0): Promise<string> {
    let out = '';
    for (const t of tokens) {
      if (t.type === 'space' || t.type === 'def') continue;
      if (t.type === 'heading') out += paragraph(await inline(t.tokens ?? []), { style: `Heading${t.depth}` });
      else if (t.type === 'paragraph' || t.type === 'text') out += paragraph(await inline(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text }]), { style: quote ? 'Quote' : undefined, quote });
      else if (t.type === 'blockquote') out += await blocks(t.tokens ?? [], quote + 1, depth);
      else if (t.type === 'code') for (const line of t.text.split('\n')) out += paragraph(run(line), { style: 'Code', quote });
      else if (t.type === 'hr') out += paragraph('', { hr: true });
      else if (t.type === 'list') {
        const list = t as Tokens.List; const num = list.ordered ? numbers.length + 2 : 1;
        if (list.ordered) numbers.push({ id: num, start: typeof list.start === 'number' ? list.start : 1 });
        if (depth > 8) warn('list-level-simplified', '목록 깊이를 9단계로 줄였습니다.');
        for (const item of list.items) {
          const children = [...item.tokens]; const first = children[0];
          const text = first && (first.type === 'text' || first.type === 'paragraph') ? (children.shift(), await inline(first.tokens ?? [])) : '';
          out += paragraph((item.task ? run(item.checked ? '☑ ' : '☐ ') : '') + text, { style: 'ListParagraph', num: item.task ? undefined : num, level: Math.min(depth, 8), task: item.task });
          out += await blocks(children, quote, depth + 1);
        }
      } else if (t.type === 'table') {
        const table = t as Tokens.Table; const rows = [table.header, ...table.rows];
        let body = '';
        for (let i = 0; i < rows.length; i++) {
          let cells = '';
          for (let j = 0; j < table.header.length; j++) {
            const cell = rows[i][j]; const content = cell ? await inline(cell.tokens, { bold: i === 0 }) : '';
            cells += el('w:tc', {}, paragraph(content, { align: table.align[j] || undefined }));
          }
          body += el('w:tr', {}, (i === 0 ? el('w:trPr', {}, el('w:tblHeader')) : '') + cells);
        }
        out += el('w:tbl', {}, el('w:tblPr', {}, el('w:tblStyle', { 'w:val': 'TableGrid' }) + el('w:tblW', { 'w:w': 0, 'w:type': 'auto' })) + el('w:tblGrid', {}, table.header.map(() => el('w:gridCol', { 'w:w': 2400 })).join('')) + body);
      } else { warn('unsupported-markdown', '지원하지 않는 서식을 글자로 보존했습니다.'); out += paragraph(run(t.raw)); }
    }
    return out;
  }
  const body = await blocks(new Lexer({ gfm: true }).lex(cleanXml(markdown)));
  const document = XML + el('w:document', { ...ns, 'xmlns:wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'xmlns:pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture' }, el('w:body', {}, body + el('w:sectPr', {}, el('w:pgSz', { 'w:w': 11906, 'w:h': 16838 }) + el('w:pgMar', { 'w:top': 1440, 'w:right': 1440, 'w:bottom': 1440, 'w:left': 1440, 'w:header': 720, 'w:footer': 720, 'w:gutter': 0 }))));
  const style = (id: string, name: string, type = 'paragraph', extra = '') => el('w:style', { 'w:type': type, 'w:styleId': id, ...(id === 'Normal' ? { 'w:default': 1 } : {}) }, el('w:name', { 'w:val': name }) + (id !== 'Normal' && type === 'paragraph' ? el('w:basedOn', { 'w:val': 'Normal' }) : '') + extra);
  const styles = XML + el('w:styles', ns, style('Normal', 'Normal', 'paragraph', el('w:rPr', {}, el('w:rFonts', { 'w:ascii': 'Calibri', 'w:hAnsi': 'Calibri', 'w:eastAsia': '맑은 고딕' })))
    + Array.from({ length: 6 }, (_, i) => style(`Heading${i + 1}`, `heading ${i + 1}`, 'paragraph', el('w:pPr', {}, el('w:outlineLvl', { 'w:val': i })))).join('')
    + style('Quote', 'Quote', 'paragraph', el('w:pPr', {}, el('w:pBdr', {}, el('w:left', { 'w:val': 'single', 'w:sz': 8, 'w:space': 6, 'w:color': '999999' })) + el('w:ind', { 'w:left': 720 })))
    + style('Code', 'Code', 'paragraph', el('w:pPr', {}, el('w:shd', { 'w:fill': 'EEEEEE' })) + el('w:rPr', {}, el('w:rFonts', { 'w:ascii': 'Menlo', 'w:hAnsi': 'Menlo' })))
    + style('CodeChar', 'Code Char', 'character', el('w:rPr', {}, el('w:rFonts', { 'w:ascii': 'Menlo', 'w:hAnsi': 'Menlo' })))
    + style('Hyperlink', 'Hyperlink', 'character', el('w:rPr', {}, el('w:color', { 'w:val': '0563C1' }) + el('w:u', { 'w:val': 'single' }))) + style('ListParagraph', 'List Paragraph')
    + style('TableGrid', 'Table Grid', 'table', el('w:tblPr', {}, el('w:tblBorders', {}, ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(n => el(`w:${n}`, { 'w:val': 'single', 'w:sz': 4, 'w:color': 'auto' })).join('')))));
  const abstract = (id: number, ordered: boolean) => el('w:abstractNum', { 'w:abstractNumId': id }, el('w:multiLevelType', { 'w:val': 'multilevel' }) + Array.from({ length: 9 }, (_, i) => el('w:lvl', { 'w:ilvl': i }, el('w:start', { 'w:val': 1 }) + el('w:numFmt', { 'w:val': ordered ? 'decimal' : 'bullet' }) + el('w:lvlText', { 'w:val': ordered ? `%${i + 1}.` : '•' }) + el('w:lvlJc', { 'w:val': 'left' }) + el('w:pPr', {}, el('w:ind', { 'w:left': 720 * (i + 1), 'w:hanging': 360 })))).join(''));
  const numbering = XML + el('w:numbering', ns, abstract(0, false) + abstract(1, true) + el('w:num', { 'w:numId': 1 }, el('w:abstractNumId', { 'w:val': 0 })) + numbers.map(n => el('w:num', { 'w:numId': n.id }, el('w:abstractNumId', { 'w:val': 1 }) + Array.from({ length: 9 }, (_, i) => el('w:lvlOverride', { 'w:ilvl': i }, el('w:startOverride', { 'w:val': n.start }))).join(''))).join(''));
  rel('styles', 'styles.xml'); rel('numbering', 'numbering.xml');
  const zip = new JSZip(); const date = new Date(1980, 0, 1); const add = (name: string, value: string | Uint8Array) => zip.file(name, value, { date, createFolders: false });
  add('[Content_Types].xml', XML + el('Types', { xmlns: CT }, el('Default', { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' }) + el('Default', { Extension: 'xml', ContentType: 'application/xml' }) + [...new Map(loader.images.map(i => [i.path.split('.').pop()!, i.mimeType])).entries()].map(([ext, mime]) => el('Default', { Extension: ext, ContentType: mime })).join('') + ['document', 'styles', 'numbering'].map(n => el('Override', { PartName: `/word/${n}.xml`, ContentType: `application/vnd.openxmlformats-officedocument.wordprocessingml.${n === 'document' ? 'document.main' : n}+xml` })).join('')));
  add('_rels/.rels', XML + el('Relationships', { xmlns: REL }, el('Relationship', { Id: 'rId1', Type: `${R}/officeDocument`, Target: 'word/document.xml' })));
  add('word/document.xml', document); add('word/styles.xml', styles); add('word/numbering.xml', numbering);
  add('word/_rels/document.xml.rels', XML + el('Relationships', { xmlns: REL }, relationships.join('')));
  for (const img of loader.images) add(`word/media/${img.id}.${img.path.split('.').pop()}`, img.bytes);
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'DOS' }), warnings };
}
export function summarizeDocxWarnings(warnings: ExportWarning[]): string {
  const count = (codes: string[]) => warnings.filter(w => codes.includes(w.code)).reduce((n, w) => n + w.count, 0);
  const images = count(['image-missing', 'image-format', 'image-limit']); const remote = count(['image-remote']);
  const other = warnings.reduce((n, w) => n + w.count, 0) - images - remote;
  return [images && `그림 ${images}개 제외`, remote && `원격 그림 ${remote}개는 링크로`, other && `서식 단순화 ${other}건`].filter(Boolean).join(' · ');
}

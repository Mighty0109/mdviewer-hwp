import { Lexer, type Token, type Tokens } from 'marked';
import { createImageLoader } from './images';
import type { Block, ExportDocument, ExportWarning, Inline, Paragraph, ResolveImage } from './types';
import { cleanXml } from './xml';

// Deliberately independent of DOMParser: this module also runs in a Web Worker.
const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', bull: '•', laquo: '«', raquo: '»', euro: '€', pound: '£',
  yen: '¥', cent: '¢', times: '×', divide: '÷', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export async function parseMarkdown(markdown: string, resolveImage?: ResolveImage): Promise<ExportDocument> {
  const warnings: ExportWarning[] = [];
  function warn(code: ExportWarning['code'], detail: string, count = 1) {
    const existing = warnings.find(w => w.code === code && w.detail === detail);
    if (existing) existing.count += count; else warnings.push({ code, count, detail });
  }
  let simplified = false;
  const normalized = cleanXml(markdown);
  if (normalized !== markdown) warn('xml-character-replaced', 'XML에 쓸 수 없는 문자를 �로 바꿨습니다.',
    Array.from(markdown).filter(char => cleanXml(char) !== char).length);
  const loader = createImageLoader(resolveImage, warnings);
  const numberings: number[] = [];

  function decode(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        const decoded = n > 0 && n <= 0x10ffff ? cleanXml(String.fromCodePoint(n)) : '\ufffd';
        if (decoded === '\ufffd') warn('xml-character-replaced', 'XML에 쓸 수 없는 문자 참조를 �로 바꿨습니다.');
        return decoded;
      }
      if (entities[entity] !== undefined) return entities[entity];
      warn('unsupported-markdown', '일부 HTML 문자 참조를 원문 표기로 보존했습니다.');
      return whole;
    });
  }

  async function inline(tokens: Token[]): Promise<Inline[]> {
    const result: Inline[] = [];
    const text = (value: string) => {
      const last = result[result.length - 1];
      if (last?.kind === 'text') last.text += value;
      else result.push({ kind: 'text', text: value });
    };
    for (const token of tokens) {
      switch (token.type) {
        case 'image': {
          const imageToken = token as Tokens.Image;
          const alt = decode(imageToken.text);
          const image = await loader.load(decode(imageToken.href), alt);
          if (image) result.push({ kind: 'image', image });
          else text(`[이미지 제외${alt ? `: ${alt}` : ''}]`);
          break;
        }
        case 'strong': case 'em': case 'del': case 'link':
          simplified = true;
          result.push(...await inline(token.tokens ?? []));
          break;
        case 'codespan':
          simplified = true;
          text((token as Tokens.Codespan).text);
          break;
        case 'br': text('\n'); break;
        case 'html': {
          const html = (token as Tokens.HTML).text;
          if (/^<br\s*\/?\s*>$/i.test(html)) text('\n');
          else {
            warn('unsupported-markdown', '원시 HTML은 실행하지 않고 원문 텍스트로 보존했습니다.');
            text(html);
          }
          break;
        }
        case 'escape': text((token as Tokens.Escape).text); break;
        case 'text':
          if (token.tokens) result.push(...await inline(token.tokens));
          else text(decode((token as Tokens.Text).text));
          break;
        default:
          warn('unsupported-markdown', '지원하지 않는 마크다운은 원문 텍스트로 보존했습니다.');
          text(token.raw);
      }
    }
    return result;
  }

  async function blocks(tokens: Token[], quote = 0, depth = 0): Promise<Block[]> {
    const result: Block[] = [];
    for (const token of tokens) {
      switch (token.type) {
        case 'space': case 'def': break;
        case 'heading':
          result.push({ kind: 'paragraph', content: await inline(token.tokens ?? []), heading: (token as Tokens.Heading).depth, quote });
          break;
        case 'text': case 'paragraph':
          result.push({ kind: 'paragraph', content: await inline(token.tokens ?? [{ type: 'text', raw: token.raw, text: token.text }]), quote });
          break;
        case 'blockquote':
          result.push(...await blocks((token as Tokens.Blockquote).tokens, quote + 1, depth));
          break;
        case 'code':
          result.push({ kind: 'paragraph', code: true, quote, content: [{ kind: 'text', text: (token as Tokens.Code).text }] });
          break;
        case 'hr':
          result.push({ kind: 'paragraph', content: [{ kind: 'text', text: '────────────────' }], quote });
          break;
        case 'list': {
          const list = token as Tokens.List;
          const numbering = list.ordered ? numberings.push(typeof list.start === 'number' ? list.start : 1) : 0;
          if (depth > 6) warn('list-level-simplified', '7단계를 넘는 목록 들여쓰기를 7단계로 줄였습니다.');
          for (const item of list.items) {
            const children = await blocks(item.tokens, quote, depth + 1);
            let first = children.find(block => block.kind === 'paragraph' && !block.list) as Paragraph | undefined;
            if (!first || children[0] !== first) {
              first = { kind: 'paragraph', content: [], quote };
              children.unshift(first);
            }
            first.list = { ordered: list.ordered, level: Math.min(depth, 6), numbering };
            if (item.task) first.content.unshift({ kind: 'text', text: item.checked ? '[x] ' : '[ ] ' });
            result.push(...children);
          }
          break;
        }
        case 'table': {
          const table = token as Tokens.Table;
          const rows: Inline[][][] = [];
          for (const row of [table.header, ...table.rows]) {
            const cells: Inline[][] = [];
            for (const cell of row) cells.push(await inline(cell.tokens));
            rows.push(cells);
          }
          result.push({ kind: 'table', rows });
          break;
        }
        default:
          warn('unsupported-markdown', '지원하지 않는 마크다운은 원문 텍스트로 보존했습니다.');
          result.push({ kind: 'paragraph', content: [{ kind: 'text', text: token.raw }], quote });
      }
    }
    return result;
  }

  const parsed = await blocks(new Lexer({ gfm: true }).lex(normalized));
  if (simplified) warnings.push({ code: 'inline-format-simplified', count: 1,
    detail: '굵게·기울임·취소선·링크·인라인 코드의 텍스트는 보존하고 인라인 서식은 단순화했습니다.' });
  if (!parsed.length) parsed.push({ kind: 'paragraph', content: [] });
  return { blocks: parsed, images: loader.images, numberings, warnings };
}

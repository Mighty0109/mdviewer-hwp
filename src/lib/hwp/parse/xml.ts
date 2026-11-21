import { HwpImportError } from '@/domain/hwp-warnings';
export const NS = {
  paragraph: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  section: 'http://www.hancom.co.kr/hwpml/2011/section',
  head: 'http://www.hancom.co.kr/hwpml/2011/head',
  core: 'http://www.hancom.co.kr/hwpml/2011/core',
  opf: 'http://www.idpf.org/2007/opf',
};
export interface XmlElement { name: string; local: string; ns: string; attrs: Record<string, string>; children: (XmlElement | string)[] }
function corrupt(): never { throw new HwpImportError('corrupt', '올바르지 않은 XML 문서입니다.'); }
function decode(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) corrupt();
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (predefined[entity]) return predefined[entity];
    const n = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) corrupt();
    return String.fromCodePoint(n);
  });
}
/** Bounded, non-validating XML 1.0 subset. No DOM globals, DTD, entities, or I/O in Workers. */
export function parseXml(xml: string): XmlElement {
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY') || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml)) corrupt();
  const roots: XmlElement[] = []; const stack: { node: XmlElement; bindings: Record<string, string> }[] = [];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+/g;
  let offset = 0; let count = 0;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== offset || ++count > 1_000_000) corrupt();
    const token = match[0]; offset += token.length;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (!token.startsWith('<') || token.startsWith('<![CDATA[')) {
      const text = token.startsWith('<![CDATA[') ? token.slice(9, -3) : decode(token);
      if (stack.length) stack[stack.length - 1].node.children.push(text); else if (text.trim()) corrupt();
      continue;
    }
    if (token.startsWith('</')) {
      if (!/^<\/[\w:.-]+\s*>$/.test(token) || stack.pop()?.node.name !== token.slice(2, -1).trim()) corrupt();
      continue;
    }
    const start = /^<([\w:.-]+)/.exec(token); if (!start) corrupt();
    const name = start[1]; const attrs: Record<string, string> = Object.create(null);
    let rest = token.slice(start[0].length).replace(/\/?\s*>$/, '');
    while (rest.trim()) {
      const attr = /^\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
      if (!attr || Object.hasOwn(attrs, attr[1])) corrupt();
      attrs[attr[1]] = decode(attr[2] ?? attr[3]); rest = rest.slice(attr[0].length);
    }
    const bindings: Record<string, string> = { ...(stack.at(-1)?.bindings || {}), xml: 'http://www.w3.org/XML/1998/namespace' };
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'xmlns') bindings[''] = value; else if (key.startsWith('xmlns:')) bindings[key.slice(6)] = value;
    }
    const parts = name.split(':'); if (parts.length > 2 || (parts.length === 2 && !bindings[parts[0]])) corrupt();
    const node: XmlElement = { name, local: parts.at(-1)!, ns: bindings[parts.length === 2 ? parts[0] : ''] || '', attrs, children: [] };
    if (stack.length) stack.at(-1)!.node.children.push(node); else roots.push(node);
    if (!/\/\s*>$/.test(token)) { stack.push({ node, bindings }); if (stack.length > 128) corrupt(); }
  }
  if (offset !== xml.length || stack.length || roots.length !== 1) corrupt();
  return roots[0];
}
export function elements(node: XmlElement): XmlElement[] { return node.children.filter((n): n is XmlElement => typeof n !== 'string'); }
export function descendants(node: XmlElement, local: string, ns?: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (const child of elements(node)) {
    if (child.local === local && (ns === undefined || child.ns === ns)) result.push(child);
    result.push(...descendants(child, local, ns));
  }
  return result;
}
export function xmlText(node: XmlElement): string { return node.children.map(c => typeof c === 'string' ? c : xmlText(c)).join(''); }

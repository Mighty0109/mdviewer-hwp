import * as CFB from 'cfb';
import pako from 'pako';
import JSZip from 'jszip';
import { NS } from '../xml';
export const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==', 'base64'));
export const secondPng = new Uint8Array([...png, 42]);
export const concat = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0)); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
};
export const word = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255);
export const dword = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);
export const utf16 = (s: string) => Uint8Array.from(Buffer.from(s, 'utf16le'));
export const hwpString = (s: string) => concat(word(s.length), utf16(s));
export const record = (tag: number, level: number, data: Uint8Array) => concat(dword(tag | level << 10 | (data.length < 4095 ? data.length : 4095) << 20), ...(data.length < 4095 ? [] : [dword(data.length)]), data);
export function para(text: string, level = 0, style = 0, shape = 0): Uint8Array {
  const header = new Uint8Array(22); header.set(dword(text.length), 0); header.set(word(shape), 8); header[10] = style;
  return concat(record(66, level, header), record(67, level + 1, utf16(text + '\r')));
}
export function control(id: string, contents: Uint8Array, level = 0): Uint8Array {
  const header = new Uint8Array(22); const marker = concat(word(11), new Uint8Array(12), word(11));
  return concat(record(66, level, header), record(67, level + 1, concat(marker, word(13))),
    record(71, level + 1, Uint8Array.from([...id.padEnd(4)].reverse().map(c => c.charCodeAt(0)))), contents);
}
export const picture = (id: number, level = 0, tag = 85): Uint8Array => {
  const data = new Uint8Array(73); data.set(word(id), 71);
  return control('gso', record(tag, level + 2, data), level);
};
export function binaryTable(merged = false, nested = false, level = 0, captions: string[] = []): Uint8Array {
  const table = new Uint8Array(22); table.set(word(2), 4); table.set(word(2), 6);
  const cells: Uint8Array[] = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    if (merged && r === 0 && c === 1) continue;
    const cell = new Uint8Array(30); cell.set(word(c), 8); cell.set(word(r), 10); cell.set(word(merged && r === 0 ? 2 : 1), 12); cell.set(word(1), 14);
    cells.push(record(72, level + 2, cell), para(`셀 ${r + 1}-${c + 1}`, level + 3));
    if (nested && r === 0 && c === 0) cells.push(binaryTable(false, false, level + 3));
  }
  const caption = captions.length ? concat(record(72, level + 2, new Uint8Array(22)), ...captions.map(text => para(text, level + 3))) : new Uint8Array();
  return control('tbl', concat(caption, record(77, level + 2, table), ...cells), level);
}
export interface BinaryOptions { flags?: number; body?: Uint8Array; noImage?: boolean; extension?: string; storageId?: number; imageId?: number; imageBytes?: Uint8Array; version?: number }
export function buildHwp(options: BinaryOptions = {}): Uint8Array {
  const flags = options.flags ?? 1; const cfb = CFB.utils.cfb_new(); const header = new Uint8Array(256);
  header.set(new TextEncoder().encode('HWP Document File')); header[35] = options.version ?? 5; header.set(dword(flags), 36);
  CFB.utils.cfb_add(cfb, 'FileHeader', header);
  const zip = (data: Uint8Array) => flags & 1 ? pako.deflateRaw(data) : data;
  const style = (name: string) => record(26, 0, concat(hwpString(name), hwpString(''), new Uint8Array(10)));
  const storageId = options.storageId ?? 10, extension = options.extension ?? 'png';
  const info = concat(record(18, 0, concat(word(1), word(storageId), hwpString(extension))),
    record(25, 0, dword(0)), record(25, 0, dword(2 << 23)), record(25, 0, dword(3 << 23 | 1 << 25)),
    style('바탕글'), style('제목 2'));
  CFB.utils.cfb_add(cfb, 'DocInfo', zip(info));
  const body = options.body ?? concat(para('합성 제목', 0, 1), para('일반 문단 & 한글 😀'), para('번호 항목', 0, 0, 1), para('글머리 항목', 0, 0, 2),
    binaryTable(), picture(options.imageId ?? 1), control('head', para('숨긴 머리글', 2)), control('foot', para('숨긴 꼬리글', 2)),
    control('fn', para('숨긴 각주', 2)), control('en', para('숨긴 미주', 2)), control('gso', para('글상자 내용', 2)),
    binaryTable(true), control('eqed', new Uint8Array()), control('gso', record(79, 2, new Uint8Array(73))), control('xxxx', new Uint8Array()));
  CFB.utils.cfb_add(cfb, 'BodyText/Section0', zip(body));
  if (!options.noImage) CFB.utils.cfb_add(cfb, `BinData/BIN${storageId.toString(16).toUpperCase().padStart(4, '0')}.${extension}`, zip(options.imageBytes ?? png));
  return Uint8Array.from(CFB.write(cfb, { type: 'buffer' }));
}
export const xmlHeader = `xmlns:hp="${NS.paragraph}" xmlns:hs="${NS.section}" xmlns:hh="${NS.head}" xmlns:hc="${NS.core}"`;
export const xp = (text: string, attrs = '') => `<hp:p ${attrs}><hp:run><hp:t>${text}</hp:t></hp:run></hp:p>`;
export const xpic = (ref = 'imageA') => `<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="${ref}"/></hp:pic></hp:run></hp:p>`;
export const xtable = (merged = false, nested = false): string => `<hp:tbl rowCnt="2" colCnt="2">${[0, 1].map(r => `<hp:tr>${[0, 1].filter(c => !(merged && r === 0 && c === 1)).map(c => `<hp:tc><hp:cellAddr rowAddr="${r}" colAddr="${c}"/><hp:cellSpan rowSpan="1" colSpan="${merged && r === 0 ? 2 : 1}"/><hp:subList>${xp(`셀 ${r + 1}-${c + 1}`)}${nested && r === 0 && c === 0 ? `<hp:p><hp:run>${xtable()}</hp:run></hp:p>` : ''}</hp:subList></hp:tc>`).join('')}</hp:tr>`).join('')}</hp:tbl>`;
export interface HwpxOptions { body?: string; header?: string; encrypted?: boolean; imageBytes?: Uint8Array; extra?: Record<string, string | Uint8Array>; prefix?: string }
export async function buildHwpx(options: HwpxOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip(); const date = new Date('2020-01-01T00:00:00Z');
  const put = (name: string, data: string | Uint8Array) => zip.file(name, data, { date, createFolders: false });
  zip.file('mimetype', 'application/hwp+zip', { date, createFolders: false, compression: 'STORE' });
  put('version.xml', '<version/>'); put('META-INF/container.xml', '<container/>');
  put('META-INF/manifest.xml', options.encrypted ? '<manifest><encryption-data/></manifest>' : '<manifest/>');
  put('Contents/content.hpf', `<opf:package xmlns:opf="${NS.opf}"><opf:manifest><opf:item id="imageA" href="../BinData/picture.png"/><opf:item id="s0" href="section0.xml"/></opf:manifest><opf:spine><opf:itemref idref="s0"/></opf:spine></opf:package>`);
  put('Contents/header.xml', options.header ?? `<hh:head ${xmlHeader}><hh:refList><hh:styles><hh:style id="0" name="바탕글"/><hh:style id="1" name="제목 2"/></hh:styles><hh:paraProperties><hh:paraPr id="1"><hh:heading type="NUMBER" level="0"/></hh:paraPr><hh:paraPr id="2"><hh:heading type="BULLET" level="1"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>`);
  let section = `<hs:sec ${xmlHeader}>${options.body ?? [xp('합성 제목', 'styleIDRef="1"'), xp('일반 문단 &amp; 한글 😀'), xp('번호 항목', 'paraPrIDRef="1"'), xp('글머리 항목', 'paraPrIDRef="2"'), `<hp:p><hp:run>${xtable()}</hp:run></hp:p>`, xpic(),
    ...['header', 'footer', 'footNote', 'endNote'].map(tag => `<hp:p><hp:run><hp:ctrl><hp:${tag}>${xp('숨긴 내용')}</hp:${tag}></hp:ctrl></hp:run></hp:p>`),
    `<hp:p><hp:run><hp:rect><hp:subList>${xp('글상자 내용')}</hp:subList></hp:rect></hp:run></hp:p>`, `<hp:p><hp:run>${xtable(true)}<hp:equation/><hp:ellipse/><hp:ole/></hp:run></hp:p>`].join('')}</hs:sec>`;
  if (options.prefix) section = section.replace(/hp:/g, `${options.prefix}:`).replace('xmlns:hp=', `xmlns:${options.prefix}=`);
  put('Contents/section0.xml', section); put('BinData/picture.png', options.imageBytes ?? png);
  for (const [name, data] of Object.entries(options.extra || {})) put(name, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

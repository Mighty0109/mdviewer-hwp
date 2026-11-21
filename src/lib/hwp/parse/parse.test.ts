import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import pako from 'pako';
import { parseHwp } from './index';
import { readRecords } from './binary';
import { inflateBounded } from './archive';
import { parseXml, xmlText } from './xml';
import { buildHwp, buildHwpx, concat, para, picture, binaryTable, png, secondPng, xp, xpic, xtable, dword } from './testing/builders';
import { MAX_HWP_BYTES, MAX_ENTRY_BYTES, MAX_ARCHIVE_ENTRIES } from '@/domain/hwp-warnings';
import { MAX_IMAGE_BYTES } from '@/domain/hwp-assets';
import { ParseContext } from './context';

const codes = ['footnote-skipped', 'textbox-text-only', 'table-raw-html', 'equation-skipped', 'shape-skipped', 'object-skipped'];
describe.each(['hwp', 'hwpx'] as const)('%s import', kind => {
  const make = () => kind === 'hwp' ? Promise.resolve(buildHwp()) : buildHwpx();
  it('imports supported blocks including headers and footers, and records every reduction', async () => {
    const bytes = await make(); const copy = bytes.slice(); const progress: number[] = [];
    const result = await parseHwp(bytes, percent => progress.push(percent));
    expect(result.markdown).toContain('## 합성 제목');
    expect(result.markdown).toContain('1. 번호 항목');
    expect(result.markdown).toContain('  - 글머리 항목');
    expect(result.markdown).toContain('| 셀 1\\-1 | 셀 1\\-2 |');
    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain('mdviewer-import-assets/img-001.png');
    expect(result.markdown).toContain('글상자 내용');
    expect(result.markdown.startsWith(kind === 'hwp' ? '숨긴 머리글' : '숨긴 내용')).toBe(true);
    expect(result.markdown.endsWith(kind === 'hwp' ? '숨긴 꼬리글' : '숨긴 내용')).toBe(true);
    expect(result.markdown).not.toContain('숨긴 각주');
    expect(result.markdown).not.toContain('숨긴 미주');
    expect(result.markdown.match(/숨긴/g)).toHaveLength(2);
    for (const code of codes) expect(result.warnings.some(w => w.code === code), code).toBe(true);
    expect(result.warnings.find(w => w.code === 'footnote-skipped')?.count).toBe(2);
    expect(result.assets[0].bytes).toEqual(png);
    expect(result.stats).toMatchObject({ headings: 1, tables: 2, images: 1, imageReferences: 1, imageMappings: 1 });
    expect(progress[0]).toBe(0); expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); expect(bytes).toEqual(copy);
  });
  it('stores reproducible synthetic fixture bytes', async () => {
    const bytes = await make(); const path = new URL(`../../../../fixtures/hwp/synthetic.${kind}`, import.meta.url);
    if (process.env.UPDATE_FIXTURES === '1') await writeFile(path, bytes);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });
  it('flattens nested tables with an explicit warning', async () => {
    const bytes = kind === 'hwp' ? buildHwp({ body: binaryTable(false, true) }) : await buildHwpx({ body: `<hp:p><hp:run>${xtable(false, true)}</hp:run></hp:p>` });
    const result = await parseHwp(bytes);
    expect(result.warnings).toContainEqual({ code: 'table-nested-flattened', count: 1 });
    expect(result.stats.tables).toBe(2);
  });
  it('warns and leaves a placeholder for missing and oversized images', async () => {
    const missing = kind === 'hwp' ? buildHwp({ noImage: true, body: picture(1) }) : await buildHwpx({ body: xpic('absent') });
    const result = await parseHwp(missing);
    expect(result.warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'missing' });
    expect(result.markdown).toContain('이미지 1 제외: missing'); expect(result.assets).toEqual([]);
    const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const large = kind === 'hwp' ? buildHwp({ imageBytes: bytes, body: picture(1) }) : await buildHwpx({ imageBytes: bytes, body: xpic() });
    expect((await parseHwp(large)).warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'size' });
  });
});

describe('binary HWP mapping and rejection', () => {
  it('uses tag 85, offset 71, DocInfo storage IDs, and hexadecimal BIN000A rather than ordinal fallback', async () => {
    const result = await parseHwp(buildHwp({ body: concat(picture(1), picture(1), picture(10), picture(1, 0, 79)), storageId: 10 }));
    expect(result.assets).toHaveLength(1); expect(result.assets[0].bytes).toEqual(png);
    expect(result.stats).toMatchObject({ images: 2, imageReferences: 3, imageMappings: 2, skippedImages: 1 });
    expect(result.warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'missing' });
    expect(result.warnings).toContainEqual({ code: 'shape-skipped', count: 1 });
  });
  it.each([2, 4, 16])('rejects protected FileHeader flags %i', async flag => {
    await expect(parseHwp(buildHwp({ flags: flag }))).rejects.toMatchObject({ code: flag === 2 ? 'encrypted' : 'drm-distribution' });
  });
  it('rejects directory graph cycles before the CFB library follows them', async () => {
    const bytes = buildHwp(); const v = new DataView(bytes.buffer);
    const directoryStart = (v.getUint32(48, true) + 1) * 512;
    v.setUint32(directoryStart + 76, 0, true);
    await expect(parseHwp(bytes)).rejects.toMatchObject({ code: 'corrupt' });
  });
  it('rejects cyclic FAT pointers and forged CFB stream sizes', async () => {
    const bytes = buildHwp(); const v = new DataView(bytes.buffer);
    const fatStart = (v.getUint32(76, true) + 1) * 512;
    const directory = v.getUint32(48, true);
    v.setUint32(fatStart + directory * 4, directory, true);
    await expect(parseHwp(bytes)).rejects.toMatchObject({ code: 'corrupt' });
    const oversized = buildHwp(); const ov = new DataView(oversized.buffer);
    const root = (ov.getUint32(48, true) + 1) * 512;
    ov.setUint32(root + 120, MAX_ENTRY_BYTES + 1, true);
    await expect(parseHwp(oversized)).rejects.toMatchObject({ code: 'unpacked-too-large' });
  });
  it('accepts uncompressed streams and rejects HWP3 and extension mismatch', async () => {
    expect((await parseHwp(buildHwp({ flags: 0 }))).markdown).toContain('합성 제목');
    await expect(parseHwp(buildHwp({ version: 3 }))).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(parseHwp(buildHwp(), undefined, 'hwpx')).rejects.toMatchObject({ code: 'unsupported-format' });
  });
  it('warns about unsupported image formats', async () => {
    const result = await parseHwp(buildHwp({ extension: 'emf', body: picture(1) }));
    expect(result.warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'format' });
  });
  it('rejects malformed records rather than silently returning a partial document', () => {
    expect(() => readRecords(concat(dword(67 | 99 << 20), new Uint8Array(1)))).toThrow();
    expect(() => readRecords(new Uint8Array(3))).toThrow();
  });
});

describe('HWPX structural parsing', () => {
  it('recognizes alternate namespace prefixes, attributes on text, entities, tabs, line breaks and CDATA', async () => {
    const bytes = await buildHwpx({ prefix: 'q', body: `<hp:p><hp:run><hp:t xml:space="preserve">A &amp; &#x1F600;<hp:tab/>B<hp:lineBreak/><![CDATA[<tag>]]></hp:t></hp:run></hp:p>` });
    const result = await parseHwp(bytes);
    expect(result.markdown).toContain('A & 😀\tB  \n\\<tag\\>'); expect(result.warnings).toEqual([]);
  });
  it('keeps both text and pictures in one paragraph in document order', async () => {
    const bytes = await buildHwpx({ body: `<hp:p><hp:run><hp:t>앞</hp:t><hp:pic><hc:img binaryItemIDRef="imageA"/></hp:pic><hp:t>뒤</hp:t></hp:run></hp:p>` });
    const result = await parseHwp(bytes);
    expect(result.markdown.indexOf('앞')).toBeLessThan(result.markdown.indexOf('![이미지'));
    expect(result.markdown.indexOf('![이미지')).toBeLessThan(result.markdown.indexOf('뒤'));
  });
  it('keeps final tracked text and reports omitted content', async () => {
    const bytes = await buildHwpx({ body: `<hp:p><hp:run><hp:delete><hp:t>지움</hp:t></hp:delete><hp:insert><hp:t>최종</hp:t></hp:insert></hp:run></hp:p>` });
    const result = await parseHwp(bytes);
    expect(result.markdown).not.toContain('지움'); expect(result.markdown).toContain('최종');
    expect(result.warnings.some(w => w.code === 'change-tracking-ignored')).toBe(true);
  });
  it('drops text between deletion boundary markers and preserves final inserted text', async () => {
    const bytes = await buildHwpx({ body: `<hp:p><hp:run><hp:t>앞</hp:t><hp:deleteBegin/><hp:t>삭제할비밀</hp:t><hp:deleteEnd/><hp:insertBegin/><hp:t>최종</hp:t><hp:insertEnd/></hp:run></hp:p>` });
    const result = await parseHwp(bytes);
    expect(result.markdown).not.toContain('삭제할비밀'); expect(result.markdown).toContain('최종');
    expect(result.warnings.some(w => w.code === 'change-tracking-ignored')).toBe(true);
  });
  it('honors tracked deletion ranges that span multiple paragraphs', async () => {
    const bytes = await buildHwpx({ body: `<hp:p><hp:run><hp:deleteBegin/><hp:t>비밀1</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>비밀2</hp:t><hp:deleteEnd/><hp:t>남김</hp:t></hp:run></hp:p>` });
    const result = await parseHwp(bytes);
    expect(result.markdown).not.toContain('비밀'); expect(result.markdown).toContain('남김');
    await expect(parseHwp(await buildHwpx({ body: '<hp:p><hp:run><hp:deleteBegin/></hp:run></hp:p>' }))).rejects.toMatchObject({ code: 'corrupt' });
  });
  it('preserves images and literal text in merged cells as safe HTML', async () => {
    const body = `<hp:p><hp:run>${xtable(true).replace('셀 1-1', '&lt;tag&gt; &amp; *text*').replace('</hp:subList>', xpic() + '</hp:subList>')}</hp:run></hp:p>`;
    const result = await parseHwp(await buildHwpx({ body }));
    expect(result.markdown).toContain('&lt;tag&gt; &amp; *text*');
    expect(result.markdown).toContain('<img src="mdviewer-import-assets/img-001.png"');
    expect(result.markdown).not.toContain('![');
  });
  it('warns about unknown extension controls instead of silently dropping them', async () => {
    const bytes = await buildHwpx({ body: '<hp:p><hp:run><hp:unknownControl/></hp:run></hp:p>' });
    const result = await parseHwp(bytes);
    expect(result.warnings).toContainEqual({ code: 'object-skipped', count: 1 });
    expect(result.markdown).toContain('제외');
  });
  it('rejects invalid numeric cell addresses and overlapping merged cells', async () => {
    for (const body of [xtable().replace('rowAddr="0"', 'rowAddr="NaN"'), xtable().replace('colSpan="1"', 'colSpan="2"')]) {
      await expect(parseHwp(await buildHwpx({ body: `<hp:p><hp:run>${body}</hp:run></hp:p>` }))).rejects.toMatchObject({ code: 'corrupt' });
    }
  });
  it('refuses encrypted manifests', async () => {
    await expect(parseHwp(await buildHwpx({ encrypted: true }))).rejects.toMatchObject({ code: 'encrypted' });
  });
  it.each(['<a><b></a>', '<a>&unknown;</a>', '<!DOCTYPE a><a/>', '<a x="1" x="2"/>', '<x:a/>', '<a/>tail', '<a/><b/>'])('rejects malformed XML %s', xml => {
    expect(() => parseXml(xml)).toThrow();
  });
  it('supports greater-than signs inside quoted XML attributes', () => {
    expect(xmlText(parseXml('<a x="1 > 0">x &lt; y</a>'))).toBe('x < y');
  });
  it('rejects generic ZIP packages as unsupported rather than guessing their content', async () => {
    const zip = new JSZip(); zip.file('word/document.xml', '<document/>');
    await expect(parseHwp(await zip.generateAsync({ type: 'uint8array' }))).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(parseHwp(await buildHwpx(), undefined, 'hwp')).rejects.toMatchObject({ code: 'unsupported-format' });
  });
  it('rejects duplicate central-directory names before choosing any entry', async () => {
    const zip = new JSZip(); zip.file('a.xml', 'a'); zip.file('b.xml', 'b');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const needle = new TextEncoder().encode('b.xml');
    for (let i = 0; i <= bytes.length - needle.length; i++) {
      if (needle.every((byte, j) => bytes[i + j] === byte)) bytes[i] = 'a'.charCodeAt(0);
    }
    await expect(parseHwp(bytes)).rejects.toMatchObject({ code: 'corrupt' });
  });
  it('rejects traversal, corrupt CRC, missing sections and archive bombs', async () => {
    const patch = async (edit: (bytes: Uint8Array) => void) => { const bytes = await buildHwpx(); edit(bytes); return bytes; };
    const central = (bytes: Uint8Array) => { for (let i = 0; i < bytes.length - 4; i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2) return i; throw Error(); };
    await expect(parseHwp(await patch(b => b.set(dword(MAX_ENTRY_BYTES + 1), central(b) + 24)))).rejects.toMatchObject({ code: 'unpacked-too-large' });
    await expect(parseHwp(await patch(b => { const end = b.length - 22; b[end + 10] = (MAX_ARCHIVE_ENTRIES + 1) & 255; b[end + 11] = (MAX_ARCHIVE_ENTRIES + 1) >> 8; b[end + 8] = b[end + 10]; b[end + 9] = b[end + 11]; }))).rejects.toMatchObject({ code: 'unpacked-too-large' });
    await expect(parseHwp(await patch(b => b[central(b) + 16] ^= 1))).rejects.toMatchObject({ code: 'corrupt' });
    const zip = await JSZip.loadAsync(await buildHwpx()); zip.remove('Contents/section0.xml');
    await expect(parseHwp(await zip.generateAsync({ type: 'uint8array' }))).rejects.toMatchObject({ code: 'corrupt' });
    await expect(parseHwp(await buildHwpx({ extra: { '../escape': 'x' } }))).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('bounded import', () => {
  it('rejects oversized input, unsupported magic, truncated CFB and truncated ZIP', async () => {
    await expect(parseHwp(new Uint8Array(MAX_HWP_BYTES + 1))).rejects.toMatchObject({ code: 'too-large' });
    await expect(parseHwp(new Uint8Array(10))).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(parseHwp(buildHwp().slice(0, 512))).rejects.toMatchObject({ code: 'corrupt' });
    await expect(parseHwp((await buildHwpx()).slice(0, 100))).rejects.toMatchObject({ code: 'corrupt' });
  });
  it('stops actual inflation even when declared ZIP size lies', () => {
    expect(() => inflateBounded(pako.deflateRaw(new Uint8Array(256 * 1024)), 1024)).toThrowError(expect.objectContaining({ code: 'unpacked-too-large' }));
  });
  it('exposes image count and total byte reductions instead of hidden limits', () => {
    const ctx = new ParseContext();
    for (let i = 0; i < 501; i++) ctx.image(String(i), 'x.png', secondPng);
    expect(ctx.warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'count' });
    const total = new ParseContext(); const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    for (let i = 0; i < 9; i++) total.image(String(i), 'x.png', bytes);
    expect(total.warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'size' });
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { generateHwpx, type ResolveImage } from './index';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HH = 'http://www.hancom.co.kr/hwpml/2011/head';
const HC = 'http://www.hancom.co.kr/hwpml/2011/core';
const OPF = 'http://www.idpf.org/2007/opf/';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const png = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
const data = `data:image/png;base64,${pngBase64}`;
// Hancom-compatibility assertions run on a document without images and one with an embedded image.
const documents = [{ markdown: '# 한글\n\n본문', images: 0 }, { markdown: `# 한글\n\n앞 ![그림](${data}) 뒤`, images: 1 }];

function xml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  expect(doc.getElementsByTagName('parsererror').length, source.slice(0, 100)).toBe(0);
  return doc;
}
function elements(doc: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS(namespace, name));
}
async function unpack(markdown: string, resolver?: ResolveImage) {
  const result = await generateHwpx(markdown, resolver);
  const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true });
  const header = xml(await zip.file('Contents/header.xml')!.async('string'));
  const section = xml(await zip.file('Contents/section0.xml')!.async('string'));
  return { ...result, zip, header, section };
}

describe('HWPX OCF package', () => {
  it('writes mimetype as the first local entry, uncompressed, without extras or BOM', async () => {
    const { bytes } = await generateHwpx('# 한글');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // STORE
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(extraLength).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength))).toBe('mimetype');
    const length = view.getUint32(22, true);
    expect(new TextDecoder().decode(bytes.subarray(30 + nameLength, 30 + nameLength + length))).toBe('application/hwp+zip');
    expect(view.getUint32(18, true)).toBe(length);
  });

  it('includes mandatory parts and only well-formed XML with namespaces', async () => {
    const { zip, header, section, warnings } = await unpack(`# 한글\n\n본문 & <문자> 😀\n\n![그림](${data})`);
    for (const path of ['version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/content.hpf',
      'Contents/header.xml', 'Contents/section0.xml']) expect(zip.file(path), path).not.toBeNull();
    for (const [path, part] of Object.entries(zip.files)) {
      if (/\.(xml|hpf)$/.test(path)) xml(await part.async('string'));
    }
    expect(header.documentElement.localName).toBe('head');
    expect(header.documentElement.namespaceURI).toBe(HH);
    expect(section.documentElement.localName).toBe('sec');
    expect(section.documentElement.namespaceURI).toBe('http://www.hancom.co.kr/hwpml/2011/section');
    // Angle-bracket text is retained even when Markdown treats it as raw HTML.
    expect(section.documentElement.textContent).toContain('본문 & <문자> 😀');
    expect(warnings.every(warning => warning.code === 'unsupported-markdown')).toBe(true);
  });

  it('[hancom-href] resolves every OPF item, spine idref and OCF rootfile to an actual package entry', async () => {
    const { zip } = await unpack(`![그림](${data})`);
    const opf = xml(await zip.file('Contents/content.hpf')!.async('string'));
    const items = elements(opf, OPF, 'item');
    expect(items.length).toBe(3);
    for (const item of items) {
      // Hancom, rhwp and the jakal strict validator resolve OPF hrefs from the package root, not from Contents/.
      const href = item.getAttribute('href')!;
      expect(href.startsWith('../'), href).toBe(false);
      expect(href.startsWith('/'), href).toBe(false);
      const path = new URL(href, 'https://package.invalid/').pathname.slice(1);
      expect(zip.file(path), path).not.toBeNull();
    }
    const ids = items.map(item => item.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of elements(opf, OPF, 'itemref')) expect(ids).toContain(ref.getAttribute('idref'));
    const container = xml(await zip.file('META-INF/container.xml')!.async('string'));
    const roots = elements(container, 'urn:oasis:names:tc:opendocument:xmlns:container', 'rootfile');
    expect(roots).toHaveLength(1);
    expect(zip.file(roots[0].getAttribute('full-path')!)).not.toBeNull();
    const manifest = xml(await zip.file('META-INF/manifest.xml')!.async('string'));
    const manifestNS = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
    for (const entry of elements(manifest, manifestNS, 'file-entry')) {
      const path = entry.getAttributeNS(manifestNS, 'full-path')!;
      if (path !== '/') expect(zip.file(path), path).not.toBeNull();
    }
  });

  it('is deterministic and has no worker-global or DOM dependency', async () => {
    // The test environment supplies DOM only to inspect output, never to generate it.
    const previous = globalThis.DOMParser;
    vi.stubGlobal('DOMParser', undefined);
    try {
      const first = await generateHwpx('한글');
      const second = await generateHwpx('한글');
      expect(first.bytes).toEqual(second.bytes);
    } finally { vi.stubGlobal('DOMParser', previous); }
  });

  it('[hancom-date] writes 1980-01-01 00:00 DOS timestamps on every local and central entry', async () => {
    for (const { markdown, images } of documents) {
      const { bytes } = await generateHwpx(markdown);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Follow EOCD → central directory → local headers; read raw DOS fields so the check is timezone-independent.
      let eocd = bytes.length - 22;
      while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
      expect(eocd).toBeGreaterThanOrEqual(0);
      const count = view.getUint16(eocd + 10, true);
      expect(count).toBeGreaterThan(0);
      const names: string[] = [];
      let at = view.getUint32(eocd + 16, true);
      for (let n = 0; n < count; n++) {
        expect(view.getUint32(at, true)).toBe(0x02014b50);
        const nameLength = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
        names.push(name);
        // DOS date 0x0021 = 1980-01-01 (a local-time Date shifted to 1979 wraps to 2107-12-31), time 0 = 00:00:00.
        expect([view.getUint16(at + 12, true), view.getUint16(at + 14, true)], `central ${name}`).toEqual([0, 0x0021]);
        const local = view.getUint32(at + 42, true);
        expect(view.getUint32(local, true), name).toBe(0x04034b50);
        expect([view.getUint16(local + 10, true), view.getUint16(local + 12, true)], `local ${name}`).toEqual([0, 0x0021]);
        at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      }
      expect(names.filter(name => name.startsWith('BinData/'))).toHaveLength(images);
    }
  });

  it('[hancom-href] lists content.hpf items from the package root with images under BinData/', async () => {
    for (const { markdown, images } of documents) {
      const { zip } = await unpack(markdown);
      const opf = xml(await zip.file('Contents/content.hpf')!.async('string'));
      const hrefs = new Map(elements(opf, OPF, 'item').map(item => [item.getAttribute('id')!, item.getAttribute('href')!]));
      expect(hrefs.get('header')).toBe('Contents/header.xml');
      expect(hrefs.get('section0')).toBe('Contents/section0.xml');
      const imageHrefs = [...hrefs].filter(([id]) => id !== 'header' && id !== 'section0').map(([, href]) => href);
      expect(imageHrefs).toHaveLength(images);
      for (const href of imageHrefs) expect(href).toMatch(/^BinData\/image\d+\.png$/);
      for (const href of hrefs.values()) {
        expect(href, href).not.toContain('../');
        expect(href.startsWith('/'), href).toBe(false);
        // Listed path must be the actual zip entry, read verbatim from the package root.
        expect(zip.file(href), href).not.toBeNull();
      }
    }
  });
});

describe('OWPML document structure', () => {
  it('preserves all six heading levels, paragraphs, nested lists, table addresses and inline images', async () => {
    const markdown = [
      ...Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} 제목 ${i + 1}\n`),
      '일반 문단\n다음 줄\n',
      '- 항목\n  - 하위 항목\n- 둘째\n',
      '3. 순서 셋\n4. 순서 넷\n',
      '| 이름 | 값 |\n| --- | --- |\n| 가 | 나 |\n| 다 | 라 |\n',
      `앞 ![첫째](${data}) 뒤 ![둘째](./그림.png) 끝`,
    ].join('\n');
    const resolver = vi.fn(async () => ({ bytes: png }));
    const { section, header, zip, warnings } = await unpack(markdown, resolver);
    expect(warnings).toEqual([]);
    for (let level = 1; level <= 6; level++) {
      expect(elements(header, HH, 'style').find(s => s.getAttribute('name') === `제목 ${level}`)).toBeDefined();
      expect(elements(section, HP, 'p').filter(p => p.getAttribute('styleIDRef') === String(level))).toHaveLength(1);
    }
    const text = section.documentElement.textContent!;
    expect(text).toContain('일반 문단다음 줄');
    const shapes = elements(header, HH, 'paraPr');
    const listParas = elements(section, HP, 'p').filter(p => {
      const shape = shapes.find(s => s.getAttribute('id') === p.getAttribute('paraPrIDRef'))!;
      return ['NUMBER', 'BULLET'].includes(elements(shape, HH, 'heading')[0].getAttribute('type')!);
    });
    expect(listParas).toHaveLength(5);
    expect(elements(header, HH, 'heading').some(h => h.getAttribute('type') === 'BULLET' && h.getAttribute('level') === '1')).toBe(true);
    expect(elements(header, HH, 'numbering')[0].getAttribute('start')).toBe('3');
    const tables = elements(section, HP, 'tbl');
    expect(tables).toHaveLength(1);
    expect(tables[0].getAttribute('rowCnt')).toBe('3');
    expect(tables[0].getAttribute('colCnt')).toBe('2');
    expect(elements(tables[0], HP, 'tr')).toHaveLength(3);
    expect(elements(tables[0], HP, 'cellAddr').map(cell => [cell.getAttribute('rowAddr'), cell.getAttribute('colAddr')]))
      .toEqual([['0', '0'], ['0', '1'], ['1', '0'], ['1', '1'], ['2', '0'], ['2', '1']]);
    expect(elements(section, HP, 'pic')).toHaveLength(2);
    const pictureParagraph = elements(section, HP, 'p').find(p => p.textContent?.startsWith('앞 '))!;
    expect(Array.from(pictureParagraph.children).map(run => run.firstElementChild?.localName)).toEqual(['t', 'pic', 't', 'pic', 't']);
    expect(Object.keys(zip.files).filter(path => path.startsWith('BinData/'))).toHaveLength(2);
    expect(resolver).toHaveBeenCalledExactlyOnceWith('./그림.png');
    const imageRefs = elements(section, HC, 'img').map(image => image.getAttribute('binaryItemIDRef'));
    expect(imageRefs).toEqual(['image1', 'image2']);
    expect(await zip.file('BinData/image1.png')!.async('uint8array')).toEqual(png);
  });

  it('keeps XML special characters, numeric entities, Hangul, emoji, tabs and code text', async () => {
    const markdown = '# 한글 &amp; &#x1F600;\n\nA & B \\<이름\\> "따옴표" \'작은\'\n\n```txt\n<원문> &amp;\n\t들여쓰기 😀\n```';
    const { section, header, warnings } = await unpack(markdown);
    expect(section.documentElement.textContent).toContain('한글 & 😀');
    expect(section.documentElement.textContent).toContain('A & B <이름> "따옴표" \'작은\'');
    expect(section.documentElement.textContent).toContain('<원문> &amp;들여쓰기 😀');
    expect(elements(section, HP, 'lineBreak')).toHaveLength(1);
    expect(elements(section, HP, 'tab')).toHaveLength(1);
    const code = elements(section, HP, 'p').find(p => p.getAttribute('styleIDRef') === '7')!;
    expect(elements(code, HP, 'run')[0].getAttribute('charPrIDRef')).toBe('7');
    expect(elements(header, HH, 'font').some(font => font.getAttribute('face') === 'D2Coding')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('reports inline simplification once, preserving text in headings, tables, lists and links', async () => {
    const { section, warnings } = await unpack('# **제목**\n\n**굵게** *기울임* ~~취소~~ `코드` [링크](https://example.invalid)\n\n- **항목**\n\n| 열 |\n| --- |\n| *셀* |');
    expect(warnings).toEqual([expect.objectContaining({ code: 'inline-format-simplified', count: 1 })]);
    for (const word of ['제목', '굵게', '기울임', '취소', '코드', '링크', '항목', '셀']) expect(section.documentElement.textContent).toContain(word);
  });

  it('creates quote indentation and preserves task states', async () => {
    const { section, header } = await unpack('> 인용 문단\n\n- [x] 완료\n- [ ] 대기');
    const quote = elements(section, HP, 'p').find(p => p.textContent === '인용 문단')!;
    const prop = elements(header, HH, 'paraPr').find(p => p.getAttribute('id') === quote.getAttribute('paraPrIDRef'))!;
    expect(Number(elements(prop, HC, 'left')[0].getAttribute('value'))).toBeGreaterThan(0);
    expect(section.documentElement.textContent).toContain('[x] 완료');
    expect(section.documentElement.textContent).toContain('[ ] 대기');
  });

  it('places section properties in the first document paragraph even when the first block is a table', async () => {
    const { section } = await unpack('| 열 |\n| --- |\n| 값 |');
    const first = section.documentElement.firstElementChild!;
    expect(first.localName).toBe('p');
    expect(first.firstElementChild!.firstElementChild!.localName).toBe('secPr');
    expect(elements(section, HP, 'secPr')).toHaveLength(1);
    const page = elements(section, HP, 'pagePr')[0];
    expect(page.getAttribute('width')).toBe('59528');
    expect(page.getAttribute('height')).toBe('84186');
    const ids = elements(section, HP, 'p').map(p => p.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every paragraph/style/character reference to the header definitions', async () => {
    const { section, header } = await unpack('# 제목\n\n> > 깊은 인용\n\n- 가\n  1. 나\n\n```\n코드\n```\n\n| 열 |\n| --- |\n| 값 |');
    const paraIds = elements(header, HH, 'paraPr').map(p => p.getAttribute('id'));
    const charIds = elements(header, HH, 'charPr').map(p => p.getAttribute('id'));
    const styleIds = elements(header, HH, 'style').map(p => p.getAttribute('id'));
    for (const p of elements(section, HP, 'p')) {
      expect(paraIds).toContain(p.getAttribute('paraPrIDRef'));
      expect(styleIds).toContain(p.getAttribute('styleIDRef'));
    }
    for (const run of elements(section, HP, 'run')) expect(charIds).toContain(run.getAttribute('charPrIDRef'));
    for (const style of elements(header, HH, 'style')) {
      expect(paraIds).toContain(style.getAttribute('paraPrIDRef'));
      expect(charIds).toContain(style.getAttribute('charPrIDRef'));
    }
  });

  it('emits a usable empty paragraph for an empty document', async () => {
    const { section, warnings } = await unpack('');
    expect(elements(section, HP, 'p')).toHaveLength(1);
    expect(elements(section, HP, 'secPr')).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('preserves unsupported raw HTML as text and warns', async () => {
    const { section, warnings } = await unpack('<div>중요한 <em>원문</em></div>');
    expect(section.documentElement.textContent).toContain('<div>중요한 <em>원문</em></div>');
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-markdown' }));
    expect(section.getElementsByTagName('div')).toHaveLength(0);
  });

  it('replaces illegal XML characters with visible replacement text and a warning', async () => {
    const { section, warnings } = await unpack('한글\u0000\u0001\ud800\uffff😀');
    expect(section.documentElement.textContent).toContain('한글����😀');
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'xml-character-replaced', count: 4 }));
  });

  it('keeps independent ordered list starts and warns when nesting exceeds seven levels', async () => {
    const deepList = Array.from({ length: 8 }, (_, level) => `${'  '.repeat(level)}- 깊이 ${level}`).join('\n');
    const { header, section, warnings } = await unpack(`3. 셋\n4. 넷\n\n구분 문단\n\n7. 일곱\n8. 여덟\n\n${deepList}`);
    expect(elements(header, HH, 'numbering').map(n => n.getAttribute('start'))).toEqual(['3', '7']);
    for (const n of elements(header, HH, 'numbering')) {
      for (const h of elements(n, HH, 'paraHead')) expect(h.getAttribute('start')).toBe(n.getAttribute('start'));
    }
    expect(section.documentElement.textContent).toContain('깊이 7');
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'list-level-simplified', count: 1 }));
  });

  it('[hancom-secpr] writes Hancom secPr children in order with lineNumberShape, footNotePr, endNotePr and three pageBorderFill', async () => {
    // Values are copied from the Hancom-format reference section0.xml (F01) first hp:secPr.
    const attributes = (node: Element) => Object.fromEntries(Array.from(node.attributes, attr => [attr.name, attr.value]));
    const children = (node: Element) => Array.from(node.children, child => [child.localName, attributes(child)]);
    const noteFormat = { type: 'DIGIT', userChar: '', prefixChar: '', suffixChar: ')', supscript: '0' };
    for (const { markdown } of documents) {
      const { section, header } = await unpack(markdown);
      const secPr = elements(section, HP, 'secPr')[0];
      expect(Array.from(secPr.children).every(child => child.namespaceURI === HP)).toBe(true);
      expect(Array.from(secPr.children, child => child.localName)).toEqual(['grid', 'startNum', 'visibility', 'lineNumberShape',
        'pagePr', 'footNotePr', 'endNotePr', 'pageBorderFill', 'pageBorderFill', 'pageBorderFill']);
      const [lineNumberShape, , footNotePr, endNotePr, ...pageBorderFills] = Array.from(secPr.children).slice(3);
      expect(attributes(lineNumberShape)).toEqual({ restartType: '0', countBy: '0', distance: '0', startNumber: '0' });
      expect(lineNumberShape.children).toHaveLength(0);
      expect(children(footNotePr)).toEqual([
        ['autoNumFormat', noteFormat],
        ['noteLine', { length: '-1', type: 'SOLID', width: '0.12 mm', color: '#000000' }],
        ['noteSpacing', { betweenNotes: '284', belowLine: '568', aboveLine: '852' }],
        ['numbering', { type: 'CONTINUOUS', newNum: '1' }],
        ['placement', { place: 'EACH_COLUMN', beneathText: '0' }],
      ]);
      expect(children(endNotePr)).toEqual([
        ['autoNumFormat', noteFormat],
        ['noteLine', { length: '0', type: 'NONE', width: '0.12 mm', color: '#000000' }],
        ['noteSpacing', { betweenNotes: '0', belowLine: '576', aboveLine: '864' }],
        ['numbering', { type: 'CONTINUOUS', newNum: '1' }],
        ['placement', { place: 'END_OF_DOCUMENT', beneathText: '0' }],
      ]);
      expect(pageBorderFills.map(fill => attributes(fill))).toEqual(['BOTH', 'EVEN', 'ODD'].map(type => ({
        type, borderFillIDRef: '1', textBorder: 'PAPER', headerInside: '0', footerInside: '0', fillArea: 'PAPER' })));
      for (const fill of pageBorderFills) {
        expect(children(fill)).toEqual([['offset', { left: '1417', right: '1417', top: '1417', bottom: '1417' }]]);
      }
      // pageBorderFill borderFillIDRef="1" must point at an existing header border fill.
      expect(elements(header, HH, 'borderFill').map(fill => fill.getAttribute('id'))).toContain('1');
    }
  });
});

describe('image embedding and visible losses', () => {
  it('never resolves remote URLs and leaves placeholders in their original positions', async () => {
    const resolver = vi.fn();
    const { section, warnings, zip } = await unpack('앞 ![원격](HTTPS://example.invalid/a.png) 중간 ![상대](//example.invalid/a.png) 뒤', resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'image-remote', count: 2 }));
    expect(section.documentElement.textContent).toContain('앞 [이미지 제외: 원격] 중간 [이미지 제외: 상대] 뒤');
    expect(Object.keys(zip.files).filter(path => path.startsWith('BinData/'))).toHaveLength(0);
  });

  it('reports missing images and resolver errors without dropping surrounding text', async () => {
    const resolver = vi.fn(async (src: string) => { if (src === 'broken.png') throw new Error('private path'); return null; });
    const { section, warnings } = await unpack('![없음](none.png) ![실패](broken.png)', resolver);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'image-missing', count: 2 }));
    expect(JSON.stringify(warnings)).not.toContain('private path');
    expect(section.documentElement.textContent).toContain('[이미지 제외: 없음] [이미지 제외: 실패]');
  });

  it('rejects unsupported/invalid data images with a format warning', async () => {
    const { section, warnings } = await unpack('![벡터](data:image/svg+xml;base64,PHN2Zy8+) ![깨짐](data:image/png;base64,@@@)');
    expect(elements(section, HP, 'pic')).toHaveLength(0);
    expect(warnings.filter(w => w.code === 'image-format').reduce((n, w) => n + w.count, 0)).toBe(2);
    expect(section.documentElement.textContent).toContain('[이미지 제외: 벡터] [이미지 제외: 깨짐]');
  });

  it('detects format from bytes and does not mutate caller buffers', async () => {
    const before = png.slice();
    const { zip } = await unpack('![그림](misleading.jpg)', async () => ({ bytes: png, mimeType: 'image/jpeg' }));
    expect(png).toEqual(before);
    expect(zip.file('BinData/image1.png')).not.toBeNull();
    expect(await zip.file('BinData/image1.png')!.async('uint8array')).toEqual(before);
  });

  it('embeds images in table cells and resolves references and escaped paths', async () => {
    const resolver = vi.fn(async () => png);
    const { section, warnings } = await unpack('| 그림 |\n| --- |\n| ![셀][이미지] |\n\n[이미지]: ./a&amp;b.png', resolver);
    expect(elements(section, HP, 'tbl')).toHaveLength(1);
    expect(elements(elements(section, HP, 'tbl')[0], HP, 'pic')).toHaveLength(1);
    expect(resolver).toHaveBeenCalledExactlyOnceWith('./a&b.png');
    expect(warnings).toEqual([]);
  });

  it('accepts percent-encoded data images without a platform Buffer dependency', async () => {
    const encoded = Array.from(png, b => `%${b.toString(16).padStart(2, '0')}`).join('');
    const { zip, warnings } = await unpack(`![그림](data:image/png,${encoded})`);
    expect(await zip.file('BinData/image1.png')!.async('uint8array')).toEqual(png);
    expect(warnings).toEqual([]);
  });

  it('reports the 8MB per-image limit with a placeholder', async () => {
    const large = new Uint8Array(8 * 1024 * 1024 + 1);
    large.set(png);
    const { section, warnings } = await unpack('![큰 그림](large.png)', async () => large);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'image-limit' }));
    expect(section.documentElement.textContent).toContain('[이미지 제외: 큰 그림]');
    expect(elements(section, HP, 'pic')).toHaveLength(0);
  });

  it('reports the 64MB combined image limit and retains the first eight large images', async () => {
    const image = new Uint8Array(8 * 1024 * 1024);
    image.set(png);
    const source = Array.from({ length: 9 }, (_, i) => `![그림 ${i}](image-${i}.png)`).join('\n\n');
    const { section, warnings, zip } = await unpack(source, async () => image);
    expect(elements(section, HP, 'pic')).toHaveLength(8);
    expect(Object.keys(zip.files).filter(path => path.startsWith('BinData/'))).toHaveLength(8);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'image-limit', count: 1 }));
    expect(section.documentElement.textContent).toContain('[이미지 제외: 그림 8]');
  }, 20000);

  it('preserves image aspect ratios and fits oversized images within the page', async () => {
    const wide = png.slice();
    new DataView(wide.buffer).setUint32(16, 10000);
    new DataView(wide.buffer).setUint32(20, 1000);
    const { section } = await unpack('![가로](wide.png)', async () => wide);
    const size = elements(elements(section, HP, 'pic')[0], HP, 'sz')[0];
    expect(Number(size.getAttribute('width'))).toBeLessThanOrEqual(48190);
    expect(Number(size.getAttribute('width')) / Number(size.getAttribute('height'))).toBeCloseTo(10, 2);
  });

  it('reports the 500-image count limit rather than silently truncating', async () => {
    const source = Array.from({ length: 501 }, () => '![그림](a.png)').join(' ');
    const { section, warnings, zip } = await unpack(source, async () => png);
    expect(elements(section, HP, 'pic')).toHaveLength(500);
    expect(Object.keys(zip.files).filter(path => path.startsWith('BinData/'))).toHaveLength(500);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'image-limit', count: 1 }));
    expect(section.documentElement.textContent).toContain('[이미지 제외: 그림]');
  }, 20000);
});

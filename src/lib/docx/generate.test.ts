// @vitest-environment jsdom
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { expect, it, vi } from 'vitest';
import { generateDocx, summarizeDocxWarnings } from './index';
const sample = readFileSync('fixtures/sample-ko.md', 'utf8');
const png = new Uint8Array(readFileSync('fixtures/img/sample.png'));
const resolver = () => ({ bytes: png });
async function unpack(source: string, resolve = resolver) { const result = await generateDocx(source, resolve); const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true }); const part = async (name: string) => (await zip.file(name)!.async('string')); return { ...result, zip, part }; }
const doc = async (source: string) => (await unpack(source)).part('word/document.xml');
it('creates a valid zip with required parts and parseable XML', async () => { const { zip } = await unpack(sample); for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml']) expect(zip.file(name)).toBeTruthy(); for (const file of Object.values(zip.files).filter(f => /\.(xml|rels)$/.test(f.name))) expect(new DOMParser().parseFromString(await file.async('string'), 'application/xml').querySelector('parsererror')).toBeNull(); });
it('contains built-in heading styles and outline levels', async () => { const { part } = await unpack(''); const s = await part('word/styles.xml'); for (let i = 1; i <= 6; i++) { expect(s).toContain(`w:styleId="Heading${i}"`); expect(s).toContain(`w:val="heading ${i}"`); expect(s).toContain(`w:val="${i - 1}"`); } });
it('uses heading styles for all six levels', async () => { const s = await doc(Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} title`).join('\n\n')); for (let i = 1; i <= 6; i++) expect(s).toContain(`w:val="Heading${i}"`); });
it('preserves bold italic strike and code', async () => { const s = await doc('**bold** *italic* ~~strike~~ `code`'); for (const x of ['<w:b/>', '<w:i/>', '<w:strike/>', 'CodeChar']) expect(s).toContain(x); });
it('combines nested inline formatting', async () => { expect(await doc('**bold _both_**')).toMatch(/<w:b\/><w:i\/>/); });
it('stores external links as relationships', async () => { const { part } = await unpack('[link](https://example.com)'); expect(await part('word/document.xml')).toContain('<w:hyperlink'); expect(await part('word/_rels/document.xml.rels')).toContain('TargetMode="External"'); });
it('keeps unsafe links as text', async () => { const s = await doc('[link](javascript:alert)'); expect(s).not.toContain('<w:hyperlink'); expect(s).toContain('link'); });
it('numbers nested lists and gives ordered lists distinct ids', async () => { const { part } = await unpack('1. one\n   - nested\n\ntext\n\n1. two'); const s = await part('word/document.xml'); expect(s).toContain('w:ilvl w:val="1"'); expect(s).toContain('w:numId w:val="2"'); expect(s).toContain('w:numId w:val="3"'); const n = await part('word/numbering.xml'); expect(n.lastIndexOf('</w:abstractNum>')).toBeLessThan(n.indexOf('<w:num ')); });
it('renders checklist markers', async () => { const s = await doc('- [ ] a\n- [x] b'); expect(s).toContain('☐'); expect(s).toContain('☑'); });
it('writes table grid header alignment and empty paragraphs', async () => { const s = await doc('| a | b |\n| :-- | --: |\n| x | |'); expect(s.match(/<w:gridCol/g)).toHaveLength(2); expect(s).toContain('<w:tblHeader/>'); expect(s).toContain('w:val="right"'); expect(s.match(/<w:tc>/g)).toHaveLength(4); });
it('writes code lines with preserved whitespace and tabs', async () => { const s = await doc('```\n  one\n\ttwo\n```'); expect(s.match(/w:val="Code"/g)).toHaveLength(2); expect(s).toContain('xml:space="preserve"'); expect(s).toContain('<w:tab/>'); });
it('indents nested quotations', async () => { const s = await doc('> first\n>\n> > second'); expect(s).toContain('w:left="720"'); expect(s).toContain('w:left="1440"'); });
it('embeds exact local image bytes and relationship', async () => { const { zip, part } = await unpack('![alt](./img/sample.png)'); expect(await zip.file('word/media/image1.png')!.async('uint8array')).toEqual(png); expect(await part('word/_rels/document.xml.rels')).toContain('media/image1.png'); expect(await part('word/document.xml')).toContain('r:embed='); });
it('does not resolve remote images and creates a link', async () => { const read = vi.fn(resolver); const { zip, part, warnings } = await unpack('![alt](https://example.com/a.png)', read); expect(read).not.toHaveBeenCalled(); expect(zip.file('word/media/image1.png')).toBeNull(); expect(await part('word/document.xml')).toContain('<w:hyperlink'); expect(warnings[0].code).toBe('image-remote'); });
it('replaces missing images with a placeholder', async () => { const result = await generateDocx('![missing](x.png)', () => null); const zip = await JSZip.loadAsync(result.bytes); expect(await zip.file('word/document.xml')!.async('string')).toContain('[그림: missing]'); expect(result.warnings[0].code).toBe('image-missing'); });
it('escapes XML and replaces control characters', async () => { const s = await doc('A & B < C \u0001'); expect(s).toContain('&amp;'); expect(s).toContain('&lt;'); expect(s).toContain('�'); });
it('ends the body with section settings', async () => { expect(await doc('hello')).toMatch(/<w:sectPr>.*<\/w:sectPr><\/w:body>/); });
it('converts the Korean sample including table headings and image', async () => { const { zip, part } = await unpack(sample); const s = await part('word/document.xml'); for (const word of ['Heading1', 'Heading2', 'Heading3', '<w:tbl>', '☐', '☑', 'Code']) expect(s).toContain(word); expect(s.match(/<w:tr>/g)).toHaveLength(4); expect(await zip.file('word/media/image1.png')!.async('uint8array')).toEqual(png); });
it('summarizes warnings', () => { expect(summarizeDocxWarnings([])).toBe(''); expect(summarizeDocxWarnings([{ code: 'image-missing', count: 2 }, { code: 'image-remote', count: 1 }, { code: 'unsupported-markdown', count: 3 }])).toBe('그림 2개 제외 · 원격 그림 1개는 링크로 · 서식 단순화 3건'); });
it('textutil opens the Korean sample', async () => { const dir = mkdtempSync(join(tmpdir(), 'mdviewer-docx-')); try { const result = await generateDocx(sample, resolver); const path = join(dir, 'sample.docx'); writeFileSync(path, result.bytes); const text = execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', path], { encoding: 'utf8' }); for (const phrase of ['한글 마크다운 읽기 예제', '파일 감시', '안녕하세요, MDViewer!']) expect(text).toContain(phrase); } finally { rmSync(dir, { recursive: true, force: true }); } });
it('covers internal relationship targets and part content types', async () => {
  const { zip, part } = await unpack(sample);
  const rels = new DOMParser().parseFromString(await part('word/_rels/document.xml.rels'), 'application/xml');
  const types = await part('[Content_Types].xml');
  for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const target = rel.getAttribute('Target')!; expect(zip.file(`word/${target}`)).toBeTruthy();
    expect(types).toContain(target.endsWith('.xml') ? `/word/${target}` : `Extension="${target.split('.').pop()}"`);
  }
});
it('keeps properties in Word schema order', async () => {
  const { part } = await unpack('# Heading\n\n> Quote\n\n1. **bold**\n\n| a | b |\n| --- | --- |\n| x | y |');
  for (const name of ['word/document.xml', 'word/styles.xml']) {
    const xml = new DOMParser().parseFromString(await part(name), 'application/xml');
    for (const [tag, order] of Object.entries({ pPr: ['pStyle', 'keepNext', 'numPr', 'pBdr', 'shd', 'spacing', 'ind', 'jc', 'outlineLvl'], rPr: ['rStyle', 'rFonts', 'b', 'i', 'strike', 'color', 'sz', 'shd', 'u'], tblPr: ['tblStyle', 'tblW', 'jc', 'tblBorders', 'tblLayout', 'tblLook'] })) {
      for (const node of Array.from(xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', tag))) {
        const indices = Array.from(node.children, child => order.indexOf(child.localName)); expect(indices.every(i => i >= 0)).toBe(true); expect(indices).toEqual([...indices].sort((a, b) => a - b));
      }
    }
  }
});
it('assigns unique drawing ids and limits oversized images to the page', async () => {
  const big = png.slice(); new DataView(big.buffer, big.byteOffset, big.byteLength).setUint32(16, 5000); const { part } = await unpack('![a](x.png) ![b](y.png)', () => ({ bytes: big }));
  const xml = new DOMParser().parseFromString(await part('word/document.xml'), 'application/xml');
  const properties = Array.from(xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr'));
  expect(new Set(properties.map(x => x.getAttribute('id'))).size).toBe(2);
  for (const extent of Array.from(xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent'))) expect(Number(extent.getAttribute('cx'))).toBeLessThanOrEqual(5753100);
});

const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const officeRelNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypeNs = 'http://schemas.openxmlformats.org/package/2006/content-types';
const parsePart = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const wordElements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS(wordNs, name));
const wordAttribute = (node: Element, name: string) => node.getAttributeNS(wordNs, name);
const directWordChildren = (node: Element, name: string) => Array.from(node.children).filter(child => child.namespaceURI === wordNs && child.localName === name);

it('puts a paragraph directly in every table cell, including empty cells', async () => {
  const document = parsePart(await doc('| left | middle | right |\n| :--- | :---: | ---: |\n| value | | |\n| | another | end |'));
  const table = wordElements(document, 'tbl');
  expect(table).toHaveLength(1);
  const rows = wordElements(table[0], 'tr');
  expect(rows).toHaveLength(3);
  const cells = rows.flatMap(row => directWordChildren(row, 'tc'));
  expect(cells).toHaveLength(9);
  expect(cells.filter(cell => !cell.textContent?.trim())).toHaveLength(3);
  for (const cell of cells) expect(directWordChildren(cell, 'p').length).toBeGreaterThan(0);
  expect(wordElements(table[0], 'gridCol')).toHaveLength(3);
  expect(wordElements(rows[0], 'tblHeader')).toHaveLength(1);
  for (const cell of directWordChildren(rows[0], 'tc')) expect(wordElements(cell, 'b')).toHaveLength(1);
  for (const row of rows) {
    expect(directWordChildren(row, 'tc').map(cell => wordAttribute(wordElements(cell, 'jc')[0], 'val')))
      .toEqual(['left', 'center', 'right']);
  }
});

it('resolves unique package relationship ids, references and content types', async () => {
  const read = vi.fn(resolver);
  const source = '![first](./first.png) ![second](./second.png) [site](https://example.com/a?x=1&y=2) ![remote](https://example.net/remote.png)';
  const { zip } = await unpack(source, read);
  expect(read).toHaveBeenCalledTimes(2);
  const documents = new Map<string, Document>();
  for (const file of Object.values(zip.files).filter(file => /\.(xml|rels)$/.test(file.name))) {
    const parsed = parsePart(await file.async('string'));
    expect(parsed.querySelector('parsererror')).toBeNull();
    documents.set(file.name, parsed);
  }

  const relsBySource = new Map<string, Map<string, Element>>();
  for (const [name, parsed] of documents) {
    if (!name.endsWith('.rels')) continue;
    const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/.exec(name);
    expect(name === '_rels/.rels' || match !== null, name).toBe(true);
    const sourcePart = name === '_rels/.rels' ? '' : `${match![1] ? `${match![1]}/` : ''}${match![2]}`;
    const base = sourcePart.includes('/') ? sourcePart.slice(0, sourcePart.lastIndexOf('/') + 1) : '';
    const relations = Array.from(parsed.getElementsByTagNameNS(packageRelNs, 'Relationship'));
    expect(relations.length, name).toBeGreaterThan(0);
    const ids = relations.map(rel => rel.getAttribute('Id'));
    expect(ids.every(Boolean), name).toBe(true);
    expect(new Set(ids).size, name).toBe(ids.length);
    const byId = new Map<string, Element>();
    for (const rel of relations) {
      const id = rel.getAttribute('Id')!;
      const target = rel.getAttribute('Target');
      const mode = rel.getAttribute('TargetMode');
      expect(target, `${name} ${id}`).toBeTruthy();
      expect([null, 'External']).toContain(mode);
      if (mode !== 'External') expect(zip.file(`${base}${target}`), `${name} ${id}`).toBeTruthy();
      byId.set(id, rel);
    }
    relsBySource.set(sourcePart, byId);
  }
  expect(relsBySource.get('')?.get('rId1')?.getAttribute('Target')).toBe('word/document.xml');

  const documentRels = relsBySource.get('word/document.xml')!;
  const references = Array.from(documents.entries()).filter(([name]) => name.endsWith('.xml')).flatMap(([name, document]) =>
    Array.from(document.getElementsByTagName('*')).flatMap(element =>
      Array.from(element.attributes)
        .filter(attribute => attribute.namespaceURI === officeRelNs && ['id', 'embed', 'link'].includes(attribute.localName))
        .map(attribute => ({ sourcePart: name, element, attribute }))));
  expect(references.filter(ref => ref.attribute.localName === 'embed')).toHaveLength(2);
  expect(references.filter(ref => ref.attribute.localName === 'id')).toHaveLength(2);
  for (const { sourcePart, element, attribute } of references) {
    const relation = relsBySource.get(sourcePart)?.get(attribute.value);
    expect(relation, `${sourcePart} ${element.tagName} ${attribute.name}=${attribute.value}`).toBeDefined();
    if (attribute.localName === 'embed') {
      expect(relation!.getAttribute('Type')).toBe(`${officeRelNs}/image`);
      expect(relation!.getAttribute('TargetMode')).toBeNull();
      expect(zip.file(`word/${relation!.getAttribute('Target')}`)).toBeTruthy();
    } else {
      expect(element.localName).toBe('hyperlink');
      expect(relation!.getAttribute('Type')).toBe(`${officeRelNs}/hyperlink`);
      expect(relation!.getAttribute('TargetMode')).toBe('External');
    }
  }
  const targets = references.filter(ref => ref.attribute.localName === 'id')
    .map(ref => documentRels.get(ref.attribute.value)!.getAttribute('Target'));
  expect(targets).toEqual(['https://example.com/a?x=1&y=2', 'https://example.net/remote.png']);

  const types = documents.get('[Content_Types].xml')!;
  const defaults = Array.from(types.getElementsByTagNameNS(contentTypeNs, 'Default'));
  const overrides = Array.from(types.getElementsByTagNameNS(contentTypeNs, 'Override'));
  for (const file of Object.values(zip.files).filter(file => !file.dir && file.name !== '[Content_Types].xml')) {
    const extension = file.name.split('.').pop();
    const hasOverride = overrides.some(entry => entry.getAttribute('PartName') === `/${file.name}` && entry.getAttribute('ContentType'));
    const hasDefault = defaults.some(entry => entry.getAttribute('Extension') === extension && entry.getAttribute('ContentType'));
    expect(hasOverride || hasDefault, file.name).toBeTruthy();
  }
});

it('maps each ordered list to its own numbering definition and start override', async () => {
  const { part } = await unpack('1. first\n2. next\n\nseparator\n\n1. restarted\n\nseparator again\n\n4. fourth');
  const document = parsePart(await part('word/document.xml'));
  const numbering = parsePart(await part('word/numbering.xml'));
  const paragraphs = wordElements(document, 'p');
  const numberFor = (text: string) => {
    const paragraph = paragraphs.find(node => node.textContent === text);
    expect(paragraph, text).toBeDefined();
    const properties = wordElements(paragraph!, 'numPr');
    expect(properties).toHaveLength(1);
    expect(wordAttribute(wordElements(properties[0], 'ilvl')[0], 'val')).toBe('0');
    return wordAttribute(wordElements(properties[0], 'numId')[0], 'val');
  };
  const first = numberFor('first');
  expect(numberFor('next')).toBe(first);
  const restarted = numberFor('restarted');
  const fourth = numberFor('fourth');
  expect(new Set([first, restarted, fourth]).size).toBe(3);

  const rootChildren = Array.from(numbering.documentElement.children);
  const abstractPositions = rootChildren.flatMap((node, index) => node.localName === 'abstractNum' ? [index] : []);
  const numberPositions = rootChildren.flatMap((node, index) => node.localName === 'num' ? [index] : []);
  expect(abstractPositions).toHaveLength(2);
  expect(numberPositions).toHaveLength(4); // bullet definition plus three ordered lists
  expect(Math.max(...abstractPositions)).toBeLessThan(Math.min(...numberPositions));
  const numbers = wordElements(numbering, 'num');
  expect(new Set(numbers.map(node => wordAttribute(node, 'numId'))).size).toBe(numbers.length);
  for (const [id, start] of [[first, '1'], [restarted, '1'], [fourth, '4']] as const) {
    const definitions = numbers.filter(node => wordAttribute(node, 'numId') === id);
    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    const abstractId = wordAttribute(wordElements(definition, 'abstractNumId')[0], 'val');
    const abstracts = wordElements(numbering, 'abstractNum').filter(node => wordAttribute(node, 'abstractNumId') === abstractId);
    expect(abstracts).toHaveLength(1);
    expect(wordElements(abstracts[0], 'numFmt').every(node => wordAttribute(node, 'val') === 'decimal')).toBe(true);
    const overrides = directWordChildren(definition, 'lvlOverride');
    expect(overrides.map(node => wordAttribute(node, 'ilvl'))).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    for (const override of overrides) {
      const starts = directWordChildren(override, 'startOverride');
      expect(starts).toHaveLength(1);
      expect(wordAttribute(starts[0], 'val')).toBe(start);
    }
  }
});

it('pairs each built-in heading style with its own name and outline level', async () => {
  const { part } = await unpack(Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} heading ${index + 1}`).join('\n\n'));
  const styles = parsePart(await part('word/styles.xml'));
  const document = parsePart(await part('word/document.xml'));
  for (let level = 1; level <= 6; level++) {
    const matching = wordElements(styles, 'style').filter(node => wordAttribute(node, 'styleId') === `Heading${level}`);
    expect(matching).toHaveLength(1);
    const style = matching[0];
    expect(wordAttribute(style, 'type')).toBe('paragraph');
    expect(wordAttribute(directWordChildren(style, 'name')[0], 'val')).toBe(`heading ${level}`);
    expect(wordAttribute(directWordChildren(style, 'basedOn')[0], 'val')).toBe('Normal');
    const properties = directWordChildren(style, 'pPr');
    expect(properties).toHaveLength(1);
    expect(wordAttribute(directWordChildren(properties[0], 'outlineLvl')[0], 'val')).toBe(String(level - 1));
    const heading = wordElements(document, 'p').find(node => node.textContent === `heading ${level}`);
    expect(heading).toBeDefined();
    expect(wordAttribute(wordElements(heading!, 'pStyle')[0], 'val')).toBe(`Heading${level}`);
  }
});

it('checks schema order with borders, alignment and bold hyperlink style present', async () => {
  const source = '# Heading\n\n> Quote\n\n---\n\n1. [**bold link**](https://example.com)\n\n| left | right |\n| :--- | ---: |\n| a | b |';
  const { part } = await unpack(source);
  const documents = await Promise.all(['word/document.xml', 'word/styles.xml', 'word/numbering.xml'].map(async name => parsePart(await part(name))));
  const [document, styles] = documents;
  expect(wordElements(document, 'pBdr').length).toBeGreaterThan(0);
  expect(wordElements(document, 'jc').map(node => wordAttribute(node, 'val'))).toEqual(expect.arrayContaining(['left', 'right']));
  const hyperlink = wordElements(document, 'hyperlink')[0];
  const linkProperties = wordElements(hyperlink, 'rPr')[0];
  expect(Array.from(linkProperties.children, child => child.localName)).toEqual(['rStyle', 'b']);
  expect(wordAttribute(directWordChildren(linkProperties, 'rStyle')[0], 'val')).toBe('Hyperlink');
  expect(wordElements(styles, 'tblBorders').length).toBeGreaterThan(0);
  const orders: Record<string, string[]> = {
    pPr: ['pStyle', 'keepNext', 'numPr', 'pBdr', 'shd', 'spacing', 'ind', 'jc', 'outlineLvl'],
    rPr: ['rStyle', 'rFonts', 'b', 'i', 'strike', 'color', 'sz', 'shd', 'u'],
    tblPr: ['tblStyle', 'tblW', 'jc', 'tblBorders', 'tblLayout', 'tblLook'],
  };
  for (const xml of documents) for (const [tag, order] of Object.entries(orders)) {
    for (const properties of wordElements(xml, tag)) {
      const indices = Array.from(properties.children, child => order.indexOf(child.localName));
      expect(indices.every(index => index >= 0), `${tag} unknown property`).toBe(true);
      expect(indices, `${tag} property order`).toEqual([...indices].sort((a, b) => a - b));
    }
  }
});

it('keeps remote image alt text and fallback URL as external hyperlinks', async () => {
  const read = vi.fn(resolver);
  const { zip, part, warnings } = await unpack('![alternative](https://example.com/a.png) ![](//example.com/b.png)', read);
  expect(read).not.toHaveBeenCalled();
  expect(Object.keys(zip.files).filter(name => name.startsWith('word/media/'))).toHaveLength(0);
  const document = parsePart(await part('word/document.xml'));
  const relations = parsePart(await part('word/_rels/document.xml.rels'));
  const links = wordElements(document, 'hyperlink');
  expect(links).toHaveLength(2);
  expect(links.map(link => link.textContent)).toEqual(['alternative', '//example.com/b.png']);
  for (const [index, expected] of ['https://example.com/a.png', '//example.com/b.png'].entries()) {
    const id = links[index].getAttributeNS(officeRelNs, 'id');
    const matching = Array.from(relations.getElementsByTagNameNS(packageRelNs, 'Relationship')).filter(rel => rel.getAttribute('Id') === id);
    expect(matching).toHaveLength(1);
    expect(matching[0].getAttribute('Target')).toBe(expected);
    expect(matching[0].getAttribute('TargetMode')).toBe('External');
    expect(wordAttribute(wordElements(links[index], 'rStyle')[0], 'val')).toBe('Hyperlink');
  }
  expect(warnings.find(warning => warning.code === 'image-remote')?.count).toBe(2);
});


it('uses unique drawing ids and places the only section properties last in the body', async () => {
  const document = parsePart(await doc('# Heading\n\n![one](one.png) ![two](two.png)\n\nLast paragraph'));
  const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const drawings = Array.from(document.getElementsByTagNameNS(drawingNs, 'docPr'));
  expect(drawings).toHaveLength(2);
  const ids = drawings.map(node => node.getAttribute('id'));
  expect(ids.every(id => id !== null && /^[1-9]\d*$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(drawings.length);
  const bodies = wordElements(document, 'body');
  expect(bodies).toHaveLength(1);
  const sections = directWordChildren(bodies[0], 'sectPr');
  expect(sections).toHaveLength(1);
  expect(bodies[0].lastElementChild).toBe(sections[0]);
});

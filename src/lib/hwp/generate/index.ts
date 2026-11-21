import JSZip from 'jszip';
import { parseMarkdown } from './markdown';
import { documentXml } from './document-xml';
import { XML, element as el, escapeXml } from './xml';
import type { GenerateResult, ResolveImage } from './types';

export type { ExportWarning, GenerateResult, ResolvedImage, ResolveImage } from './types';

/** Markdown → OCF/OWPML package. No worker globals, filesystem or network APIs. */
export async function generateHwpx(markdown: string, resolveImage?: ResolveImage): Promise<GenerateResult> {
  const document = await parseMarkdown(markdown, resolveImage);
  const { header, section } = documentXml(document);
  const zip = new JSZip();
  // This must remain the first local header: STORE, no BOM, no extra field.
  // JSZip writes DOS timestamps from UTC fields; a local-time 1980-01-01 east of UTC wraps to 2107-12-31.
  const date = new Date(Date.UTC(1980, 0, 1));
  const file = (path: string, content: string | Uint8Array, mimeType: string) => ({ path, content, mimeType });
  const entries = [
    file('version.xml', XML + el('hv:HCFVersion', { 'xmlns:hv': 'http://www.hancom.co.kr/hwpml/2011/version',
      tagetApplication: 'WORDPROCESSOR', major: 5, minor: 1, micro: 0, buildNumber: 0, os: 2,
      xmlVersion: '1.4', application: 'MDViewer', appVersion: '0.1.0' }), 'application/xml'),
    file('Contents/header.xml', header, 'application/xml'),
    file('Contents/section0.xml', section, 'application/xml'),
    ...document.images.map(image => file(image.path, image.bytes, image.mimeType)),
  ];
  const opf = 'http://www.idpf.org/2007/opf/';
  const items = [
    { id: 'header', href: 'Contents/header.xml', 'media-type': 'application/xml' },
    { id: 'section0', href: 'Contents/section0.xml', 'media-type': 'application/xml' },
    ...document.images.map(image => ({ id: image.id, href: image.path, 'media-type': image.mimeType, 'isEmbeded': '1' })),
  ];
  const content = XML + el('opf:package', { 'xmlns:opf': opf, 'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
    version: '3.0', 'unique-identifier': '', id: '' },
  el('opf:metadata', {}, el('opf:title', {}, escapeXml('MDViewer 문서'))
      + el('opf:language', {}, 'ko') + el('opf:meta', { name: 'creator', content: 'MDViewer' }))
    + el('opf:manifest', {}, items.map(item => el('opf:item', item)).join(''))
    + el('opf:spine', {}, el('opf:itemref', { idref: 'header', linear: 'yes' }) + el('opf:itemref', { idref: 'section0', linear: 'yes' })));
  entries.push(file('Contents/content.hpf', content, 'application/hwpml-package+xml'));
  entries.push(file('META-INF/container.xml', XML + el('ocf:container', {
    'xmlns:ocf': 'urn:oasis:names:tc:opendocument:xmlns:container', version: '1.0' },
  el('ocf:rootfiles', {}, el('ocf:rootfile', { 'full-path': 'Contents/content.hpf', 'media-type': 'application/hwpml-package+xml' }))), 'application/xml'));
  const manifest = XML + el('manifest:manifest', { 'xmlns:manifest': 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0' },
    el('manifest:file-entry', { 'manifest:full-path': '/', 'manifest:media-type': 'application/hwp+zip' })
    + entries.map(entry => el('manifest:file-entry', { 'manifest:full-path': entry.path, 'manifest:media-type': entry.mimeType })).join(''));
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE', date, createFolders: false });
  for (const entry of entries) zip.file(entry.path, entry.content, { date, createFolders: false });
  zip.file('META-INF/manifest.xml', manifest, { date, createFolders: false });
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 },
    mimeType: 'application/hwp+zip', platform: 'DOS' });
  return { bytes, warnings: document.warnings };
}

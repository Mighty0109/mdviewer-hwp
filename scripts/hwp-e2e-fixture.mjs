import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

// Compose a synthetic regression case in memory. The checked-in parser fixtures
// remain byte-identical to their builders; no private sample is read or copied.
export async function buildCaptionFixture() {
  const zip = await JSZip.loadAsync(await readFile(new URL('../fixtures/hwp/synthetic.hwpx', import.meta.url)));
  const options = { date: new Date('2020-01-01T00:00:00Z'), createFolders: false };
  zip.file('mimetype', 'application/hwp+zip', { ...options, compression: 'STORE' });
  zip.file('Contents/section0.xml', await readFile(new URL('../fixtures/hwp/captions-fields.section.xml', import.meta.url)), options);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination?.endsWith('.hwpx') || extra.length) throw new Error('Usage: node scripts/hwp-e2e-fixture.mjs OUTPUT.hwpx');
  await writeFile(destination, await buildCaptionFixture(), { flag: 'wx' });
}

import * as CFB from 'cfb';
import pako from 'pako';
/** Independent reference decoder used only against read-only real samples.
 * It does not call the parser's record reader, DocInfo mapper, or renderer.
 */
export function sampleImageOracle(input: Uint8Array): Uint8Array[] {
  const cfb = CFB.read(input.slice(), { type: 'array' });
  const data = (path: string) => Uint8Array.from(CFB.find(cfb, path)!.content);
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const compressed = !!(view(data('FileHeader')).getUint32(36, true) & 1);
  const unpack = (b: Uint8Array, inflate = compressed) => inflate ? pako.inflateRaw(b) : b;
  const records = (bytes: Uint8Array) => {
    const result: { tag: number; level: number; bytes: Uint8Array }[] = [];
    const v = view(bytes);
    for (let pos = 0; pos < bytes.length;) {
      const header = v.getUint32(pos, true); pos += 4;
      let size = header >>> 20;
      if (size === 4095) { size = v.getUint32(pos, true); pos += 4; }
      if (pos + size > bytes.length) throw Error('sample record bounds');
      result.push({ tag: header & 1023, level: header >>> 10 & 1023, bytes: bytes.slice(pos, pos + size) });
      pos += size;
    }
    return result;
  };
  const mappings = records(unpack(data('DocInfo'))).filter(r => r.tag === 18);
  const imageBytes = (id: number): Uint8Array | undefined => {
    const bin = mappings[id - 1]?.bytes; if (!bin) return;
    const v = view(bin), flags = v.getUint16(0, true);
    if ((flags & 15) !== 1) return;
    const extLength = v.getUint16(4, true);
    const ext = new TextDecoder('utf-16le').decode(bin.slice(6, 6 + extLength * 2));
    if (!/^(png|jpe?g|bmp|gif)$/i.test(ext)) return;
    const name = `BIN${v.getUint16(2, true).toString(16).padStart(4, '0')}.${ext}`;
    const path = cfb.FullPaths.find(p => p.toLowerCase().endsWith(`/bindata/${name.toLowerCase()}`));
    if (!path) return;
    const mode = flags >>> 4 & 3;
    return unpack(data(path), mode === 1 || (mode === 0 && compressed));
  };
  const output: Uint8Array[] = [];
  const headers = new Map<string, Uint8Array[]>(), footers = new Map<string, Uint8Array[]>();
  type SampleRecord = ReturnType<typeof records>[number];
  const controlId = (record: SampleRecord) => new TextDecoder().decode(record.bytes.slice(0, 4)).split('').reverse().join('').trim();
  const endOf = (items: SampleRecord[], start: number) => {
    let end = start + 1;
    while (end < items.length && items[end].level > items[start].level) end++;
    return end;
  };
  // Compare content-bearing fields, excluding changing instance IDs and page geometry.
  // This independent decoder never calls ParseContext or the production record reader.
  const regionKey = (items: SampleRecord[]) => JSON.stringify(items.flatMap(record => {
    const bytes = record.bytes, v = view(bytes);
    if (record.tag === 67) {
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 2) {
        const char = v.getUint16(offset, true);
        if ((char >= 1 && char <= 9) || char === 11 || char === 12 || (char >= 14 && char <= 23)) {
          if (char === 9) text += '\t';
          offset += 14;
        } else text += String.fromCharCode(char);
      }
      return [[record.tag, text]];
    }
    if (record.tag === 71) return [[record.tag, controlId(record)]];
    if (record.tag === 85) return [[record.tag, v.getUint16(71, true)]];
    const range = record.tag === 66 ? [8, 11] : record.tag === 77 ? [4, 8]
      : record.tag === 72 && bytes.length >= 30 ? [8, 16] : undefined;
    return range ? [[record.tag, ...bytes.slice(range[0], range[1])]] : [];
  }));
  const collect = (items: SampleRecord[], images: Uint8Array[]) => {
    for (let i = 0; i < items.length; i++) {
      const record = items[i];
      if (record.tag === 71) {
        const id = controlId(record);
        if (['head', 'foot', 'fn', 'en'].includes(id)) {
          const end = endOf(items, i);
          if (id === 'head' || id === 'foot') {
            const children = items.slice(i + 1, end), key = regionKey(children);
            const regions = id === 'head' ? headers : footers;
            if (!regions.has(key)) {
              const regionImages: Uint8Array[] = [];
              collect(children, regionImages); regions.set(key, regionImages);
            }
          }
          i = end - 1; continue;
        }
      }
      if (record.tag === 85) {
        const bytes = imageBytes(view(record.bytes).getUint16(71, true));
        if (bytes) images.push(bytes);
      }
    }
  };
  const sections = cfb.FullPaths.filter(p => /\/BodyText\/Section\d+$/.test(p))
    .sort((a, b) => Number(a.match(/Section(\d+)/)![1]) - Number(b.match(/Section(\d+)/)![1]));
  for (const path of sections) collect(records(unpack(data(path))), output);
  return [...headers.values()].flat().concat(output, [...footers.values()].flat());
}

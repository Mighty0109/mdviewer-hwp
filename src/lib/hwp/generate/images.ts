import type { EmbeddedImage, ExportWarning, ResolveImage, ResolvedImage } from './types';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES = 500;

function imageType(bytes: Uint8Array): { ext: string; mimeType: string; width?: number; height?: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
    && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
    return { ext: 'png', mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))) {
    return { ext: 'gif', mimeType: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77) {
    const core = view.getUint32(14, true) === 12;
    return { ext: 'bmp', mimeType: 'image/bmp', width: core ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true)),
      height: core ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true)) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    // Read SOF dimensions when available; otherwise use a neutral fallback.
    let pos = 2;
    while (pos + 4 <= bytes.length && bytes[pos] === 255) {
      const marker = bytes[pos + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) { pos++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
      const length = view.getUint16(pos + 2);
      if (length < 2 || pos + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { ext: 'jpg', mimeType: 'image/jpeg', width: view.getUint16(pos + 7), height: view.getUint16(pos + 5) };
      }
      pos += length + 2;
    }
    return { ext: 'jpg', mimeType: 'image/jpeg' };
  }
  return null;
}

function dataImage(source: string): ResolvedImage {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i.exec(source);
  if (!match || !/^image\/(?:png|jpe?g|gif|bmp)$/i.test(match[1])) throw new Error('format');
  // Bound encoded input before allocating decoded bytes.
  if (match[3].length > MAX_IMAGE_BYTES * 4) throw new Error('size');
  let bytes: Uint8Array;
  if (match[2]) {
    const encoded = match[3].replace(/\s/g, '');
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('size');
    const raw = atob(encoded);
    bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  } else {
    const raw = match[3];
    const output: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '%') {
        if (!/^[0-9a-f]{2}$/i.test(raw.slice(i + 1, i + 3))) throw new Error('format');
        output.push(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2;
      } else {
        output.push(...new TextEncoder().encode(raw[i]));
      }
    }
    bytes = new Uint8Array(output);
  }
  return { bytes, mimeType: match[1] };
}

export function createImageLoader(resolveImage: ResolveImage | undefined, warnings: ExportWarning[]) {
  const images: EmbeddedImage[] = [];
  let totalBytes = 0;
  const warn = (code: ExportWarning['code'], detail: string) => {
    const existing = warnings.find(w => w.code === code && w.detail === detail);
    if (existing) existing.count++; else warnings.push({ code, count: 1, detail });
  };
  async function load(source: string, alt: string): Promise<EmbeddedImage | null> {
    // Never send network URLs to a resolver, including protocol-relative URLs.
    if (/^(?:https?:|\/\/)/i.test(source.trim())) {
      warn('image-remote', '외부 네트워크 이미지는 포함하지 않았습니다.'); return null;
    }
    if (images.length >= MAX_IMAGES) {
      warn('image-limit', `그림 개수 상한 ${MAX_IMAGES}개를 넘었습니다.`); return null;
    }
    let resolved: ResolvedImage;
    try {
      const value = /^data:/i.test(source) ? dataImage(source) : await resolveImage?.(source);
      if (!value) { warn('image-missing', '그림 파일을 읽지 못했습니다.'); return null; }
      resolved = value instanceof Uint8Array ? { bytes: value } : value;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      warn(/^data:/i.test(source) ? (reason === 'size' ? 'image-limit' : 'image-format') : 'image-missing',
        /^data:/i.test(source) ? '데이터 이미지 형식 또는 크기를 확인해 주세요.' : '그림 파일을 읽지 못했습니다.');
      return null;
    }
    if (!(resolved.bytes instanceof Uint8Array)) { warn('image-format', '이미지 바이트가 올바르지 않습니다.'); return null; }
    if (resolved.bytes.byteLength > MAX_IMAGE_BYTES || totalBytes + resolved.bytes.byteLength > MAX_TOTAL_BYTES) {
      warn('image-limit', '그림 1개 8MB 또는 그림 합계 64MB 상한을 넘었습니다.'); return null;
    }
    const format = imageType(resolved.bytes);
    if (!format) { warn('image-format', 'PNG·JPEG·GIF·BMP 이미지만 포함합니다.'); return null; }
    const validDimension = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n > 0 && n <= 1_000_000;
    const id = `image${images.length + 1}`;
    const image: EmbeddedImage = {
      id, path: `BinData/${id}.${format.ext}`, mimeType: format.mimeType,
      // Snapshot resolver buffers; packaging must not observe subsequent mutations.
      bytes: resolved.bytes.slice(),
      width: validDimension(format.width) ? format.width! : validDimension(resolved.width) ? resolved.width! : 640,
      height: validDimension(format.height) ? format.height! : validDimension(resolved.height) ? resolved.height! : 480,
      alt,
    };
    totalBytes += image.bytes.byteLength;
    images.push(image);
    return image;
  }
  return { images, load };
}

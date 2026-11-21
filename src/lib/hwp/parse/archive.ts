import pako from 'pako';
import { HwpImportError, MAX_ARCHIVE_ENTRIES, MAX_ENTRY_BYTES, MAX_UNPACKED_BYTES } from '@/domain/hwp-warnings';
import type { ParseContext } from './context';
const fail = (): never => { throw new HwpImportError('corrupt', '손상된 ZIP 패키지입니다.'); };
export function inflateBounded(bytes: Uint8Array, limit = MAX_ENTRY_BYTES, raw = true): Uint8Array {
  const chunks: Uint8Array[] = []; let total = 0;
  const stream = new pako.Inflate({ raw, chunkSize: 64 * 1024 });
  let finished = false;
  const onEnd = stream.onEnd.bind(stream);
  stream.onEnd = status => { finished = true; onEnd(status); };
  stream.onData = value => {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    total += chunk.length;
    if (total > limit) throw new HwpImportError('unpacked-too-large', '압축 해제 항목의 크기 제한을 초과했습니다.');
    chunks.push(chunk);
  };
  stream.push(bytes, true);
  if (stream.err || !finished) fail();
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Inspect declared sizes before allocating; stream inflation also checks actual output. */
export function openZip(bytes: Uint8Array, ctx: ParseContext): Map<string, () => Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => p >= 0 && p + 2 <= bytes.length ? view.getUint16(p, true) : fail();
  const u32 = (p: number) => p >= 0 && p + 4 <= bytes.length ? view.getUint32(p, true) : fail();
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length) fail();
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail();
  const count = u16(end + 10); const start = u32(end + 16); const size = u32(end + 12);
  if (count > MAX_ARCHIVE_ENTRIES) throw new HwpImportError('unpacked-too-large', 'ZIP 항목이 2000개를 초과합니다.');
  if (start + size !== end) fail();
  const entries = new Map<string, () => Uint8Array>(); let offset = start; let declared = 0;
  for (let i = 0; i < count; i++) {
    if (u32(offset) !== 0x02014b50) fail();
    const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16);
    const compressed = u32(offset + 20), unpacked = u32(offset + 24), nameLength = u16(offset + 28);
    const local = u32(offset + 42);
    if (flags & 1) throw new HwpImportError('encrypted', '암호화된 ZIP 항목은 가져올 수 없습니다.');
    declared += unpacked;
    if (unpacked > MAX_ENTRY_BYTES || declared > MAX_UNPACKED_BYTES)
      throw new HwpImportError('unpacked-too-large', 'ZIP 압축 해제 크기 제한을 초과합니다.');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.') || entries.has(name)) fail();
    if (u32(local) !== 0x04034b50 || u16(local + 8) !== method || u16(local + 6) !== flags) fail();
    const localName = new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + u16(local + 26)));
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    if (localName !== name || dataStart + compressed > start || (method !== 0 && method !== 8)) fail();
    let cached: Uint8Array | undefined;
    entries.set(name, () => {
      if (cached) return cached;
      const payload = bytes.subarray(dataStart, dataStart + compressed);
      const output = method === 0 ? payload.slice() : inflateBounded(payload, unpacked);
      if (output.length !== unpacked || crc32(output) !== crc) fail();
      ctx.budget(output.length); cached = output; return output;
    });
    offset += 46 + nameLength + u16(offset + 30) + u16(offset + 32);
    if (offset > end) fail();
  }
  if (offset !== end) fail();
  return entries;
}

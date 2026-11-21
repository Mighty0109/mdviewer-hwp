import { HwpImportError, MAX_ARCHIVE_ENTRIES, MAX_ENTRY_BYTES, MAX_UNPACKED_BYTES } from '@/domain/hwp-warnings';
const fail = (): never => { throw new HwpImportError('corrupt', 'CFB 저장소 구조가 손상되었습니다.'); };
/** Bound directory/FAT graphs before cfb follows pointers or builds full paths. */
export function preflightCfb(bytes: Uint8Array): void {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => p >= 0 && p + 2 <= bytes.length ? v.getUint16(p, true) : fail();
  const u32 = (p: number) => p >= 0 && p + 4 <= bytes.length ? v.getUint32(p, true) : fail();
  if (bytes.length < 512) fail();
  const major = u16(26), shift = u16(30);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || u16(32) !== 6) fail();
  const sectorSize = 2 ** shift, sectorCount = bytes.length / sectorSize - 1, perFat = sectorSize / 4;
  if (!Number.isInteger(sectorCount) || sectorCount < 1) fail();
  const sectorOffset = (n: number) => n < sectorCount ? (n + 1) * sectorSize : fail();
  const fatCount = u32(44), difatCount = u32(72), fatSectors: number[] = [];
  if (fatCount < 1 || fatCount > sectorCount
    || difatCount > 512 || difatCount > Math.ceil(Math.max(0, fatCount - 109) / (perFat - 1)) + 1) fail();
  for (let i = 0; i < 109; i++) { const n = u32(76 + i * 4); if (n < 0xfffffffa) fatSectors.push(n); }
  let difat = u32(68); const seenDifat = new Set<number>();
  for (let i = 0; i < difatCount; i++) {
    if (seenDifat.has(difat)) fail(); seenDifat.add(difat);
    const p = sectorOffset(difat);
    for (let j = 0; j < perFat - 1; j++) { const n = u32(p + j * 4); if (n < 0xfffffffa) fatSectors.push(n); }
    difat = u32(p + sectorSize - 4);
  }
  if (fatSectors.length !== fatCount || new Set(fatSectors).size !== fatCount) fail();
  const fat: number[] = [];
  for (const sector of fatSectors) {
    const offset = sectorOffset(sector);
    for (let i = 0; i < perFat && fat.length < sectorCount; i++) fat.push(u32(offset + i * 4));
  }
  if (fat.length < sectorCount) fail();
  // Tri-colour traversal detects cycles in O(sectors), including otherwise unused chains.
  const state = new Uint8Array(sectorCount);
  for (let i = 0; i < sectorCount; i++) {
    const path: number[] = []; let n = i;
    while (n < 0xfffffffa && state[n] !== 2) {
      if (n >= sectorCount || state[n] === 1) fail();
      state[n] = 1; path.push(n); n = fat[n];
    }
    for (const part of path) state[part] = 2;
  }
  const chain = (start: number): number[] => {
    const result: number[] = []; let n = start;
    while (n < 0xfffffffa) {
      if (n >= sectorCount || result.length >= sectorCount) fail();
      result.push(n); n = fat[n];
    }
    if (n !== 0xfffffffe) fail();
    return result;
  };
  const directory = chain(u32(48));
  const slots = directory.flatMap(n => Array.from({ length: sectorSize / 128 }, (_, i) => sectorOffset(n) + i * 128));
  const active = slots.filter(p => bytes[p + 66] !== 0);
  if (active.length > MAX_ARCHIVE_ENTRIES) throw new HwpImportError('unpacked-too-large', 'CFB 항목이 2000개를 초과합니다.');
  if (!slots.length || bytes[slots[0] + 66] !== 5) fail();
  let total = 0;
  for (const p of active) {
    const size = u32(p + 120);
    if (u32(p + 124) !== 0 || size > MAX_ENTRY_BYTES) throw new HwpImportError('unpacked-too-large', 'CFB 스트림 크기 제한을 초과합니다.');
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw new HwpImportError('unpacked-too-large', 'CFB 전체 크기 제한을 초과합니다.');
    if (![1, 2, 5].includes(bytes[p + 66]) || u16(p + 64) < 2 || u16(p + 64) > 64 || u16(p + 64) % 2) fail();
  }
  const visited = new Set<number>(); const queue = [{ id: 0, depth: 0 }];
  while (queue.length) {
    const { id, depth } = queue.pop()!;
    if (visited.has(id) || id >= slots.length || depth > 128 || !bytes[slots[id] + 66]) fail();
    visited.add(id); const p = slots[id];
    for (const offset of [68, 72, 76]) {
      const target = u32(p + offset);
      if (target !== 0xffffffff) queue.push({ id: target, depth: depth + (offset === 76 ? 1 : 0) });
    }
  }
  if (visited.size !== active.length) fail();
  // A truncated/cyclic mini FAT must never be expanded using forged stream sizes.
  const miniChain = u32(64) ? chain(u32(60)) : [];
  if (miniChain.length < u32(64)) fail();
  const miniFat = miniChain.flatMap(n => Array.from({ length: perFat }, (_, i) => u32(sectorOffset(n) + i * 4)));
  const miniLimit = Math.ceil(u32(slots[0] + 120) / 64);
  for (const p of active) {
    const size = u32(p + 120); if (!size || bytes[p + 66] === 1) continue;
    const start = u32(p + 116);
    if (size >= 4096 || bytes[p + 66] === 5) {
      if (chain(start).length * sectorSize < size) fail();
    } else {
      const seen = new Set<number>(); let n = start; let capacity = 0;
      while (n !== 0xfffffffe) {
        if (n >= miniFat.length || n >= miniLimit || seen.has(n)) fail();
        seen.add(n); capacity += 64; n = miniFat[n];
      }
      if (capacity < size) fail();
    }
  }
}

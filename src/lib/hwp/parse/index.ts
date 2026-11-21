import { HwpImportError, MAX_HWP_BYTES, type HwpImportResult, type HwpProgress } from '@/domain/hwp-warnings';
import { parseBinary } from './binary';
import { parseHwpxBytes } from './hwpx';
export type { HwpImportResult, HwpProgress, ImportWarning, ImportWarningCode, ImportStats } from '@/domain/hwp-warnings';
export type { ImportAsset } from '@/domain/hwp-assets';
export { HwpImportError } from '@/domain/hwp-warnings';
/** Pure, read-only parser. The optional expected format lets callers reject extension mismatches. */
export async function parseHwp(bytes: Uint8Array, onProgress?: HwpProgress, expectedFormat?: 'hwp' | 'hwpx'): Promise<HwpImportResult> {
  if (bytes.length > MAX_HWP_BYTES) throw new HwpImportError('too-large', '한글 파일은 20MB까지 가져올 수 있습니다.');
  onProgress?.(0, '한글 문서 확인 중');
  const isCfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if ((!isCfb && !isZip) || (expectedFormat === 'hwp' && !isCfb) || (expectedFormat === 'hwpx' && !isZip))
    throw new HwpImportError('unsupported-format', 'HWP 5.x 또는 HWPX 문서가 아니거나 확장자가 일치하지 않습니다.');
  try {
    const result = isCfb ? parseBinary(bytes, onProgress) : parseHwpxBytes(bytes, onProgress);
    onProgress?.(100, '한글 문서 변환 완료'); return result;
  } catch (error) {
    if (error instanceof HwpImportError) throw error;
    throw new HwpImportError('corrupt', '손상되었거나 올바르지 않은 한글 문서입니다.');
  }
}
export const parseHwpx = (bytes: Uint8Array, onProgress?: HwpProgress) => parseHwp(bytes, onProgress, 'hwpx');

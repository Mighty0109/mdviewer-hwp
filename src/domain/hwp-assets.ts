export const IMPORT_ASSET_PREFIX = 'mdviewer-import-assets/';
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_IMAGES = 500;
export interface ImportAsset { name: string; mimeType: string; bytes: Uint8Array }
export type ImageSkipReason = 'format' | 'size' | 'count' | 'missing';
export function imageFormat(name: string): { extension: string; mimeType: string } | undefined {
  const ext = name.toLowerCase().split('.').pop();
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
  return ext && mime[ext] ? { extension: ext === 'jpeg' ? 'jpg' : ext, mimeType: mime[ext] } : undefined;
}
export function imagePlaceholder(index: number, reason: ImageSkipReason): string {
  return `[이미지 ${index} 제외: ${reason}]`;
}

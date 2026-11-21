import { resolveImagePath } from '@/domain/resolve-image-path';
import { localImageUrl } from '@/data/tauri-bridge';

/** Image input keeps its Markdown destination while resolving only the display URL. */
export function editorImageAttributes(input: string, documentPath: string) {
  const mdSrc = input.trim();
  if (!mdSrc || /^(?:data|blob|javascript):/i.test(mdSrc)) return null;
  const resolved = resolveImagePath(mdSrc, documentPath);
  if (!resolved) return null;
  return { src: /^https?:/i.test(resolved) ? resolved : localImageUrl(resolved), mdSrc, alt: '' };
}

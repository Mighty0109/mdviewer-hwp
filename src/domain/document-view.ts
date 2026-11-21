import type { ViewMode } from '@/types/editor';
import { ORIGINAL_VIEW_LABELS } from './original-view';

export type DisplayMode = ViewMode | 'original';
export function viewButtons(hasOriginal: boolean): readonly { mode: DisplayMode; label: string }[] {
  return [hasOriginal ? { mode: 'original', label: ORIGINAL_VIEW_LABELS.original } : { mode: 'wysiwyg', label: '블록' },
    { mode: 'source', label: '소스' }, { mode: 'split', label: '분할' }];
}
export function resolveDisplayMode(base: ViewMode, hasOriginal: boolean, showOriginal: boolean): DisplayMode {
  if (!hasOriginal) return base;
  if (showOriginal) return 'original';
  return base === 'wysiwyg' ? 'source' : base;
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { resolveDisplayMode, viewButtons, type DisplayMode } from '@/domain/document-view';
import { ORIGINAL_VIEW_LABELS, type OriginalDocument, type OriginalViewMode } from '@/domain/original-view';
import type { ViewMode } from '@/types/editor';
import type { OriginalViewState } from './use-original-view';

export function useDocumentView(source: OriginalDocument | null, draft: { mode: ViewMode; changeMode(mode: ViewMode): void }, status: OriginalViewState['status'], errorMessage: string | null) {
  const [state, setState] = useState({ source, show: true, auto: true });
  const cur = state.source === source ? state : { source, show: true, auto: true };
  const failed = !!source && cur.show && cur.auto && status === 'error';
  const mode = resolveDisplayMode(draft.mode, !!source, cur.show && !failed);
  const { changeMode: changeDraftMode } = draft;
  const changeMode = useCallback((next: DisplayMode) => {
    if (next === 'original') setState({ source, show: true, auto: false });
    else { setState({ source, show: false, auto: false }); changeDraftMode(next); }
  }, [source, changeDraftMode]);
  const exitOriginal = useCallback(() => setState({ source, show: false, auto: false }), [source]);
  return { mode, buttons: viewButtons(!!source), changeMode, exitOriginal,
    originalNotice: failed ? `${ORIGINAL_VIEW_LABELS.error} ${errorMessage ?? ''}`.trim() : null };
}
export function useOriginalDisplaySync(mode: DisplayMode, original: OriginalViewState, setOriginalMode: (mode: OriginalViewMode) => void) {
  useEffect(() => {
    if (mode === 'original' && original.available && original.mode !== 'original') setOriginalMode('original');
  }, [mode, original.available, original.mode, setOriginalMode]);
}

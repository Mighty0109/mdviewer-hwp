'use client';

import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import { reportE2eState } from '@/data/tauri-bridge';
import type { ExportReport } from '@/types/hwp';
import type { OpenFileState } from './open-file-session';
import type { OriginalViewState } from './use-original-view';
import type { OriginalDocument } from '@/domain/original-view';
import type { ViewMode } from '@/types/editor';
import { useReaderReportOriginalTiming } from './use-reader-report-original-timing';

// Passed through the existing MDVIEWER_E2E_QUERY / e2e_config IPC field.
export const ORIGINAL_VIEW_E2E_QUERY = '@original-view';

export function useReaderReport(state: OpenFileState & { exportResult?: ExportReport | null }, editor: Editor | null, query: string, matches: number, edit: { applied: boolean; mode: 'rich' | 'source' } = { applied: false, mode: state.unsupported.length ? 'source' : 'rich' }, original?: OriginalViewState, changeMode?: (mode: ViewMode) => void) {
  const reports = useRef<Promise<void>>(Promise.resolve());
  const openedOriginals = useRef(new WeakSet<OriginalDocument>());
  const { setMode: setOriginalMode, timings } = useReaderReportOriginalTiming(!!state.e2e, state.original, original);
  useEffect(() => {
    if (state.e2e?.query !== ORIGINAL_VIEW_E2E_QUERY || state.isLoading || !state.original
      || !original?.available || openedOriginals.current.has(state.original)) return;
    openedOriginals.current.add(state.original);
    changeMode?.('split');
    setOriginalMode('original');
  }, [state.e2e?.query, state.isLoading, state.original, original?.available, setOriginalMode, changeMode]);
  useEffect(() => {
    if (!state.e2e) return;
    let timeout: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const report = () => {
      clearTimeout(timeout);
      // Let TipTap transactions and the TOC's React update settle first.
      timeout = setTimeout(() => {
        if (cancelled) return;
        const root = editor && !editor.isDestroyed ? editor.view.dom : null;
        const images = root ? [...root.querySelectorAll('img')] : [];
        const json = {
          importResult: state.importResult, exportResult: state.exportResult ?? null,
          originalView: {
            available: original?.available ?? false, mode: original?.mode ?? 'markdown', pages: original?.pages ?? 0,
            imgBlobCount: document.querySelectorAll('img[src^="blob:"]').length,
            svgInDom: document.querySelectorAll('[data-original-view] svg').length,
            errorMessage: original?.errorMessage ?? null, ...timings,
          },
          path: state.file?.path ?? null, hash: state.file?.hash ?? null, loadCount: state.loadCount,
          render: {
            headings: root?.querySelectorAll('h1,h2,h3,h4,h5,h6').length ?? 0,
            tables: root?.querySelectorAll('table').length ?? 0,
            codeBlocks: root?.querySelectorAll('pre').length ?? 0,
            taskItems: root?.querySelectorAll('li[data-type="taskItem"]').length ?? 0,
            images: images.length,
            imagesLoaded: images.filter((image) => image.naturalWidth > 0).length,
          },
          edit: { applied: edit.applied, dirty: state.dirty, saveStatus: state.saveStatus, mode: edit.mode },
          tocItems: document.querySelectorAll('[data-toc-item]').length,
          search: { query, matches }, error: state.error,
        };
        // Preserve report order even when several images finish together.
        reports.current = reports.current.catch(() => {}).then(() => reportE2eState(json));
        void reports.current.catch((error) => console.error('e2e 상태 기록 실패', error));
      }, 40);
    };
    const root = editor && !editor.isDestroyed ? editor.view.dom : null;
    root?.addEventListener('load', report, true);
    root?.addEventListener('error', report, true);
    editor?.on('transaction', report);
    report();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      root?.removeEventListener('load', report, true);
      root?.removeEventListener('error', report, true);
      editor?.off('transaction', report);
    };
  }, [state.importResult, state.exportResult, state.e2e, state.file, state.loadCount, state.error, editor, query, matches, state.dirty, state.saveStatus, edit.applied, edit.mode, original?.available, original?.mode, original?.pages, original?.status, original?.errorMessage, original?.pageUrls, original?.currentPage, timings]);
  return setOriginalMode;
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ORIGINAL_VIEW_LABELS, OriginalViewError, type OriginalDocument, type OriginalViewAdapter, type OriginalViewDocument, type OriginalViewMode } from '@/domain/original-view';
import { createRhwpAdapter } from '@/lib/hwp/rhwp';

export interface OriginalViewState {
  available: boolean;
  mode: OriginalViewMode;
  /** Total page count; currentPage and pageUrls use zero-based indexes. */
  pages: number;
  currentPage: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage: string | null;
  pageUrls: Readonly<Record<number, string>>;
  setMode(mode: OriginalViewMode): void;
  setCurrentPage(pageIndex: number): void;
}
type PageState = Pick<OriginalViewState, 'pages' | 'status' | 'errorMessage' | 'pageUrls'>;
const idle: PageState = { pages: 0, status: 'idle', errorMessage: null, pageUrls: {} };

/** Read-only import snapshot. The default adapter is lazy; tests inject a fake. */
export function useOriginalView(original: OriginalDocument | null | undefined,
  adapter: OriginalViewAdapter = createRhwpAdapter()): OriginalViewState {
  const [selection, setSelection] = useState({ original, mode: 'markdown' as OriginalViewMode, currentPage: 0 });
  const [state, setState] = useState(idle);
  const requestedPage = useRef(0);
  const requestRender = useRef<(() => void) | null>(null);
  const mode = selection.original === original ? selection.mode : 'markdown';
  const currentPage = selection.original === original ? selection.currentPage : 0;
  useEffect(() => {
    setSelection({ original, mode: 'markdown', currentPage: 0 });
  }, [original]);

  useEffect(() => {
    if (!original || mode !== 'original') { setState(idle); return; }
    let cancelled = false;
    let document: OriginalViewDocument | undefined;
    const urls = new Map<number, string>();
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      cancelled = true; clearTimeout(timer); requestRender.current = null;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear(); document?.dispose(); document = undefined;
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      const pages = document?.pageCount ?? 0;
      release();
      const reason = error instanceof OriginalViewError ? error.reason : error instanceof Error ? error.message : '';
      setState({ ...idle, pages, status: 'error', errorMessage: reason.trim() || ORIGINAL_VIEW_LABELS.error });
    };
    const publish = () => setState({ pages: document!.pageCount, pageUrls: Object.fromEntries(urls),
      status: urls.has(requestedPage.current) ? 'ready' : 'loading', errorMessage: null });
    const renderNext = async () => {
      if (cancelled || running || !document) return;
      clearTimeout(timer);
      const target = requestedPage.current;
      const page = [target, target - 1, target + 1].find(index => index >= 0 && index < document!.pageCount && !urls.has(index));
      if (page === undefined) { publish(); return; }
      running = true;
      try {
        const blob = await document.renderPage(page);
        if (cancelled) return;
        urls.set(page, URL.createObjectURL(blob));
        publish();
        running = false;
        // Yield between pages so neighbors are not rendered in one blocking batch.
        timer = setTimeout(() => { void renderNext(); }, 0);
      } catch (error) { fail(error); }
    };
    requestRender.current = () => { if (document) publish(); void renderNext(); };
    setState({ ...idle, status: 'loading' });
    void Promise.resolve().then(() => adapter.open(original)).then(opened => {
      if (cancelled) { opened.dispose(); return; }
      document = opened;
      publish();
      void renderNext();
    }).catch(fail);
    return release;
  }, [original, adapter, mode]);

  useEffect(() => {
    requestedPage.current = currentPage;
    requestRender.current?.();
  }, [currentPage]);

  const setMode = useCallback((mode: OriginalViewMode) => {
    const nextMode = original ? mode : 'markdown';
    setSelection(previous => previous.original === original && previous.mode === nextMode ? previous
      : { original, mode: nextMode, currentPage: 0 });
  }, [original]);
  const setCurrentPage = useCallback((currentPage: number) => {
    if (mode !== 'original' || !Number.isInteger(currentPage) || currentPage < 0 || currentPage >= state.pages) return;
    setSelection(selection => ({ ...selection, currentPage }));
  }, [mode, state.pages]);
  return { ...(mode === 'original' ? state : idle), available: !!original, mode, currentPage, setMode, setCurrentPage };
}

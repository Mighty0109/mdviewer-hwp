// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useDocumentView, useOriginalDisplaySync } from './use-document-view';
import type { OriginalDocument } from '@/domain/original-view';
import type { ViewMode } from '@/types/editor';
import type { OriginalViewState } from './use-original-view';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement; let root: Root; let source: OriginalDocument | null; let base: ViewMode; let status: OriginalViewState['status']; let result: ReturnType<typeof useDocumentView>;
const change = vi.fn();
const a: OriginalDocument = { bytes: Uint8Array.of(1), kind: 'hwp' };
function Probe() { const view = useDocumentView(source, { mode: base, changeMode: change }, status, '손상'); useEffect(() => { result = view; }); return null; }
const render = () => act(async () => root.render(<Probe />));
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); source = a; base = 'wysiwyg'; status = 'ready'; change.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it('starts with original for a new import', async () => { await render(); expect(result.mode).toBe('original'); });
it('changes to source and keeps the selection across rerenders', async () => { await render(); await act(async () => result.changeMode('source')); base = 'source'; await render(); expect(result.mode).toBe('source'); expect(change).toHaveBeenCalledExactlyOnceWith('source'); });
it('starts original again for a different import', async () => { await render(); await act(async () => result.changeMode('source')); source = { ...a }; await render(); expect(result.mode).toBe('original'); });
it('preserves Markdown mode and block label', async () => { source = null; base = 'split'; await render(); expect(result.mode).toBe('split'); expect(result.buttons[0].label).toBe('블록'); });
it('falls back and shows a reason on automatic failure', async () => { status = 'error'; await render(); expect(result.mode).toBe('source'); expect(result.originalNotice).toContain('원본 모양을 표시하지 못했습니다. 손상'); });
it('keeps manual original failures on the original screen', async () => { await render(); await act(async () => result.changeMode('original')); status = 'error'; await render(); expect(result.mode).toBe('original'); expect(result.originalNotice).toBeNull(); });
it('exits without changing the persisted mode', async () => { await render(); await act(async () => result.exitOriginal()); expect(result.mode).toBe('source'); expect(change).not.toHaveBeenCalled(); });
it('synchronizes only when original mode needs opening', async () => {
  const set = vi.fn(); const original = { available: true, mode: 'markdown' } as OriginalViewState;
  function Sync({ mode, state }: { mode: 'original' | 'source'; state: OriginalViewState }) { useOriginalDisplaySync(mode, state, set); return null; }
  await act(async () => root.render(<Sync mode="original" state={original} />)); expect(set).toHaveBeenCalledExactlyOnceWith('original');
  set.mockClear(); await act(async () => root.render(<Sync mode="source" state={original} />)); await act(async () => root.render(<Sync mode="original" state={{ ...original, mode: 'original' }} />)); expect(set).not.toHaveBeenCalled();
});

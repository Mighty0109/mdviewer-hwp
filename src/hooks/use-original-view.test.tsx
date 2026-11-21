// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OriginalViewError, type OriginalDocument, type OriginalViewAdapter, type OriginalViewDocument } from '@/domain/original-view';
import { useOriginalView } from './use-original-view';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original: OriginalDocument = { bytes: Uint8Array.of(1, 2, 3), kind: 'hwp' };
const unmounts: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  let sequence = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:original-${++sequence}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.useRealTimers(); vi.restoreAllMocks();
});
function fakeAdapter(pageCount = 5) {
  const document = { pageCount, renderPage: vi.fn<OriginalViewDocument['renderPage']>(async () => new Blob(['page'], { type: 'image/svg+xml' })),
    dispose: vi.fn() };
  const adapter = { open: vi.fn<OriginalViewAdapter['open']>(async () => document) };
  return { adapter, document };
}
async function mount(source: OriginalDocument | null, adapter: OriginalViewAdapter) {
  let view!: ReturnType<typeof useOriginalView>;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); let mounted = true;
  function Probe({ source }: { source: OriginalDocument | null }) {
    view = useOriginalView(source, adapter);
    const [draft, setDraft] = useState('마크다운');
    return <>
      <textarea aria-label="편집" value={draft} onInput={event => setDraft(event.currentTarget.value)} />
      {view.errorMessage && <p role="alert">{view.errorMessage}</p>}
      {Object.entries(view.pageUrls).map(([page, url]) => <img key={page} src={url} alt={`원본 ${Number(page) + 1}쪽`} />)}
    </>;
  }
  const rerender = (source: OriginalDocument | null) => act(async () => { root.render(<Probe source={source} />); });
  const unmount = async () => {
    if (mounted) { mounted = false; await act(async () => root.unmount()); container.remove(); }
  };
  unmounts.push(unmount); await rerender(source);
  return { get view() { return view; }, container, rerender, unmount };
}
const flush = () => act(async () => { await vi.runAllTimersAsync(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('original view model', () => {
  it('opens an available original only after switching from Markdown', async () => {
    const { adapter } = fakeAdapter(); const h = await mount(original, adapter);
    expect(h.view).toMatchObject({ available: true, mode: 'markdown', status: 'idle', pages: 0, currentPage: 0, errorMessage: null });
    expect(adapter.open).not.toHaveBeenCalled();
    await act(async () => h.view.setMode('original'));
    await flush();
    expect(adapter.open).toHaveBeenCalledExactlyOnceWith(original);
    expect(h.view).toMatchObject({ mode: 'original', status: 'ready', pages: 5 });
  });
  it('renders only the current page and its neighbors, reusing cached blob URLs on return', async () => {
    const { adapter, document } = fakeAdapter(20); const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    expect(document.renderPage.mock.calls.map(([page]) => page)).toEqual([0, 1]);
    const firstUrl = h.view.pageUrls[0]; expect(firstUrl).toMatch(/^blob:/);
    await act(async () => h.view.setCurrentPage(3)); await flush();
    expect(document.renderPage.mock.calls.map(([page]) => page)).toEqual([0, 1, 3, 2, 4]);
    expect(h.view).toMatchObject({ currentPage: 3, status: 'ready', pages: 20 });
    await act(async () => h.view.setCurrentPage(1)); await flush();
    expect(document.renderPage).toHaveBeenCalledTimes(5);
    expect(h.view.pageUrls[0]).toBe(firstUrl); expect(adapter.open).toHaveBeenCalledOnce();
  });
  it('reports an adapter error reason without interrupting Markdown editing', async () => {
    const { adapter } = fakeAdapter();
    adapter.open.mockRejectedValueOnce(new OriginalViewError('wasm-load', '원본 모듈을 불러올 수 없습니다.'));
    const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    expect(h.view).toMatchObject({ status: 'error', errorMessage: '원본 모듈을 불러올 수 없습니다.' });
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe(h.view.errorMessage);
    const editor = h.container.querySelector('textarea')!;
    await act(async () => { editor.value = '오류 뒤에도 수정'; editor.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(editor.value).toBe('오류 뒤에도 수정');
    await act(async () => h.view.setMode('markdown'));
    expect(h.view).toMatchObject({ status: 'idle', errorMessage: null });
    expect(editor.value).toBe('오류 뒤에도 수정');
  });
  it('releases already-rendered pages and the document when a later page fails', async () => {
    const { adapter, document } = fakeAdapter();
    document.renderPage.mockRejectedValueOnce(new OriginalViewError('render', '1쪽을 그리지 못했습니다.'));
    const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    expect(h.view).toMatchObject({ status: 'error', errorMessage: '1쪽을 그리지 못했습니다.', pageUrls: {} });
    expect(document.dispose).toHaveBeenCalledOnce();
    await act(async () => h.view.setMode('markdown'));
    document.renderPage.mockResolvedValueOnce(new Blob(['first'])).mockRejectedValueOnce(new OriginalViewError('render', '2쪽 오류'));
    await act(async () => h.view.setMode('original')); await flush();
    expect(h.view).toMatchObject({ status: 'error', errorMessage: '2쪽 오류', pageUrls: {} });
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:original-1');
    expect(document.dispose).toHaveBeenCalledTimes(2);
  });
  it('ignores invalid page selections and preserves the page when reselecting the active mode', async () => {
    const { adapter } = fakeAdapter(2); const h = await mount(original, adapter);
    await act(async () => h.view.setCurrentPage(1));
    expect(h.view.currentPage).toBe(0);
    await act(async () => h.view.setMode('original')); await flush();
    await act(async () => h.view.setCurrentPage(1)); await flush();
    for (const page of [-1, 2, 0.5, NaN, Infinity]) {
      await act(async () => h.view.setCurrentPage(page));
      expect(h.view.currentPage).toBe(1);
    }
    await act(async () => h.view.setMode('original')); await flush();
    expect(h.view.currentPage).toBe(1); expect(adapter.open).toHaveBeenCalledOnce();
  });
  it('keeps ordinary Markdown unavailable and never opens the adapter', async () => {
    const { adapter } = fakeAdapter(); const h = await mount(null, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    expect(h.view).toMatchObject({ available: false, mode: 'markdown', status: 'idle', pages: 0, pageUrls: {} });
    expect(adapter.open).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('revokes every cached URL and disposes on Markdown return, then opens afresh', async () => {
    const { adapter, document } = fakeAdapter(2); const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    const oldUrls = Object.values(h.view.pageUrls);
    await act(async () => h.view.setMode('markdown'));
    expect(h.view).toMatchObject({ status: 'idle', pages: 0, pageUrls: {}, currentPage: 0 });
    expect(document.dispose).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(oldUrls.length);
    for (const url of oldUrls) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    await act(async () => h.view.setMode('original')); await flush();
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(Object.values(h.view.pageUrls).some(url => oldUrls.includes(url))).toBe(false);
  });
  it('resets mode and releases the prior original on document replacement and close', async () => {
    const { adapter, document } = fakeAdapter(); const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    await act(async () => h.view.setCurrentPage(2)); await flush();
    const replacement: OriginalDocument = { bytes: Uint8Array.of(4), kind: 'hwpx' };
    await h.rerender(replacement);
    expect(h.view).toMatchObject({ available: true, mode: 'markdown', pages: 0, currentPage: 0, pageUrls: {} });
    expect(document.dispose).toHaveBeenCalledOnce(); expect(adapter.open).toHaveBeenCalledOnce();
    await act(async () => h.view.setMode('original')); await flush();
    expect(adapter.open).toHaveBeenLastCalledWith(replacement);
    await h.rerender(null);
    expect(h.view).toMatchObject({ available: false, mode: 'markdown', pages: 0, pageUrls: {} });
    expect(document.dispose).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(6);
  });
  it('disposes and revokes on unmount without rendering queued neighboring pages', async () => {
    const { adapter, document } = fakeAdapter(); const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original'));
    expect(document.renderPage).toHaveBeenCalledExactlyOnceWith(0);
    await h.unmount(); await flush();
    expect(document.dispose).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:original-1');
    expect(document.renderPage).toHaveBeenCalledOnce();
  });
  it('disposes a late open after replacement without disturbing the next document', async () => {
    const { adapter, document: first } = fakeAdapter(); const second = fakeAdapter(2).document;
    const opening = deferred<OriginalViewDocument>();
    adapter.open.mockReturnValueOnce(opening.promise).mockResolvedValueOnce(second);
    const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original'));
    await h.rerender({ bytes: Uint8Array.of(4), kind: 'hwpx' });
    await act(async () => h.view.setMode('original')); await flush();
    const urls = h.view.pageUrls;
    await act(async () => opening.resolve(first));
    expect(first.dispose).toHaveBeenCalledOnce(); expect(first.renderPage).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled(); expect(h.view.pageUrls).toBe(urls);
    expect(h.view).toMatchObject({ status: 'ready', pages: 2 });
  });
  it('ignores a late page and creates no URL after leaving original mode', async () => {
    const { adapter, document } = fakeAdapter(); const rendering = deferred<Blob>();
    document.renderPage.mockReturnValueOnce(rendering.promise);
    const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original'));
    expect(h.view.status).toBe('loading');
    await act(async () => h.view.setMode('markdown'));
    await act(async () => rendering.resolve(new Blob(['late']))); await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(document.dispose).toHaveBeenCalledOnce();
    expect(h.view).toMatchObject({ mode: 'markdown', status: 'idle', pageUrls: {} });
  });
  it('ignores late open and render errors after the hook has been unmounted', async () => {
    const { adapter, document } = fakeAdapter(); const opening = deferred<OriginalViewDocument>();
    adapter.open.mockReturnValueOnce(opening.promise);
    const first = await mount(original, adapter);
    await act(async () => first.view.setMode('original')); await first.unmount();
    await act(async () => opening.reject(new OriginalViewError('corrupt', '늦은 열기 오류')));
    const rendering = deferred<Blob>(); document.renderPage.mockReturnValueOnce(rendering.promise);
    const second = await mount(original, adapter);
    await act(async () => second.view.setMode('original')); await second.unmount();
    await act(async () => rendering.reject(new OriginalViewError('render', '늦은 쪽 오류'))); await flush();
    expect(document.dispose).toHaveBeenCalledOnce(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('prioritizes the latest page selection without queuing the previous neighbors', async () => {
    const { adapter, document } = fakeAdapter(10); const rendering = deferred<Blob>();
    document.renderPage.mockReturnValueOnce(rendering.promise);
    const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original'));
    await act(async () => h.view.setCurrentPage(5));
    expect(document.renderPage).toHaveBeenCalledExactlyOnceWith(0);
    await act(async () => rendering.resolve(new Blob(['first']))); await flush();
    expect(document.renderPage.mock.calls.map(([page]) => page)).toEqual([0, 5, 4, 6]);
    expect(h.view).toMatchObject({ currentPage: 5, status: 'ready' });
  });
  it('keeps mode local to each mounted document without writing persisted UI state', async () => {
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const first = await mount(original, fakeAdapter().adapter);
    const second = await mount(original, fakeAdapter().adapter);
    await act(async () => first.view.setMode('original')); await flush();
    expect(first.view.mode).toBe('original'); expect(second.view.mode).toBe('markdown');
    expect(persist).not.toHaveBeenCalled();
  });
  it('exposes SVG blobs only as image URLs, never as executable DOM markup', async () => {
    const { adapter, document } = fakeAdapter(1);
    const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>throw new Error("unsafe")</script></svg>'], { type: 'image/svg+xml' });
    document.renderPage.mockResolvedValue(blob);
    const h = await mount(original, adapter);
    await act(async () => h.view.setMode('original')); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
    expect(h.container.querySelector('img')?.getAttribute('src')).toBe(h.view.pageUrls[0]);
    expect(h.container.querySelectorAll('svg, script')).toHaveLength(0);
  });
});

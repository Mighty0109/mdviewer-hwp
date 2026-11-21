// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import { fileBridge, reportE2eState, type MarkdownFile } from '@/data/tauri-bridge';
import { emptyFileState, type OpenFileState } from './open-file-session';
import type { OriginalViewState } from './use-original-view';
import { ORIGINAL_VIEW_E2E_QUERY, useReaderReport } from './use-reader-report';
import { useUIStore } from '@/stores/ui-store';

const fakes = vi.hoisted(() => ({
  adapter: { open: vi.fn() },
  document: { pageCount: 2, renderPage: vi.fn(), dispose: vi.fn() },
  worker: { parse: vi.fn(), generate: vi.fn(), dispose: vi.fn() },
}));
vi.mock('@/lib/hwp/rhwp', () => ({ createRhwpAdapter: () => fakes.adapter }));
vi.mock('@/lib/hwp/worker-client', () => ({ createHwpWorkerClient: () => fakes.worker }));

vi.mock('@/data/tauri-bridge', () => ({
  fileBridge: {
    available: () => true,
    onOpened: vi.fn(), onChanged: vi.fn(), takePending: vi.fn(),
    read: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), pick: vi.fn(), e2eConfig: vi.fn(),
    onCloseBlocked: vi.fn(), setDocumentDirty: vi.fn(),
    readHwpBytes: vi.fn(),
  },
  localImageUrl: (path: string) => `asset://localhost${encodeURI(path)}`,
  reportE2eState: vi.fn(),
}));

// jsdom has no Web Worker. Keep the real Markdown parser and rendering pipeline.
vi.mock('@/lib/markdown', async (importOriginal) => {
  const markdown = await importOriginal<typeof import('@/lib/markdown')>();
  return { ...markdown, markdownToHtmlAsync: async (source: string) => markdown.markdownToHtml(source) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const file: MarkdownFile = {
  path: '/tmp/한글 문서/sample.md', hash: 'first-hash', mtimeMs: 1,
  content: `# 한글 문서

자동 새로고침을 확인합니다.

## 표와 코드

| 기능 | 상태 |
| --- | --- |
| 한글 읽기 | 완료 |

\`\`\`rust
fn main() {}
\`\`\`

### 체크리스트

- [ ] 자동 새로고침 대기
- [x] 완료

![그림](./img/sample.png)
`,
};

describe('reader state reporting from the live document', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useUIStore.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    useUIStore.setState({ viewMode: 'wysiwyg', tocOpen: true });
    fakes.adapter.open.mockResolvedValue(fakes.document);
    fakes.document.renderPage.mockResolvedValue(new Blob(['page'], { type: 'image/svg+xml' }));
    fakes.worker.parse.mockResolvedValue({ markdown: '# 가져온 문서\n\n내용', warnings: [], assets: [],
      stats: { headings: 1, paragraphs: 1, tables: 0, images: 0, imageReferences: 0, imageMappings: 0, skippedImages: 0 } });
    vi.mocked(fileBridge.readHwpBytes).mockResolvedValue(Uint8Array.of(1, 2, 3));
    let sequence = 0;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:original-${++sequence}`);
      static revokeObjectURL = vi.fn();
    });
    vi.mocked(fileBridge.onOpened).mockResolvedValue(() => {});
    vi.mocked(fileBridge.onChanged).mockResolvedValue(() => {});
    vi.mocked(fileBridge.onCloseBlocked).mockResolvedValue(() => {});
    vi.mocked(fileBridge.setDocumentDirty).mockResolvedValue();
    vi.mocked(fileBridge.takePending).mockResolvedValue([file.path]);
    vi.mocked(fileBridge.read).mockResolvedValue(file);
    vi.mocked(fileBridge.watch).mockResolvedValue();
    vi.mocked(fileBridge.unwatch).mockResolvedValue();
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue({ statePath: '/tmp/state.json', query: '자동 새로고침' });
    vi.mocked(reportE2eState).mockResolvedValue();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useUIStore.setState({ viewMode: 'wysiwyg', tocOpen: true });
  });

  const lastReport = () => vi.mocked(reportE2eState).mock.calls.at(-1)?.[0];
  const settleReports = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  };

  it('reports rendered tasks, loaded images, TOC and search, then reports an external reload', async () => {
    await act(async () => { root.render(<Home />); });
    await settleReports();
    expect(lastReport()).toMatchObject({
      path: file.path, hash: file.hash, loadCount: 1, error: null,
      render: { headings: 3, tables: 1, codeBlocks: 1, taskItems: 2, images: 1, imagesLoaded: 0 },
      tocItems: 3, search: { query: '자동 새로고침', matches: 2 },
    });
    expect(container.querySelectorAll('[data-search-match]')).toHaveLength(2);

    const image = container.querySelector<HTMLImageElement>('.tiptap img')!;
    expect(image.getAttribute('src')).toBe('asset://localhost/tmp/%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C/img/sample.png');
    Object.defineProperty(image, 'naturalWidth', { value: 64 });
    await act(async () => { image.dispatchEvent(new Event('load')); });
    await settleReports();
    expect(lastReport()).toMatchObject({ render: { taskItems: 2, imagesLoaded: 1 } });

    const main = container.querySelector('main')!;
    main.scrollTop = 240;
    vi.mocked(fileBridge.read).mockResolvedValue({
      ...file, hash: 'changed-hash', mtimeMs: 2,
      content: `${file.content}\n- [x] 자동 새로고침 확인\n\n#### 외부에서 추가한 제목\n`,
    });
    expect(lastReport()).toMatchObject({ edit: { dirty: false, applied: false, mode: 'rich' } });
    const onChanged = vi.mocked(fileBridge.onChanged).mock.calls[0][0];
    await act(async () => { onChanged({ path: file.path, hash: 'changed-hash', source: 'external' }); });
    await settleReports();
    expect(lastReport()).toMatchObject({
      path: file.path, hash: 'changed-hash', loadCount: 2, error: null,
      render: { headings: 4, tables: 1, codeBlocks: 1, taskItems: 3, images: 1 },
      tocItems: 4, search: { query: '자동 새로고침', matches: 3 },
    });
    expect(container.querySelectorAll('[data-search-match]')).toHaveLength(3);
    expect(main.scrollTop).toBe(240);
  });

  it('does not report document state when e2e is disabled', async () => {
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue(null);
    await act(async () => { root.render(<Home />); });
    await settleReports();
    expect(container.querySelectorAll('li[data-type="taskItem"]')).toHaveLength(2);
    expect(reportE2eState).not.toHaveBeenCalled();
  });

  it('reports the original-view contract as unavailable for ordinary Markdown', async () => {
    await act(async () => { root.render(<Home />); });
    await settleReports();
    expect(lastReport()).toMatchObject({ originalView: {
      available: false, mode: 'markdown', pages: 0, imgBlobCount: 0, svgInDom: 0,
      errorMessage: null, parseMs: null, firstPageMs: null, maxFrameGapMs: null,
    } });
  });

  it('does not use the original-view e2e marker as a search query', async () => {
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue({ statePath: '/tmp/state.json', query: ORIGINAL_VIEW_E2E_QUERY });
    await act(async () => { root.render(<Home />); });
    await settleReports();
    expect(lastReport()).toMatchObject({ search: { query: '', matches: 0 } });
    expect(container.querySelector('input[aria-label="문서 안 검색어"]')).toBeNull();
    expect(container.querySelectorAll('[data-search-match]')).toHaveLength(0);
  });

  it('imports through Home and displays the original page when the e2e query requests it', async () => {
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue({ statePath: '/tmp/state.json', query: ORIGINAL_VIEW_E2E_QUERY, importPath: '/tmp/document.hwp' });
    await act(async () => { root.render(<Home />); });
    await settleReports();
    await settleReports(); // Commit the RAF result, then let its report debounce finish.
    expect(fakes.adapter.open).toHaveBeenCalledTimes(1);
    expect(container.querySelector('textarea')?.value).toContain('가져온 문서');
    expect(container.querySelectorAll('[data-original-view] img')).toHaveLength(1);
    expect(lastReport()).toMatchObject({ importResult: { done: true }, search: { query: '', matches: 0 },
      originalView: { available: true, mode: 'original', pages: 2, imgBlobCount: 1, svgInDom: 0, errorMessage: null,
        parseMs: expect.any(Number), firstPageMs: expect.any(Number), maxFrameGapMs: expect.any(Number) } });
    const markdown = [...container.querySelectorAll('button')].find(button => button.textContent === '마크다운 미리보기')!;
    await act(async () => markdown.click());
    await settleReports();
    expect(container.querySelector('[data-original-view]')).toBeNull();
    expect(lastReport()).toMatchObject({ originalView: { available: true, mode: 'markdown' } });
    expect(fakes.adapter.open).toHaveBeenCalledTimes(1);
  });
});

describe('original-view e2e control and measurements', () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: OpenFileState;
  let original: OriginalViewState;
  let selectMode: OriginalViewState['setMode'];
  let now: number;
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;
  const changeMode = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    now = 0; frameId = 0; frames = new Map();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    vi.mocked(reportE2eState).mockResolvedValue();
    state = { ...emptyFileState, e2e: { statePath: '/tmp/state.json', query: ORIGINAL_VIEW_E2E_QUERY } };
    original = { available: false, mode: 'markdown', pages: 0, currentPage: 0, status: 'idle',
      errorMessage: null, pageUrls: {}, setMode: vi.fn(), setCurrentPage: vi.fn() };
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function Probe() {
    selectMode = useReaderReport(state, null, '', 0, undefined, original, changeMode);
    return null;
  }
  const render = () => act(async () => { root.render(<Probe />); });
  const report = () => act(async () => { await vi.advanceTimersByTimeAsync(100); });
  const lastReport = () => vi.mocked(reportE2eState).mock.calls.at(-1)?.[0];
  const frame = async (time: number) => {
    now = time;
    const pending = [...frames.values()]; frames.clear();
    await act(async () => { for (const callback of pending) callback(time); });
  };

  it('opens original mode and split view once after the e2e import is ready', async () => {
    await render();
    expect(original.setMode).not.toHaveBeenCalled();
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwp' }, isLoading: true };
    original = { ...original, available: true };
    await render();
    expect(original.setMode).not.toHaveBeenCalled();
    state = { ...state, isLoading: false };
    await render();
    expect(original.setMode).toHaveBeenCalledExactlyOnceWith('original');
    expect(changeMode).toHaveBeenCalledExactlyOnceWith('split');
    await render();
    expect(original.setMode).toHaveBeenCalledTimes(1);
  });

  it('never changes modes for a normal e2e search query or outside e2e', async () => {
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwpx' }, e2e: { statePath: '/tmp/state.json', query: '검색어' } };
    original = { ...original, available: true };
    await render();
    state = { ...state, e2e: null };
    await render();
    expect(original.setMode).not.toHaveBeenCalled();
    expect(changeMode).not.toHaveBeenCalled();
  });

  it('measures integer ready and first-blob times from the mode request, including a blocked frame', async () => {
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwp' } };
    original = { ...original, available: true };
    await render(); // The e2e mode request starts the clock at zero.
    original = { ...original, mode: 'original', status: 'loading' };
    await render();
    await frame(12.2);
    now = 40.6;
    original = { ...original, status: 'ready', pages: 2 };
    await render();
    now = 71.7;
    original = { ...original, pageUrls: { 0: 'blob:first' } };
    await render();
    await frame(80);
    await report();
    expect(lastReport()).toMatchObject({ originalView: { available: true, mode: 'original', pages: 2,
      parseMs: 41, firstPageMs: 72, maxFrameGapMs: 68, errorMessage: null } });
    expect(frames.size).toBe(0);
    // A later page must not extend the first-page measurement window.
    now = 500;
    original = { ...original, currentPage: 1, pageUrls: { 0: 'blob:first', 1: 'blob:second' } };
    await render(); await report();
    expect(lastReport()).toMatchObject({ originalView: { parseMs: 41, firstPageMs: 72, maxFrameGapMs: 68 } });
  });

  it('starts manual measurement at setMode before a synchronous render can block', async () => {
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwp' }, e2e: { statePath: '/tmp/state.json', query: '' } };
    original = { ...original, available: true, setMode: vi.fn(() => { now = 650; }) };
    await render();
    now = 100;
    await act(async () => selectMode('original'));
    original = { ...original, mode: 'original', status: 'ready', pages: 2, pageUrls: { 0: 'blob:first' } };
    await render(); await frame(660); await report();
    expect(lastReport()).toMatchObject({ originalView: { parseMs: 550, firstPageMs: 550, maxFrameGapMs: 560 } });
  });

  it('does not publish an unfinished frame measurement as a successful zero gap', async () => {
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwp' } };
    original = { ...original, available: true };
    await render();
    now = 200;
    original = { ...original, mode: 'original', status: 'ready', pages: 1, pageUrls: { 0: 'blob:first' } };
    await render(); await report();
    expect(lastReport()).toMatchObject({ originalView: { parseMs: 200, firstPageMs: 200, maxFrameGapMs: null } });
    await frame(240); await report();
    expect(lastReport()).toMatchObject({ originalView: { maxFrameGapMs: 240 } });
  });

  it('does not measure or report a manual mode change outside e2e', async () => {
    state = { ...state, e2e: null, original: { bytes: Uint8Array.of(1), kind: 'hwp' } };
    original = { ...original, available: true };
    await render();
    const callsBefore = vi.mocked(performance.now).mock.calls.length;
    await act(async () => selectMode('original'));
    original = { ...original, mode: 'original', status: 'ready', pages: 1, pageUrls: { 0: 'blob:first' } };
    await render(); await report();
    expect(original.setMode).toHaveBeenCalledExactlyOnceWith('original');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(vi.mocked(performance.now).mock.calls.length).toBe(callsBefore);
    expect(reportE2eState).not.toHaveBeenCalled();
  });

  it('reports the original failure reason without fabricating completion times and stops sampling', async () => {
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwp' } };
    original = { ...original, available: true };
    await render(); await frame(10);
    original = { ...original, mode: 'original', status: 'error', errorMessage: '손상된 문서입니다.' };
    await render(); await frame(32); await report();
    expect(lastReport()).toMatchObject({ originalView: { errorMessage: '손상된 문서입니다.',
      parseMs: null, firstPageMs: null, maxFrameGapMs: 22 } });
    expect(frames.size).toBe(0);
  });

  it('clears measurements and cancels frames when closing or replacing the imported document', async () => {
    state = { ...state, original: { bytes: Uint8Array.of(1), kind: 'hwp' } };
    original = { ...original, available: true };
    await render();
    expect(frames.size).toBe(1);
    state = { ...state, original: null };
    original = { ...original, available: false };
    await render(); await report();
    expect(frames.size).toBe(0);
    expect(lastReport()).toMatchObject({ originalView: { parseMs: null, firstPageMs: null, maxFrameGapMs: null } });
    now = 500;
    state = { ...state, original: { bytes: Uint8Array.of(2), kind: 'hwpx' } };
    original = { ...original, available: true };
    await render();
    expect(original.setMode).toHaveBeenCalledTimes(2);
    now = 520;
    original = { ...original, mode: 'original', status: 'ready', pages: 1, pageUrls: { 0: 'blob:replacement' } };
    await render(); await frame(525); await report();
    expect(lastReport()).toMatchObject({ originalView: { parseMs: 20, firstPageMs: 20, maxFrameGapMs: 25 } });
    await act(async () => selectMode('markdown'));
    expect(frames.size).toBe(0);
    await act(async () => { root.render(null); });
    expect(frames.size).toBe(0);
  });

  it('counts all visible blob images but scopes SVG detection to the original region', async () => {
    await render();
    const region = document.createElement('div'); region.setAttribute('data-original-view', '');
    const page = document.createElement('img'); page.src = 'blob:page'; region.append(page);
    const asset = document.createElement('img'); asset.src = 'blob:asset';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    container.append(region, asset, icon);
    await report();
    expect(lastReport()).toMatchObject({ originalView: { imgBlobCount: 2, svgInDom: 0 } });
    region.append(icon);
    original = { ...original, pages: 2 }; // Publish a new report after the DOM changes.
    await render(); await report();
    expect(lastReport()).toMatchObject({ originalView: { imgBlobCount: 2, svgInDom: 1 } });
  });
});

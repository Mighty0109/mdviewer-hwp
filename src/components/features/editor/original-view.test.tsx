// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OriginalViewState } from '@/hooks/use-original-view';
import { ORIGINAL_VIEW_LABELS } from '@/domain/original-view';
import { SplitView } from './split-view';
import { SourceEditor } from './source-editor';
import { ReadOnlyEditor } from './read-only-editor';

vi.mock('./read-only-editor', () => ({ ReadOnlyEditor: ({ content }: { content: string }) => <div data-markdown-preview>{content}</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const content = '# 편집 중인 문서';
const htmlContent = '<h1>편집 중인 문서</h1>';
function view(overrides: Partial<OriginalViewState> = {}): OriginalViewState {
  return { available: true, mode: 'markdown', pages: 0, currentPage: 0, status: 'idle',
    errorMessage: null, pageUrls: {}, setMode: vi.fn(), setCurrentPage: vi.fn(), ...overrides };
}

// The pre-feature structure is fixed here to catch extra wrappers on ordinary .md files.
const legacy = renderToStaticMarkup(<div className="grid h-full min-h-0 grid-cols-2 divide-x divide-[var(--color-border)]">
  <SourceEditor content={content} />
  <section aria-label="읽기 전용 미리보기" className="overflow-y-auto">
    <div className="flex h-8 items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-xs text-[var(--color-text-secondary)]">미리보기 · 읽기 전용</div>
    <article className="px-8 py-5"><ReadOnlyEditor content={htmlContent} /></article>
  </section>
</div>);

describe('original preview in split view', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (original?: OriginalViewState) => act(async () => { root.render(<SplitView content={content} htmlContent={htmlContent} original={original} />); });
  const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!;

  it('keeps the exact legacy DOM without an original prop', () => {
    expect(renderToStaticMarkup(<SplitView content={content} htmlContent={htmlContent} />)).toBe(legacy);
  });

  it('keeps the exact legacy DOM and no toggle when original is unavailable', () => {
    expect(renderToStaticMarkup(<SplitView content={content} htmlContent={htmlContent} original={view({ available: false })} />)).toBe(legacy);
  });

  it('shows accessible preview choices only for an available original', async () => {
    const original = view();
    await render(original);
    const group = container.querySelector('[role="group"][aria-label="미리보기 보기"]');
    expect(group?.querySelectorAll('button')).toHaveLength(2);
    expect(button(ORIGINAL_VIEW_LABELS.markdown).getAttribute('aria-pressed')).toBe('true');
    expect(button(ORIGINAL_VIEW_LABELS.original).getAttribute('aria-pressed')).toBe('false');
    await act(async () => button(ORIGINAL_VIEW_LABELS.original).click());
    expect(original.setMode).toHaveBeenCalledExactlyOnceWith('original');
  });

  it('replaces the Markdown preview with only the current page as a blob image', async () => {
    await render(view({ mode: 'original', status: 'ready', pages: 2, pageUrls: { 0: 'blob:first', 1: 'blob:second' } }));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:first');
    expect(container.querySelector('[data-markdown-preview]')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe(content);
  });

  it('never inserts page markup or scripts into the DOM', async () => {
    await render(view({ mode: 'original', status: 'ready', pages: 1, pageUrls: { 0: 'blob:page' } }));
    expect(container.querySelectorAll('svg,script,object,embed,iframe')).toHaveLength(0);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:page');
  });

  it('labels the original as the import-time snapshot', async () => {
    await render(view({ mode: 'original' }));
    expect(container.querySelector('[data-original-view]')?.textContent).toContain(ORIGINAL_VIEW_LABELS.snapshot);
  });

  it('shows the render failure reason and keeps source editing and Markdown return working', async () => {
    const original = view({ mode: 'original', status: 'error', errorMessage: 'WASM을 불러올 수 없습니다.' });
    await render(original);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(original.errorMessage);
    const source = container.querySelector('textarea')!;
    await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(source.value).not.toBe(content);
    await act(async () => button(ORIGINAL_VIEW_LABELS.markdown).click());
    expect(original.setMode).toHaveBeenCalledExactlyOnceWith('markdown');
    await render({ ...original, mode: 'markdown' });
    expect(container.querySelector('[data-original-view]')).toBeNull();
    expect(container.querySelector('[data-markdown-preview]')).not.toBeNull();
  });

  it('navigates both pages with boundary buttons and a page counter', async () => {
    const original = view({ mode: 'original', status: 'ready', pages: 2, pageUrls: { 0: 'blob:first', 1: 'blob:second' } });
    await render(original);
    expect(container.querySelector('[aria-label="원본 쪽 이동"]')?.textContent).toContain('1 / 2');
    expect(button('이전').disabled).toBe(true);
    await act(async () => button('다음').click());
    expect(original.setCurrentPage).toHaveBeenCalledExactlyOnceWith(1);
    await render({ ...original, currentPage: 1 });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:second');
    expect(container.querySelector('[aria-label="원본 쪽 이동"]')?.textContent).toContain('2 / 2');
    expect(button('다음').disabled).toBe(true);
    await act(async () => button('이전').click());
    expect(original.setCurrentPage).toHaveBeenLastCalledWith(0);
  });

  it('announces loading before the first page and while moving to an uncached page', async () => {
    await render(view({ mode: 'original', status: 'loading' }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(ORIGINAL_VIEW_LABELS.loading);
    expect(container.querySelector('img')).toBeNull();
    await render(view({ mode: 'original', status: 'loading', pages: 2, currentPage: 1, pageUrls: { 0: 'blob:first' } }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(ORIGINAL_VIEW_LABELS.loading);
    expect(container.querySelector('img')).toBeNull();
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OriginalViewState } from '@/hooks/use-original-view';
import { SplitView } from './split-view';

vi.mock('./read-only-editor', () => ({ ReadOnlyEditor: ({ content }: { content: string }) => <div data-markdown-preview>{content}</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const content = '# 편집 중인 문서';
function view(overrides: Partial<OriginalViewState> = {}): OriginalViewState {
  return { available: true, mode: 'markdown', pages: 2, currentPage: 0, status: 'ready',
    errorMessage: null, pageUrls: { 0: 'blob:first', 1: 'blob:second' },
    setMode: vi.fn(), setCurrentPage: vi.fn(), ...overrides };
}

describe('split preview with an original', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (original?: OriginalViewState) => act(async () => {
    root.render(<SplitView content={content} htmlContent="<h1>편집 중인 문서</h1>" original={original} />);
  });
  const grid = () => container.firstElementChild!;
  const sourcePane = () => grid().firstElementChild!;

  it('has no view controls and no source wrapper without an original', async () => {
    await render();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('textarea')?.parentElement).toBe(sourcePane());
  });

  it('has no view controls or source wrapper when the original is unavailable', async () => {
    await render(view({ available: false }));
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('textarea')?.parentElement).toBe(sourcePane());
  });

  it('pins the opaque original page navigation below the view controls inside the original wrapper', async () => {
    await render(view({ mode: 'original' }));
    const nav = container.querySelector('nav[aria-label="원본 쪽 이동"]')!;
    expect(nav.closest('[data-original-view]')).not.toBeNull();
    for (const className of ['sticky', 'top-8', 'z-10', 'border-b', 'bg-[var(--color-surface)]']) {
      expect(nav.classList.contains(className), className).toBe(true);
    }
    expect(nav.textContent).toContain('1 / 2');
    expect(nav.querySelectorAll('button')).toHaveLength(2);
  });
});

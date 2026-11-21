// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OriginalViewState } from '@/hooks/use-original-view';
import { SplitView } from './split-view';

vi.mock('./read-only-editor', () => ({ ReadOnlyEditor: ({ content }: { content: string }) => <div data-markdown-preview>{content}</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function view(overrides: Partial<OriginalViewState> = {}): OriginalViewState {
  return { available: true, mode: 'markdown', pages: 0, currentPage: 0, status: 'idle',
    errorMessage: null, pageUrls: {}, setMode: vi.fn(), setCurrentPage: vi.fn(), ...overrides };
}

describe('sticky split preview controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (original?: OriginalViewState) => act(async () => {
    root.render(<SplitView content="# 문서" htmlContent="<h1>문서</h1>" original={original} />);
  });
  const section = () => container.querySelector('section[aria-label="읽기 전용 미리보기"]')!;
  const group = () => container.querySelector('[role="group"][aria-label="미리보기 보기"]')!;

  it('pins the opaque view controls directly inside the preview scroll container', async () => {
    await render(view());
    expect(group().parentElement).toBe(section());
    for (const className of ['sticky', 'top-0', 'z-10', 'bg-[var(--color-surface)]']) {
      expect(group().classList.contains(className)).toBe(true);
    }
  });

  it('reserves space for headings below the pinned controls when an original is available', async () => {
    await render(view());
    expect(section().classList.contains('overflow-y-auto')).toBe(true);
    expect(section().classList.contains('scroll-pt-8')).toBe(true);
  });

  it('keeps the same pinned controls and scroll padding after switching to the original', async () => {
    const original = view();
    await render(original);
    const controls = group();
    const classes = controls.className;
    const originalButton = [...controls.querySelectorAll('button')].find(button => button.textContent === '원본 모양')!;
    await act(async () => originalButton.click());
    expect(original.setMode).toHaveBeenCalledExactlyOnceWith('original');
    await render({ ...original, mode: 'original' });
    expect(group()).toBe(controls);
    expect(group().className).toBe(classes);
    for (const className of ['sticky', 'top-0', 'z-10']) {
      expect(group().classList.contains(className)).toBe(true);
    }
    expect(originalButton.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-original-view]')).not.toBeNull();
    expect(section().classList.contains('scroll-pt-8')).toBe(true);
  });

  it.each([undefined, view({ available: false })])('keeps the legacy non-sticky header without an available original (%s)', async original => {
    await render(original);
    expect(section().className).toBe('overflow-y-auto');
    const header = section().firstElementChild!;
    expect(header.textContent).toBe('미리보기 · 읽기 전용');
    expect(header.classList.contains('sticky')).toBe(false);
    expect(group()).toBeNull();
  });
});

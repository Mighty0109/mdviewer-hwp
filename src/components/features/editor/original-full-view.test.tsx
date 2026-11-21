// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { OriginalFullView } from './original-full-view';
import type { OriginalViewState } from '@/hooks/use-original-view';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement; let root: Root; const exit = vi.fn();
const original: OriginalViewState = { available: true, mode: 'original', status: 'ready', errorMessage: null, pages: 1, currentPage: 0, pageUrls: { 0: 'blob:page' }, setMode: vi.fn(), setCurrentPage: vi.fn() };
beforeEach(async () => { exit.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<OriginalFullView original={original} onExit={exit} />)); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const escape = async (event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) => act(async () => window.dispatchEvent(event));
it('shows a read-only page and sticky bar', () => { expect(host.querySelector('[data-original-view] img')).toBeTruthy(); expect(host.textContent).toContain('원본(가져온 시점)'); expect(host.querySelector('textarea,[contenteditable="true"]')).toBeNull(); expect(host.querySelector('.sticky.top-0.h-8')).toBeTruthy(); });
it('exits on Escape', async () => { await escape(); expect(exit).toHaveBeenCalledOnce(); });
it('ignores a prevented Escape', async () => { const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); e.preventDefault(); await escape(e); expect(exit).not.toHaveBeenCalled(); });
it('leaves Escape to open menus, dialogs and search', async () => { for (const markup of ['<div role="menu"></div>', '<div role="dialog"></div>', '<div role="alertdialog"></div>', '<input aria-label="문서 안 검색어">']) { const extra = document.createElement('div'); extra.innerHTML = markup; document.body.append(extra); await escape(); extra.remove(); } expect(exit).not.toHaveBeenCalled(); });
it('removes its listener on unmount', async () => { await act(async () => root.render(null)); await escape(); expect(exit).not.toHaveBeenCalled(); });

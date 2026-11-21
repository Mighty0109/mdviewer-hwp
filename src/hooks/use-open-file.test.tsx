// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileBridge } from '@/data/tauri-bridge';
import { handleFileShortcut, useOpenFile } from './use-open-file';

vi.mock('@/lib/markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/markdown')>();
  return { ...original, markdownToHtmlAsync: async (md: string) => original.markdownToHtml(md) };
});
vi.mock('@/data/tauri-bridge', () => ({
  localImageUrl: (path: string) => `asset://localhost${path}`,
  fileBridge: {
    available: () => true,
    onOpened: vi.fn(async () => () => {}), onChanged: vi.fn(async () => () => {}), onCloseBlocked: vi.fn(async () => () => {}),
    takePending: vi.fn(async () => ['/tmp/doc/a.md']),
    read: vi.fn(async () => ({ path: '/tmp/doc/a.md', content: '![사진](./img/한글.png)\n', hash: 'old', mtimeMs: 0 })),
    watch: vi.fn(async () => {}), unwatch: vi.fn(async () => {}), e2eConfig: vi.fn(async () => null),
    setDocumentDirty: vi.fn(async () => {}),
    writeMarkdown: vi.fn(async (path: string) => ({ path, hash: 'saved', mtimeMs: 1 })),
    saveMarkdownAs: vi.fn(async () => null), confirmClose: vi.fn(async () => {}),
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.clearAllMocks());

describe('document shortcuts', () => {
  it('handles save/save-as/new/open from a textarea and prevents browser defaults', () => {
    const actions = { pickFile: vi.fn(), saveFile: vi.fn(), saveAs: vi.fn(), newDocument: vi.fn() };
    const handler = (event: KeyboardEvent) => handleFileShortcut(event, actions);
    window.addEventListener('keydown', handler);
    const source = document.createElement('textarea'); document.body.append(source);
    try {
      for (const init of [{ key: 's', metaKey: true }, { key: 'S', metaKey: true, shiftKey: true }, { key: 'n', metaKey: true }, { key: 'o', ctrlKey: true }]) {
        const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        source.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
      }
      for (const action of Object.values(actions)) expect(action).toHaveBeenCalledOnce();
    } finally { source.remove(); window.removeEventListener('keydown', handler); }
  });
  it('leaves unrelated keys/composition shortcuts alone and suppresses repeated actions', () => {
    const actions = { pickFile: vi.fn(), saveFile: vi.fn(), saveAs: vi.fn(), newDocument: vi.fn() };
    for (const init of [{ key: 's' }, { key: 's', metaKey: true, altKey: true }, { key: 'n', metaKey: true, shiftKey: true }]) {
      const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
      handleFileShortcut(event, actions); expect(event.defaultPrevented).toBe(false);
    }
    handleFileShortcut(new KeyboardEvent('keydown', { key: 'n', metaKey: true, repeat: true }), actions);
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });
});

it('resolves preview images while retaining Markdown src, and saves the registered exact source getter', async () => {
  let reader!: ReturnType<typeof useOpenFile>;
  function Harness() { reader = useOpenFile(); return null; }
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => { root.render(<Harness />); });
    const html = new DOMParser().parseFromString(reader.html, 'text/html');
    expect(html.querySelector('img')?.getAttribute('data-md-src')).toBe('./img/한글.png');
    expect(html.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/tmp/doc/img/한글.png');
    const source = '---\r\ntitle: 소스\r\n---\r\n\n';
    await act(async () => { reader.setContentGetter(() => source); reader.markDirty(); await reader.saveFile(); });
    expect(fileBridge.writeMarkdown).toHaveBeenCalledWith('/tmp/doc/a.md', source, 'old');
    expect(reader.dirty).toBe(false);
  } finally { await act(async () => { root.unmount(); }); }
});

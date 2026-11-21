// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import { fileBridge, reportE2eState, type MarkdownFile } from '@/data/tauri-bridge';
import { useUIStore } from '@/stores/ui-store';

vi.mock('@/data/tauri-bridge', () => ({
  fileBridge: {
    available: () => true, onOpened: vi.fn(), onChanged: vi.fn(), onCloseBlocked: vi.fn(),
    takePending: vi.fn(), read: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), pick: vi.fn(),
    e2eConfig: vi.fn(), e2eGateOpen: vi.fn(), setDocumentDirty: vi.fn(),
    writeMarkdown: vi.fn(), saveMarkdownAs: vi.fn(), confirmClose: vi.fn(),
    askUnsavedChanges: vi.fn(),
  },
  localImageUrl: (path: string) => `asset://localhost${encodeURI(path)}`,
  reportE2eState: vi.fn(),
}));
vi.mock('@/lib/markdown', async (original) => {
  const markdown = await original<typeof import('@/lib/markdown')>();
  return { ...markdown, markdownToHtmlAsync: async (source: string) => markdown.markdownToHtml(source) };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sample: MarkdownFile = {
  path: '/tmp/문서/sample.md', hash: 'opened', mtimeMs: 1,
  content: '# 한글 문서\r\n\r\n| 제목 | 값 |\r\n| --- | --- |\r\n| 한글 | 보존 |\r\n\r\n```rust\r\nfn main() {}\r\n```\r\n\r\n- [ ] 작업\r\n\r\n![그림](./img/사진.png)\r\n',
};

describe('file editor integration', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useUIStore.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    useUIStore.setState({ viewMode: 'wysiwyg', tocOpen: true });
    for (const method of ['onOpened', 'onChanged', 'onCloseBlocked'] as const) vi.mocked(fileBridge[method]).mockResolvedValue(() => {});
    vi.mocked(fileBridge.takePending).mockResolvedValue([sample.path]);
    vi.mocked(fileBridge.read).mockResolvedValue(sample);
    vi.mocked(fileBridge.watch).mockResolvedValue();
    vi.mocked(fileBridge.unwatch).mockResolvedValue();
    vi.mocked(fileBridge.setDocumentDirty).mockResolvedValue();
    vi.mocked(fileBridge.confirmClose).mockResolvedValue();
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue(null);
    vi.mocked(fileBridge.e2eGateOpen).mockResolvedValue(true);
    vi.mocked(fileBridge.writeMarkdown).mockResolvedValue({ path: sample.path, hash: 'saved', mtimeMs: 2 });
    vi.mocked(fileBridge.saveMarkdownAs).mockResolvedValue(null);
    vi.mocked(reportE2eState).mockResolvedValue();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
  });
  async function mount(file = sample) {
    vi.mocked(fileBridge.read).mockResolvedValue(file);
    await act(async () => root.render(<Home />));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  function editor() { return (host.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor; }
  function button(text: string) { return [...host.querySelectorAll('button')].find((item) => item.textContent === text)!; }
  function save(shift = false) {
    const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: shift, bubbles: true, cancelable: true });
    (host.querySelector('textarea') || window).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  function typeSource(value: string) {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('skips untouched saves; immediately saves rich edits with tables, tasks, code and relative images intact', async () => {
    await mount();
    expect(editor().isEditable).toBe(true);
    expect(host.querySelector('h1')?.textContent).not.toContain('●');
    await act(async () => save());
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
    await act(async () => {
      editor().commands.insertContentAt(editor().state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: '즉시 저장한 마지막 글자' }] });
      save();
    });
    const [path, markdown, hash] = vi.mocked(fileBridge.writeMarkdown).mock.calls[0];
    expect(path).toBe(sample.path); expect(hash).toBe('opened');
    expect(markdown).toContain('즉시 저장한 마지막 글자');
    expect(markdown).toContain('| 한글 | 보존 |');
    expect(markdown).toContain('```rust\r\nfn main() {}\r\n```');
    expect(markdown).toContain('- [ ] 작업');
    expect(markdown).toContain('![그림](./img/사진.png)');
    expect(markdown).not.toContain('asset://');
    expect(markdown.endsWith('\r\n')).toBe(true);
    expect(host.querySelector('h1')?.textContent).not.toContain('●');
    expect(host.querySelector('[data-statusbar]')?.textContent).toContain('저장됨');
  });

  it('preserves existing embedded images while refusing new base64 paste and drop', async () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    await mount({ ...sample, content: `# 원본\n\n![기존 그림](${image})\n` });
    expect(host.querySelector('.tiptap img')?.getAttribute('src')).toBe(image);
    const transfer = { files: [], getData: () => `<img src="${image}">` };
    const paste = { clipboardData: transfer, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    const drop = { dataTransfer: transfer, preventDefault: vi.fn() } as unknown as DragEvent;
    expect(editor().view.someProp('handlePaste', (handler) => handler(editor().view, paste, null!))).toBe(true);
    expect(editor().view.someProp('handleDrop', (handler) => handler(editor().view, drop, null!, false))).toBe(true);
    expect(paste.preventDefault).toHaveBeenCalled(); expect(drop.preventDefault).toHaveBeenCalled();
    await act(async () => { editor().commands.insertContentAt(1, '수정 '); save(); });
    expect(vi.mocked(fileBridge.writeMarkdown).mock.calls[0][1]).toContain(`![기존 그림](${image})`);
  });

  it('clears undo history when opening another file', async () => {
    await mount();
    await act(async () => { editor().commands.insertContentAt(1, '이전 문서 수정 '); save(); });
    const next = { ...sample, path: '/tmp/문서/다른 문서.md', hash: 'next', content: '# 두 번째 문서\n' };
    vi.mocked(fileBridge.read).mockResolvedValue(next);
    await act(async () => vi.mocked(fileBridge.onOpened).mock.calls[0][0]({ path: next.path }));
    expect(editor().getText()).toContain('두 번째 문서');
    await act(async () => editor().commands.undo());
    expect(editor().getText()).toContain('두 번째 문서');
    expect(editor().getText()).not.toContain('이전 문서 수정');
    expect(host.querySelector('h1')?.textContent).not.toContain('●');
  });

  it('changes tasks interactively and marks dirty; self events do not reload', async () => {
    await mount();
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(host.querySelector('li')?.dataset.checked).toBe('true');
    expect(host.querySelector('h1')?.textContent).toContain('●');
    await act(async () => save());
    expect(vi.mocked(fileBridge.writeMarkdown).mock.calls[0][1]).toContain('- [x] 작업');
    await act(async () => vi.mocked(fileBridge.onChanged).mock.calls[0][0]({ path: sample.path, hash: 'saved', source: 'self' }));
    expect(fileBridge.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['frontmatter', '---\ntitle: 한글\n---\n\n# 본문\n'],
    ['HTML', '<details><summary>한글</summary>내용</details>\n'],
    ['footnotes', '각주[^1]\n\n[^1]: 원문 보존\n'],
    ['math', '$$\nx^2 + 한글\n$$\n'],
    ['large', '# 큰 문서\n' + '가'.repeat(103000)],
  ])('saves %s source exactly, including in split view, without an editable preview', async (_kind, source) => {
    await mount({ ...sample, content: source });
    expect(button('블록').disabled).toBe(true);
    expect(host.querySelector('textarea')?.value).toBe(source);
    expect(host.querySelector('[contenteditable="true"]')).toBe(null);
    await act(async () => save());
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
    await act(async () => button('분할').click());
    expect(editor().isEditable).toBe(false);
    const exact = source + '\n새로운 원문 **한글**\n';
    await act(async () => { typeSource(exact); save(); });
    expect(fileBridge.writeMarkdown).toHaveBeenCalledWith(sample.path, exact, 'opened');
    expect(editor().isEditable).toBe(false);
  });

  it('switches source to rich by reparsing the latest source and keeps image destinations', async () => {
    await mount();
    await act(async () => button('소스').click());
    await act(async () => save());
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
    await act(async () => typeSource('# 새 제목\n\n![원본](./img/사진.png)\n\n새 본문\n'));
    await act(async () => button('블록').click());
    expect(editor().getText()).toContain('새 제목');
    expect(editor().getText()).not.toContain('작업');
    const image = host.querySelector('.tiptap img')!;
    expect(image.getAttribute('data-md-src')).toBe('./img/사진.png');
    await act(async () => { editor().commands.insertContentAt(1, '추가 '); save(); });
    expect(vi.mocked(fileBridge.writeMarkdown).mock.calls[0][1]).toContain('![원본](./img/사진.png)');
  });

  it('preserves the dirty draft on external changes and offers reload or Save As after a conflict', async () => {
    await mount();
    await act(async () => editor().commands.insertContentAt(1, '내 변경 '));
    vi.mocked(fileBridge.writeMarkdown).mockRejectedValue(new Error('conflict: 디스크 내용 변경'));
    const changed = vi.mocked(fileBridge.onChanged).mock.calls[0][0];
    await act(async () => changed({ path: sample.path, hash: 'external', source: 'external' }));
    expect(fileBridge.read).toHaveBeenCalledTimes(1);
    expect(editor().getText()).toContain('내 변경');
    await act(async () => save());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('파일이 외부에서 변경');
    expect([...host.querySelectorAll('button')].some((item) => /덮어쓰기|force/.test(item.textContent || ''))).toBe(false);
    await act(async () => save(true));
    expect(fileBridge.saveMarkdownAs).toHaveBeenCalled();
    expect(host.querySelector('h1')?.textContent).toContain('●');
    vi.mocked(fileBridge.read).mockResolvedValue({ ...sample, hash: 'external', content: '# 외부 최신 문서\n' });
    await act(async () => button('다시 불러오기 (내 변경 버림)').click());
    expect(editor().getText()).toContain('외부 최신 문서');
    expect(editor().getText()).not.toContain('내 변경');
  });

  it('[close-dialog] stays open after a failed save and can discard on retry', async () => {
    vi.mocked(fileBridge.askUnsavedChanges).mockResolvedValueOnce('save').mockResolvedValueOnce('discard');
    vi.mocked(fileBridge.writeMarkdown).mockRejectedValue(new Error('디스크 쓰기 실패'));
    await mount(); await act(async () => editor().commands.insertContentAt(1, '변경 '));
    const blocked = vi.mocked(fileBridge.onCloseBlocked).mock.calls[0][0];
    await act(async () => { blocked(); });
    expect(fileBridge.confirmClose).not.toHaveBeenCalled(); expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => { blocked(); }); expect(fileBridge.confirmClose).toHaveBeenCalledTimes(1);
  });
  it('[close-dialog] cancellation leaves the document open', async () => {
    vi.mocked(fileBridge.askUnsavedChanges).mockResolvedValueOnce('cancel'); await mount();
    await act(async () => editor().commands.insertContentAt(1, '변경 '));
    await act(async () => { vi.mocked(fileBridge.onCloseBlocked).mock.calls[0][0](); });
    expect(fileBridge.confirmClose).not.toHaveBeenCalled(); expect(editor().getText()).toContain('변경');
  });

  it('creates an untitled document and sends first Cmd+S through Save As', async () => {
    await mount();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true })));
    expect(host.querySelector('h1')?.textContent).toBe('제목 없음');
    await act(async () => { editor().commands.insertContentAt(1, '새 문서'); save(); });
    expect(fileBridge.saveMarkdownAs).toHaveBeenCalledWith('새 문서', '제목 없음.md', null);
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
  });


  it('mounts the slash menu, keeps keyboard selection, and inserts images through an inline form', async () => {
    await mount({ ...sample, content: '' });
    await act(async () => editor().commands.insertContent('/'));
    expect(host.querySelector('[role="listbox"]')).not.toBe(null);
    await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('제목 2');
    await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(editor().state.doc.firstChild?.attrs.level).toBe(2);
    await act(async () => editor().commands.insertContentAt(editor().state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: '/img' }] }));
    await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(host.querySelector('form[aria-label="이미지 삽입"]')).not.toBe(null);
    const input = host.querySelector<HTMLInputElement>('#slash-image-src')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, './img/새 사진.png');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host.querySelector('.tiptap img')?.getAttribute('data-md-src')).toBe('./img/새 사진.png');
    await act(async () => save());
    expect(vi.mocked(fileBridge.writeMarkdown).mock.calls[0][1]).toContain('![](<./img/새 사진.png>)');
    expect(host.querySelector('form')).toBe(null);
  });

  it('searches the source textarea with correct CRLF offsets', async () => {
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue({ statePath: '/tmp/state.json', query: '한글' });
    await mount({ ...sample, content: '---\r\ntitle: 한글\r\n---\r\n\r\n한글 본문\r\n' });
    expect(host.querySelector('[role="search"] [role="status"]')?.textContent).toBe('1 / 2');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="다음 일치 (Enter)"]')!.click());
    const input = host.querySelector('textarea')!;
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe('한글');
    expect(input.selectionStart).toBe(input.value.lastIndexOf('한글'));
    expect(fileBridge.setDocumentDirty).not.toHaveBeenCalledWith(true);
  });

  it('keeps the e2e edit hook inert without config', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
    expect(fileBridge.e2eGateOpen).not.toHaveBeenCalled();
    expect(fileBridge.setDocumentDirty).not.toHaveBeenCalledWith(true);
  });

  it.each(['rich', 'source'])('reports %s e2e edits and saves only after the gate opens', async (mode) => {
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue({ statePath: '/tmp/state.json', query: '', edit: 'e2e 추가 한글', saveGate: '/tmp/gate' });
    vi.mocked(fileBridge.e2eGateOpen).mockResolvedValue(false);
    await mount(mode === 'rich' ? sample : { ...sample, content: '---\ntitle: 무손실\n---\n\n본문\n' });
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
    expect(vi.mocked(reportE2eState).mock.calls.at(-1)?.[0]).toMatchObject({ edit: { applied: true, dirty: true, saveStatus: 'idle', mode } });
    vi.mocked(fileBridge.e2eGateOpen).mockResolvedValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fileBridge.writeMarkdown).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileBridge.writeMarkdown).mock.calls[0][1]).toContain('e2e 추가 한글');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(vi.mocked(reportE2eState).mock.calls.at(-1)?.[0]).toMatchObject({ loadCount: 1, edit: { applied: true, dirty: false, saveStatus: 'saved', mode } });
  });
});

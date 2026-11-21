import { describe, expect, it, vi } from 'vitest';
import type { FileBridge, HwpFileBridge, FileChanged, MarkdownFile } from '@/data/tauri-bridge';
import { createOpenFileSession, type OpenFileState, type ImportedDocument } from './open-file-session';

import type { HwpImporter } from '@/lib/hwp/worker-client';

function harness(importer?: HwpImporter) {
  const order: string[] = [];
  let opened: (event: { path: string }) => void = () => {};
  let changed: (event: FileChanged) => void = () => {};
  let hash = 'hash-1';
  let closeBlocked: () => void = () => {};
  const releaseClose = vi.fn();
  let state: OpenFileState;
  const releaseOpened = vi.fn();
  const releaseChanged = vi.fn();
  const bridge: FileBridge & Pick<HwpFileBridge, 'readHwpBytes' | 'pickHwp'> = {
    readHwpBytes: vi.fn(async () => Uint8Array.of(1, 2)), pickHwp: vi.fn(async () => '/tmp/보고서.hwp'),
    available: () => true,
    onCloseBlocked: vi.fn(async (handler) => { closeBlocked = handler; return releaseClose; }),
    writeMarkdown: vi.fn(async (path, content) => ({ path, hash: `saved:${content}`, mtimeMs: 2 })),
    saveMarkdownAs: vi.fn(async () => ({ path: '/tmp/new.md', hash: 'saved', mtimeMs: 2 })),
    setDocumentDirty: vi.fn(async () => {}), confirmClose: vi.fn(async () => {}),
    e2eGateOpen: vi.fn(async () => true),
    onOpened: vi.fn(async (handler) => { order.push('listen-open'); opened = handler; return releaseOpened; }),
    onChanged: vi.fn(async (handler) => { order.push('listen-change'); changed = handler; return releaseChanged; }),
    takePending: vi.fn(async () => { order.push('pending'); return ['/tmp/a.md']; }),
    read: vi.fn(async (path) => { order.push(`read:${path}`); return { path, content: `# ${hash}`, hash, mtimeMs: 1 }; }),
    watch: vi.fn(async (path) => { order.push(`watch:${path}`); }),
    unwatch: vi.fn(async () => {}), pick: vi.fn(async () => null), e2eConfig: vi.fn(async () => null),
  };
  const render = vi.fn(async (file: MarkdownFile, _assets?: ImportedDocument['assets']) => `<h1>${file.content}</h1>`);
  const session = createOpenFileSession(bridge, render, (value) => { state = value; }, importer);
  return { bridge, render, session, order, releaseOpened, releaseChanged, releaseClose,
    closeBlocked: () => closeBlocked(), selfChanged: () => changed({ path: '/tmp/a.md', hash: 'self', source: 'self' }),
    get state() { return state; }, opened: (path: string) => opened({ path }),
    changed: (path: string, nextHash: string) => { hash = nextHash; changed({ path, hash, source: 'external' }); },
  };
}

describe('file ViewModel lifecycle', () => {
  it('listens before draining pending files, reads then watches, deduplicates same-path opens', async () => {
    const h = harness();
    await h.session.start();
    expect(h.order).toEqual(['listen-open', 'listen-change', 'pending', 'read:/tmp/a.md', 'watch:/tmp/a.md']);
    h.opened('/tmp/a.md');
    await h.session.open('/tmp/a.md');
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    expect(h.state.loadCount).toBe(1);
    await h.session.stop();
    expect(h.releaseOpened).toHaveBeenCalledOnce();
    expect(h.releaseChanged).toHaveBeenCalledOnce();
    expect(h.bridge.unwatch).toHaveBeenCalledOnce();
  });
  it('reloads only changed hashes for the active file and preserves scroll intent', async () => {
    const h = harness();
    await h.session.start();
    h.changed('/tmp/a.md', 'hash-1');
    h.changed('/tmp/other.md', 'hash-2');
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    h.changed('/tmp/a.md', 'hash-2');
    await h.session.open('/tmp/a.md'); // drains the already scheduled reload
    expect(h.state.file?.hash).toBe('hash-2');
    expect(h.state.loadCount).toBe(2);
    expect(h.state.preserveScroll).toBe(true);
  });
  it('discards an old read when another file is selected while it is loading', async () => {
    const h = harness();
    let complete!: (file: MarkdownFile) => void;
    vi.mocked(h.bridge.read).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const first = h.session.open('/tmp/a.md');
    await Promise.resolve();
    const second = h.session.open('/tmp/b.md');
    complete({ path: '/tmp/a.md', content: 'old', hash: 'old', mtimeMs: 0 });
    await Promise.all([first, second]);
    expect(h.state.file?.path).toBe('/tmp/b.md');
    expect(h.bridge.watch).toHaveBeenCalledExactlyOnceWith('/tmp/b.md');
  });
  it('a warm event during startup wins over a stale pending entry', async () => {
    const h = harness();
    vi.mocked(h.bridge.takePending).mockImplementationOnce(async () => {
      h.opened('/tmp/new.md');
      return ['/tmp/old.md'];
    });
    await h.session.start();
    await h.session.open('/tmp/new.md');
    expect(h.state.file?.path).toBe('/tmp/new.md');
    expect(h.bridge.read).toHaveBeenCalledExactlyOnceWith('/tmp/new.md');
  });
  it('clears a closed file, ignores a late read, and releases the watcher', async () => {
    const h = harness();
    let complete!: (file: MarkdownFile) => void;
    vi.mocked(h.bridge.read).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const opening = h.session.open('/tmp/a.md');
    await Promise.resolve();
    const closing = h.session.close();
    complete({ path: '/tmp/a.md', content: 'late', hash: 'late', mtimeMs: 0 });
    await Promise.all([opening, closing]);
    expect(h.state.file).toBeNull();
    expect(h.bridge.watch).not.toHaveBeenCalled();
    expect(h.bridge.unwatch).toHaveBeenCalledOnce();
  });
  it('keeps the last readable document on errors and permits retrying the failed path', async () => {
    const h = harness();
    await h.session.start();
    vi.mocked(h.bridge.read).mockRejectedValueOnce(new Error('읽을 수 없습니다'));
    await h.session.open('/tmp/b.md');
    expect(h.state.file?.path).toBe('/tmp/a.md');
    expect(h.state.error).toBe('읽을 수 없습니다');
    await h.session.open('/tmp/b.md');
    expect(h.state.file?.path).toBe('/tmp/b.md');
    expect(h.state.error).toBeNull();
  });
  it('releases a listener that finishes registering after disposal', async () => {
    const h = harness();
    const starting = h.session.start();
    await h.session.stop();
    await starting;
    expect(h.releaseOpened).toHaveBeenCalledOnce();
    expect(h.bridge.takePending).not.toHaveBeenCalled();
  });
  it('allows retrying the same file after a watcher error', async () => {
    const h = harness();
    vi.mocked(h.bridge.watch).mockRejectedValueOnce(new Error('감시 시작 실패'));
    await h.session.start();
    expect(h.state.error).toBe('감시 시작 실패');
    await h.session.open('/tmp/a.md');
    expect(h.bridge.watch).toHaveBeenCalledTimes(2);
    expect(h.state.error).toBeNull();
  });
});

describe('safe editing and saving', () => {
  it('skips both serialization and disk writes when unchanged', async () => {
    const h = harness(); await h.session.start();
    const serialize = vi.fn(() => 'normalized');
    await h.session.save(serialize);
    expect(serialize).not.toHaveBeenCalled();
    expect(h.bridge.writeMarkdown).not.toHaveBeenCalled();
  });
  it('writes exact content with the open hash and clears dirty', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    await h.session.save(() => '# 한글\r\n');
    expect(h.bridge.writeMarkdown).toHaveBeenCalledExactlyOnceWith('/tmp/a.md', '# 한글\r\n', 'hash-1');
    expect(h.state).toMatchObject({ dirty: false, saveStatus: 'saved', loadCount: 1 });
    expect(h.state.file?.content).toBe('# 한글\r\n');
    expect(h.bridge.setDocumentDirty).toHaveBeenLastCalledWith(false);
  });
  it('keeps local edits on a conflict and never offers a force write', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    vi.mocked(h.bridge.writeMarkdown).mockRejectedValueOnce('conflict: changed on disk');
    await h.session.save(() => 'local');
    expect(h.state).toMatchObject({ dirty: true, saveStatus: 'conflict', externalPending: true });
    expect(h.state.file?.hash).toBe('hash-1');
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
  });
  it('defers external changes while dirty; explicit reload discards edits', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    h.changed('/tmp/a.md', 'external');
    await h.session.open('/tmp/a.md');
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    expect(h.state.externalPending).toBe(true);
    await h.session.reloadFromDisk();
    expect(h.state).toMatchObject({ dirty: false, externalPending: false });
    expect(h.state.file?.hash).toBe('external');
  });
  it('ignores self events even before a save response', async () => {
    const h = harness(); await h.session.start();
    h.selfChanged(); await h.session.open('/tmp/a.md');
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    expect(h.state.externalPending).toBe(false);
  });
  it('sends an untitled first save to Save As; cancellation keeps it dirty', async () => {
    const h = harness(); await h.session.start(); await h.session.newDocument();
    h.session.markDirty();
    vi.mocked(h.bridge.saveMarkdownAs).mockResolvedValueOnce(null);
    await h.session.save(() => '새 문서');
    expect(h.state).toMatchObject({ untitled: true, dirty: true, saveStatus: 'idle' });
    await h.session.save(() => '새 문서');
    expect(h.bridge.saveMarkdownAs).toHaveBeenLastCalledWith('새 문서', '제목 없음.md', null);
    expect(h.bridge.writeMarkdown).not.toHaveBeenCalled();
    expect(h.bridge.watch).toHaveBeenLastCalledWith('/tmp/new.md');
    expect(h.state).toMatchObject({ untitled: false, dirty: false, saveStatus: 'saved' });
  });
  it('rebases Save As images using a hash-checked write and refreshes the document', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    vi.mocked(h.bridge.saveMarkdownAs).mockResolvedValueOnce({ path: '/else/new.md', hash: 'created', mtimeMs: 2 });
    await h.session.saveAs(() => '![그림](./img/a.png)');
    expect(h.bridge.saveMarkdownAs).toHaveBeenCalledWith('![그림](./img/a.png)', 'a.md', '/tmp/a.md');
    expect(h.bridge.writeMarkdown).toHaveBeenCalledWith('/else/new.md', '![그림](../tmp/img/a.png)', 'created');
    expect(h.state.file?.content).toBe('![그림](../tmp/img/a.png)');
    expect(h.state.revision).toBe(2);
  });
  it('keeps newer keystrokes dirty and uses the saved hash for the next save', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    let finish!: (value: { path: string; hash: string; mtimeMs: number }) => void;
    vi.mocked(h.bridge.writeMarkdown).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const saving = h.session.save(() => 'first'); await Promise.resolve();
    h.session.markDirty(); finish({ path: '/tmp/a.md', hash: 'first-hash', mtimeMs: 2 }); await saving;
    expect(h.state.dirty).toBe(true);
    await h.session.save(() => 'second');
    expect(h.bridge.writeMarkdown).toHaveBeenLastCalledWith('/tmp/a.md', 'second', 'first-hash');
    expect(h.state.dirty).toBe(false);
  });
  it('protects open, new and close and executes only the confirmed pending action', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    await h.session.open('/tmp/b.md');
    expect(h.state.closeBlocked).toBe(true); expect(h.state.file?.path).toBe('/tmp/a.md');
    h.session.cancelClose(); expect(h.state.closeBlocked).toBe(false);
    await h.session.newDocument(); await h.session.confirmClose(false);
    expect(h.state.untitled).toBe(true); expect(h.bridge.confirmClose).not.toHaveBeenCalled();
    h.session.markDirty(); await h.session.close();
    await h.session.confirmClose(true, () => 'new');
    expect(h.state.file).toBeNull();
  });
  it('closes the native window only after saving, and remains open on conflict', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty(); h.closeBlocked();
    vi.mocked(h.bridge.writeMarkdown).mockRejectedValueOnce('conflict: changed');
    await h.session.confirmClose(true, () => 'local');
    expect(h.bridge.confirmClose).not.toHaveBeenCalled(); expect(h.state.closeBlocked).toBe(true);
    await h.session.confirmClose(false);
    expect(h.bridge.confirmClose).toHaveBeenCalledOnce();
    await h.session.stop(); expect(h.releaseClose).toHaveBeenCalledOnce();
  });
  it('detects unsupported documents and writes source edits exactly', async () => {
    const h = harness();
    vi.mocked(h.bridge.read).mockResolvedValueOnce({ path: '/tmp/a.md', content: '---\r\ntitle: 한글\r\n---\r\n', hash: 'hash-1', mtimeMs: 1 });
    await h.session.start(); expect(h.state.unsupported).toEqual(['frontmatter']);
    h.session.markDirty(); const source = '---\ntitle: 수정\n---\n\n';
    await h.session.save(() => source);
    expect(h.bridge.writeMarkdown).toHaveBeenCalledWith('/tmp/a.md', source, 'hash-1');
  });
  it('does not replace a dirty document with an automatic read already in flight', async () => {
    const h = harness(); await h.session.start();
    let finish!: (file: MarkdownFile) => void;
    vi.mocked(h.bridge.read).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    h.changed('/tmp/a.md', 'new-hash'); await Promise.resolve();
    h.session.markDirty(); finish({ path: '/tmp/a.md', content: 'external', hash: 'new-hash', mtimeMs: 3 });
    await h.session.open('/tmp/a.md');
    expect(h.state.file?.hash).toBe('hash-1');
    expect(h.state).toMatchObject({ dirty: true, externalPending: true, loadCount: 1 });
  });
  it('also protects a keystroke before the queued automatic read starts', async () => {
    const h = harness(); await h.session.start();
    h.changed('/tmp/a.md', 'new-hash'); h.session.markDirty();
    await h.session.open('/tmp/a.md');
    expect(h.state.file?.hash).toBe('hash-1');
    expect(h.state).toMatchObject({ dirty: true, externalPending: true, loadCount: 1 });
  });
  it('retains an external notification arriving between a disk write and its response', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty();
    vi.mocked(h.bridge.writeMarkdown).mockImplementationOnce(async (path) => {
      h.changed(path, 'external-after-write'); return { path, hash: 'own-write', mtimeMs: 3 };
    });
    await h.session.save(() => 'own-write');
    expect(h.state.externalPending).toBe(true);
    expect(h.bridge.read).toHaveBeenCalledTimes(1);
    expect(h.state.file?.hash).toBe('own-write');
  });
});


const imported: ImportedDocument = { markdown: '# 가져온 제목\n\n문단\n', suggestedName: '보고서.md', assets: [],
  warnings: [{ code: 'footnote-skipped', count: 2 }], source: 'hwp' };
const parsed = { ...imported, stats: { headings: 1, paragraphs: 1, tables: 0, images: 0, imageReferences: 0, imageMappings: 0, skippedImages: 0 } };
describe('imported document session', () => {
  it('opens imported content as a dirty untitled document with warnings and stops watching the prior file', async () => {
    const h = harness(); await h.session.start(); await h.session.openImported(imported);
    expect(h.state).toMatchObject({ file: { path: '', content: imported.markdown, hash: '' }, untitled: true, dirty: true,
      suggestedName: '보고서.md', importWarnings: imported.warnings, importStatus: 'done', importProgress: 100,
      importResult: { done: true, kind: 'hwp', untitled: true, dirty: true, warningCodes: ['footnote-skipped'] } });
    expect(h.bridge.unwatch).toHaveBeenCalledOnce(); expect(h.bridge.setDocumentDirty).toHaveBeenLastCalledWith(true);
    expect(h.bridge.writeMarkdown).not.toHaveBeenCalled(); expect(h.bridge.saveMarkdownAs).not.toHaveBeenCalled();
  });
  it('keeps extracted assets in memory and gives them to the renderer without writes', async () => {
    const h = harness(); const asset = { name: 'img-001.png', mimeType: 'image/png', bytes: Uint8Array.of(1, 2) };
    await h.session.openImported({ ...imported, assets: [asset] });
    expect(h.state.pendingAssets).toEqual([asset]);
    expect(h.render).toHaveBeenCalledWith(expect.objectContaining({ path: '' }), [asset]);
    expect(h.bridge.saveMarkdownAs).not.toHaveBeenCalled();
  });
  it('uses existing save-as for an import without images and suggests its source basename only', async () => {
    const h = harness(); await h.session.openImported(imported); await h.session.save(() => '수정된 내용');
    expect(h.bridge.saveMarkdownAs).toHaveBeenCalledWith('수정된 내용', '보고서.md', null);
    expect(h.state).toMatchObject({ untitled: false, dirty: false, file: { path: '/tmp/new.md' } });
  });
  it('protects dirty contents before import and resumes only after discard confirmation', async () => {
    const parse = vi.fn(async () => parsed); const h = harness({ parse });
    await h.session.start(); h.session.markDirty(); await h.session.importHwp('/tmp/보고서.hwp');
    expect(h.state.closeBlocked).toBe(true); expect(parse).not.toHaveBeenCalled();
    await h.session.confirmClose(false); expect(parse).toHaveBeenCalledOnce(); expect(h.state.untitled).toBe(true);
  });
  it('cancelling the dirty replacement prompt preserves the current document', async () => {
    const h = harness(); await h.session.start(); h.session.markDirty(); await h.session.openImported(imported);
    h.session.cancelClose(); expect(h.state.file?.path).toBe('/tmp/a.md'); expect(h.state.dirty).toBe(true);
  });
  it('uses the unchanged source-only detector for imported HTML tables', async () => {
    const h = harness(); await h.session.openImported({ ...imported, markdown: '<table><tr><td colspan="2">병합</td></tr></table>' });
    expect(h.state.unsupported).toContain('html'); expect(h.state.file?.content).toContain('colspan="2"');
  });
  it('reads selected bytes, sends format and progress to the worker, then opens an untitled result', async () => {
    const parse: HwpImporter['parse'] = vi.fn(async (_bytes, format, options) => {
      expect(format).toBe('hwpx'); options?.onProgress?.(48, '표 읽기');
      expect(h.state.importProgress).toBe(48); return parsed;
    });
    const h = harness({ parse }); await h.session.importHwp('/tmp/한글 보고서.HWPX');
    expect(h.bridge.readHwpBytes).toHaveBeenCalledExactlyOnceWith('/tmp/한글 보고서.HWPX');
    expect(h.state).toMatchObject({ untitled: true, suggestedName: '한글 보고서.md', importResult: { kind: 'hwpx' } });
  });
  it('shows read/parse errors while retaining the previous document', async () => {
    const h = harness({ parse: vi.fn(async () => { throw Error('암호화 문서는 가져올 수 없습니다.'); }) });
    await h.session.start(); await h.session.importHwp('/tmp/보고서.hwp');
    expect(h.state).toMatchObject({ importStatus: 'error', error: '암호화 문서는 가져올 수 없습니다.', isLoading: false });
    expect(h.state.file?.path).toBe('/tmp/a.md');
  });
  it('terminates an in-flight import when a new document replaces it', async () => {
    let signal: AbortSignal | undefined;
    const h = harness({ parse: vi.fn<HwpImporter['parse']>((_bytes, _format, options) => new Promise((_resolve, reject) => {
      signal = options?.signal; signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')));
    })) });
    const pending = h.session.importHwp('/tmp/a.hwp');
    await vi.waitFor(() => expect(signal).toBeDefined());
    await h.session.newDocument(); await pending;
    expect(signal?.aborted).toBe(true); expect(h.state).toMatchObject({ untitled: true, dirty: false, importStatus: 'idle' });
    expect(h.state.file?.content).toBe('');
  });
  it('discards a stale import result after a different file is opened even if the importer ignores abort', async () => {
    let resolve!: (value: typeof parsed) => void;
    const h = harness({ parse: () => new Promise(done => { resolve = done; }) });
    const pending = h.session.importHwp('/tmp/a.hwp'); await vi.waitFor(() => expect(resolve).toBeDefined());
    const next = h.session.open('/tmp/new.md'); resolve(parsed); await Promise.all([pending, next]);
    expect(h.state.file?.path).toBe('/tmp/new.md'); expect(h.state.untitled).toBe(false);
  });
  it('does not overwrite edits made while parsing', async () => {
    let resolve!: (value: typeof parsed) => void;
    const h = harness({ parse: () => new Promise(done => { resolve = done; }) }); await h.session.start();
    const pending = h.session.importHwp('/tmp/a.hwp'); await vi.waitFor(() => expect(resolve).toBeDefined());
    h.session.markDirty(); resolve(parsed); await pending;
    expect(h.state.file?.path).toBe('/tmp/a.md'); expect(h.state.dirty).toBe(true); expect(h.state.error).toContain('편집되어 교체하지');
  });
  it('cancels and releases in-flight work on stop without committing late content', async () => {
    let signal: AbortSignal | undefined;
    const h = harness({ parse: (_bytes, _format, options) => new Promise((_resolve, reject) => {
      signal = options?.signal; signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')));
    }) });
    const pending = h.session.importHwp('/tmp/a.hwp'); await vi.waitFor(() => expect(signal).toBeDefined());
    await h.session.stop(); await pending; expect(signal?.aborted).toBe(true); expect(h.state.file).toBeNull();
  });
  it('protects unsaved imports against close and new-document requests', async () => {
    const h = harness(); await h.session.openImported(imported); await h.session.close();
    expect(h.state.closeBlocked).toBe(true); h.session.cancelClose(); await h.session.newDocument();
    expect(h.state.closeBlocked).toBe(true); expect(h.state.file?.content).toBe(imported.markdown);
  });
  it('handles native picker cancellation without replacing the document or reading bytes', async () => {
    const h = harness({ parse: vi.fn(async () => parsed) }); await h.session.start();
    vi.mocked(h.bridge.pickHwp).mockResolvedValue(null); await h.session.pickHwp();
    expect(h.bridge.readHwpBytes).not.toHaveBeenCalled(); expect(h.state.file?.path).toBe('/tmp/a.md');
  });
  it('keeps edits typed while imported content is rendering instead of replacing the draft', async () => {
    const h = harness({ parse: vi.fn(async () => parsed) }); await h.session.start();
    let finish!: (html: string) => void;
    h.render.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const pending = h.session.importHwp('/tmp/a.hwp'); await vi.waitFor(() => expect(finish).toBeDefined());
    h.session.markDirty(); finish('<h1>가져옴</h1>'); await pending;
    expect(h.state.file?.path).toBe('/tmp/a.md'); expect(h.state.dirty).toBe(true);
    expect(h.state.error).toContain('편집되어 교체하지');
  });
  it('manual cancellation during a native read prevents starting the worker and keeps the prior file', async () => {
    const parse = vi.fn(async () => parsed); const h = harness({ parse }); await h.session.start();
    let finish!: (bytes: Uint8Array) => void;
    vi.mocked(h.bridge.readHwpBytes).mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const pending = h.session.importHwp('/tmp/a.hwp'); await vi.waitFor(() => expect(finish).toBeDefined());
    h.session.cancelImport(); finish(Uint8Array.of(1, 2)); await pending;
    expect(parse).not.toHaveBeenCalled(); expect(h.state).toMatchObject({ importStatus: 'idle', isLoading: false, file: { path: '/tmp/a.md' } });
  });

  it('lets a warm HWP open during startup win over stale pending Markdown files', async () => {
    const h = harness({ parse: vi.fn(async () => parsed) });
    vi.mocked(h.bridge.takePending).mockImplementationOnce(async () => { h.opened('/tmp/warm.hwp'); return ['/tmp/stale.md']; });
    await h.session.start(); await vi.waitFor(() => expect(h.state.importResult?.done).toBe(true));
    expect(h.bridge.readHwpBytes).toHaveBeenCalledExactlyOnceWith('/tmp/warm.hwp');
    expect(h.bridge.read).not.toHaveBeenCalled();
    expect(h.state.importResult?.done).toBe(true);
  });

});

describe('[open-merge] picker routing', () => {
  it('[open-merge] imports an HWP selection and retains its original', async () => {
    const h = harness({ parse: vi.fn(async () => parsed) });
    vi.mocked(h.bridge.pick).mockResolvedValue('/tmp/보고서.hwp');
    await h.session.pick();
    expect(h.bridge.readHwpBytes).toHaveBeenCalledExactlyOnceWith('/tmp/보고서.hwp');
    expect(h.bridge.read).not.toHaveBeenCalled();
    expect(h.state.original?.kind).toBe('hwp');
    expect(h.state.importWarnings).toEqual(imported.warnings);
  });
  it('[open-merge] imports an uppercase HWPX selection and retains its original', async () => {
    const h = harness({ parse: vi.fn(async () => parsed) });
    vi.mocked(h.bridge.pick).mockResolvedValue('/tmp/보고서.HWPX');
    await h.session.pick();
    expect(h.bridge.readHwpBytes).toHaveBeenCalledExactlyOnceWith('/tmp/보고서.HWPX');
    expect(h.bridge.read).not.toHaveBeenCalled();
    expect(h.state.original?.kind).toBe('hwpx');
  });
  it('[open-merge] opens Markdown selections through the Markdown reader', async () => {
    for (const path of ['/tmp/note.md', '/tmp/note.markdown', '/tmp/note.mdown']) {
      const h = harness({ parse: vi.fn(async () => parsed) });
      vi.mocked(h.bridge.pick).mockResolvedValue(path);
      await h.session.pick();
      expect(h.bridge.read).toHaveBeenCalledExactlyOnceWith(path);
      expect(h.bridge.readHwpBytes).not.toHaveBeenCalled();
      expect(h.state.file?.path).toBe(path);
    }
  });
});

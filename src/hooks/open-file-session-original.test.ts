import { describe, expect, it, vi } from 'vitest';
import type { FileBridge, HwpFileBridge } from '@/data/tauri-bridge';
import type { HwpImporter } from '@/lib/hwp/worker-client';
import { createOpenFileSession, emptyFileState, type OpenFileState } from './open-file-session';

const parsed = { markdown: '# 가져온 문서', assets: [], warnings: [],
  stats: { headings: 1, paragraphs: 0, tables: 0, images: 0, imageReferences: 0, imageMappings: 0, skippedImages: 0 } };
function harness() {
  let state: OpenFileState = emptyFileState;
  const bytes = Uint8Array.of(1, 2, 3);
  const bridge: FileBridge & Partial<HwpFileBridge> = {
    available: () => true, onOpened: vi.fn(async () => () => {}), onChanged: vi.fn(async () => () => {}),
    onCloseBlocked: vi.fn(async () => () => {}), takePending: vi.fn(async () => []),
    read: vi.fn(async path => ({ path, content: '# Markdown', hash: 'read', mtimeMs: 0 })),
    watch: vi.fn(async () => {}), unwatch: vi.fn(async () => {}), pick: vi.fn(),
    e2eConfig: vi.fn(async () => null), e2eGateOpen: vi.fn(async () => true),
    setDocumentDirty: vi.fn(async () => {}), confirmClose: vi.fn(async () => {}),
    readHwpBytes: vi.fn(async () => bytes),
    writeMarkdown: vi.fn(), saveImportedMarkdownAs: vi.fn(), saveHwpxAs: vi.fn(),
    saveMarkdownAs: vi.fn(async () => ({ path: '/tmp/imported.md', hash: 'saved', mtimeMs: 1 })),
  };
  const parse = vi.fn<HwpImporter['parse']>(async () => parsed);
  const session = createOpenFileSession(bridge, async file => file.content, next => { state = next; }, { parse });
  return { bridge, bytes, parse, session, get state() { return state; } };
}

describe('import snapshot lifecycle', () => {
  it('retains HWP bytes in memory without writing any file', async () => {
    const h = harness(); await h.session.importHwp('/tmp/original.hwp');
    expect(h.state.original).toEqual({ bytes: Uint8Array.of(1, 2, 3), kind: 'hwp' });
    expect(h.bridge.writeMarkdown).not.toHaveBeenCalled();
    expect(h.bridge.saveMarkdownAs).not.toHaveBeenCalled();
    expect(h.bridge.saveImportedMarkdownAs).not.toHaveBeenCalled();
    expect(h.bridge.saveHwpxAs).not.toHaveBeenCalled();
  });
  it('preserves the snapshot even when the parser transfers and detaches its input', async () => {
    const h = harness();
    h.parse.mockImplementation(async bytes => {
      structuredClone(bytes, { transfer: [bytes.buffer] });
      expect(bytes.byteLength).toBe(0);
      return parsed;
    });
    await h.session.importHwp('/tmp/original.hwp');
    expect(h.state.original?.bytes).toEqual(Uint8Array.of(1, 2, 3));
  });
  it('records HWPX format and replaces the previous snapshot on reimport', async () => {
    const h = harness(); await h.session.importHwp('/tmp/first.hwp');
    const first = h.state.original;
    vi.mocked(h.bridge.readHwpBytes!).mockResolvedValueOnce(Uint8Array.of(4, 5));
    await h.session.importHwp('/tmp/second.HWPX', true);
    expect(h.state.original).toEqual({ bytes: Uint8Array.of(4, 5), kind: 'hwpx' });
    expect(h.state.original).not.toBe(first);
  });
  it('keeps ordinary Markdown documents free of an original snapshot', async () => {
    const h = harness(); expect(h.state.original).toBeNull();
    await h.session.open('/tmp/plain.md'); expect(h.state.original).toBeNull();
    expect(h.bridge.readHwpBytes).not.toHaveBeenCalled();
  });
  it('releases the snapshot when the imported document is closed', async () => {
    const h = harness(); await h.session.importHwp('/tmp/original.hwp');
    await h.session.close(); expect(h.state.original).not.toBeNull();
    await h.session.confirmClose(false);
    expect(h.state.original).toBeNull(); expect(h.state.file).toBeNull();
  });
  it('releases the snapshot when a new document replaces the import', async () => {
    const h = harness(); await h.session.importHwp('/tmp/original.hwp');
    await h.session.newDocument(true);
    expect(h.state.original).toBeNull(); expect(h.state.file?.content).toBe('');
  });
  it('releases the snapshot when a Markdown file replaces the import', async () => {
    const h = harness(); await h.session.importHwp('/tmp/original.hwp');
    await h.session.open('/tmp/other.md', false, true);
    expect(h.state.original).toBeNull(); expect(h.state.file?.path).toBe('/tmp/other.md');
  });
  it('retains the exact snapshot after editing and the first Markdown save', async () => {
    const h = harness(); await h.session.importHwp('/tmp/original.hwp');
    const original = h.state.original;
    h.session.markDirty(); await h.session.save(() => '# 수정');
    expect(h.state.original).toBe(original);
    expect(h.state).toMatchObject({ untitled: false, dirty: false, file: { content: '# 수정' } });
    expect(h.bridge.saveMarkdownAs).toHaveBeenCalledExactlyOnceWith('# 수정', 'original.md', null);
    expect(h.bridge.writeMarkdown).not.toHaveBeenCalled(); expect(h.bridge.saveHwpxAs).not.toHaveBeenCalled();
  });
  it('retains the prior snapshot if replacement fails or the user cancels replacement', async () => {
    const h = harness(); await h.session.importHwp('/tmp/original.hwp');
    const original = h.state.original;
    await h.session.importHwp('/tmp/other.hwpx'); h.session.cancelClose();
    expect(h.state.original).toBe(original); expect(h.parse).toHaveBeenCalledOnce();
    h.parse.mockRejectedValueOnce(Error('손상된 파일'));
    await h.session.importHwp('/tmp/other.hwpx', true);
    expect(h.state.original).toBe(original); expect(h.state.importStatus).toBe('error');
  });
  it('does not resurrect a snapshot from a late parse after closing', async () => {
    const h = harness(); let finish!: (result: typeof parsed) => void;
    h.parse.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const importing = h.session.importHwp('/tmp/original.hwp');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const closing = h.session.close(true); finish(parsed);
    await Promise.all([importing, closing]);
    expect(h.state.original).toBeNull(); expect(h.state.file).toBeNull();
  });
});

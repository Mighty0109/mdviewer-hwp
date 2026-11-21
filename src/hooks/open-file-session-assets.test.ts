import { describe, expect, it, vi } from 'vitest';
import type { FileBridge, HwpFileBridge, SavedImportedMarkdown } from '@/data/tauri-bridge';
import { IMPORT_ASSET_PREFIX } from '@/domain/hwp-assets';
import { parseHwp } from '@/lib/hwp/parse';
import { binaryTable, buildHwp, concat, control, para, picture } from '@/lib/hwp/parse/testing/builders';
import { buildCaptionFixture } from '../../scripts/hwp-e2e-fixture.mjs';
import { createOpenFileSession, emptyFileState, type ImportedDocument, type OpenFileState } from './open-file-session';

const assets = [{ name: 'img-001.png', mimeType: 'image/png', bytes: Uint8Array.of(0, 137, 255) }];
const markdown = `# 가져옴\n\n![그림](${IMPORT_ASSET_PREFIX}img-001.png)\n`;
const imported: ImportedDocument = { markdown, assets, warnings: [], suggestedName: '한글 문서.md', source: 'hwpx' };
const saved: SavedImportedMarkdown = { path: '/tmp/한글 문서.md', hash: 'disk-hash', mtimeMs: 2, assetsDir: '한글 문서.assets' };
const rewritten = markdown.replace(IMPORT_ASSET_PREFIX, '%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.assets/');
function harness() {
  let state: OpenFileState = emptyFileState;
  const bridge: FileBridge & Pick<HwpFileBridge, 'saveImportedMarkdownAs'> = {
    available: () => true, onOpened: vi.fn(async () => () => {}), onChanged: vi.fn(async () => () => {}),
    onCloseBlocked: vi.fn(async () => () => {}), takePending: vi.fn(async () => []),
    read: vi.fn(), watch: vi.fn(async () => {}), unwatch: vi.fn(async () => {}), pick: vi.fn(),
    e2eConfig: vi.fn(async () => null), e2eGateOpen: vi.fn(async () => true),
    writeMarkdown: vi.fn(async (path) => ({ path, hash: 'later-hash', mtimeMs: 3 })),
    saveMarkdownAs: vi.fn(async () => ({ path: '/tmp/plain.md', hash: 'plain', mtimeMs: 2 })),
    saveImportedMarkdownAs: vi.fn(async () => saved), setDocumentDirty: vi.fn(async () => {}), confirmClose: vi.fn(async () => {}),
  };
  const render = vi.fn(async (file: { content: string }) => file.content);
  const session = createOpenFileSession(bridge, render, next => { state = next; });
  return { bridge, session, render, get state() { return state; } };
}

describe('first save of imported assets', () => {
  it.each(['hwp', 'hwpx'] as const)('preserves parsed %s captions, field display text and reduction warnings through first save', async source => {
    const bytes = source === 'hwpx' ? await buildCaptionFixture() : buildHwp({ body: concat(
      binaryTable(false, false, 0, ['캡션 표 설명']), picture(1), control('%hlk', para('필드 표시 글', 2)),
    ) });
    const original = bytes.slice();
    const parsed = await parseHwp(bytes);
    const h = harness();
    await h.session.openImported({ ...parsed, suggestedName: '캡션.md', source });
    expect(h.state.file?.content).toContain('캡션 표 설명');
    expect(h.state.file?.content).toContain('필드 표시 글');
    expect(h.state.file?.content).toContain('캡션 배치 제외: 텍스트만 가져옴');
    if (source === 'hwpx') {
      expect(h.state.file?.content).toContain('캡션 그림 설명');
      expect(h.state.file?.content).toContain('필드 정보 제외: 표시 글만 가져옴');
    } else expect(h.state.file?.content).toContain('개체 제외');
    expect(h.state.importWarnings).toContainEqual({ code: 'object-skipped', count: source === 'hwpx' ? 2 : 1, detail: 'caption-layout' });
    const report = h.state.importResult;
    await h.session.saveAs(() => parsed.markdown);
    expect(h.bridge.saveImportedMarkdownAs).toHaveBeenCalledExactlyOnceWith(parsed.markdown, '캡션.md', parsed.assets);
    expect(h.state.file?.content).toBe(parsed.markdown.replaceAll(IMPORT_ASSET_PREFIX, '%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.assets/'));
    expect(h.state.importWarnings).toEqual(parsed.warnings);
    expect(h.state.importResult).toEqual(report);
    expect(h.state).toMatchObject({ pendingAssets: [], untitled: false, dirty: false, saveStatus: 'saved' });
    expect(bytes).toEqual(original);
  });
  it('keeps images in memory until Save As and then rewrites paths, clears pending assets and watches the saved document', async () => {
    const h = harness(); await h.session.openImported(imported);
    expect(h.bridge.saveImportedMarkdownAs).not.toHaveBeenCalled();
    await h.session.saveAs(() => markdown);
    expect(h.bridge.saveImportedMarkdownAs).toHaveBeenCalledExactlyOnceWith(markdown, '한글 문서.md', assets);
    expect(h.bridge.saveMarkdownAs).not.toHaveBeenCalled(); expect(h.bridge.writeMarkdown).not.toHaveBeenCalled();
    expect(h.state).toMatchObject({ untitled: false, dirty: false, pendingAssets: [], saveStatus: 'saved',
      file: { path: saved.path, hash: saved.hash, mtimeMs: saved.mtimeMs, content: rewritten } });
    expect(h.state.file).not.toHaveProperty('assetsDir');
    expect(h.state.html).toBe(rewritten);
    expect(h.bridge.watch).toHaveBeenCalledExactlyOnceWith(saved.path);
    expect(h.bridge.setDocumentDirty).toHaveBeenLastCalledWith(false);
  });
  it('routes the untitled ordinary save through the same asset command, then uses hash-checked ordinary saves', async () => {
    const h = harness(); await h.session.openImported(imported); await h.session.save(() => markdown);
    h.session.markDirty(); await h.session.save(() => rewritten + '\n수정');
    expect(h.bridge.saveImportedMarkdownAs).toHaveBeenCalledOnce();
    expect(h.bridge.writeMarkdown).toHaveBeenCalledExactlyOnceWith(saved.path, rewritten + '\n수정', 'disk-hash');
  });
  it('keeps the untitled draft and pending bytes when the native panel is cancelled', async () => {
    const h = harness(); await h.session.openImported(imported);
    vi.mocked(h.bridge.saveImportedMarkdownAs).mockResolvedValueOnce(null);
    await h.session.saveAs(() => markdown);
    expect(h.state).toMatchObject({ untitled: true, dirty: true, pendingAssets: assets, file: { path: '', content: markdown }, saveStatus: 'idle' });
    expect(h.bridge.watch).not.toHaveBeenCalled();
    await h.session.saveAs(() => markdown); expect(h.state.pendingAssets).toEqual([]);
  });
  it('retains assets and draft on disk failure, reports the reason and permits retry', async () => {
    const h = harness(); await h.session.openImported(imported);
    vi.mocked(h.bridge.saveImportedMarkdownAs).mockRejectedValueOnce(Error('Cannot publish document: disk full'));
    await h.session.saveAs(() => markdown);
    expect(h.state).toMatchObject({ untitled: true, dirty: true, pendingAssets: assets, saveStatus: 'error', error: 'Cannot publish document: disk full' });
    expect(h.bridge.watch).not.toHaveBeenCalled();
    await h.session.saveAs(() => markdown); expect(h.state.saveStatus).toBe('saved');
  });
  it('uses the existing Save As path for imports with no pending images and for ordinary new documents', async () => {
    const h = harness(); await h.session.openImported({ ...imported, assets: [], markdown: '문단' });
    await h.session.saveAs(() => '문단');
    expect(h.bridge.saveMarkdownAs).toHaveBeenCalledWith('문단', '한글 문서.md', null);
    await h.session.newDocument(); h.session.markDirty(); await h.session.save(() => '일반');
    expect(h.bridge.saveMarkdownAs).toHaveBeenLastCalledWith('일반', '제목 없음.md', null);
    expect(h.bridge.saveImportedMarkdownAs).not.toHaveBeenCalled();
  });
  it('retains newer edits made during the asset write while replacing their placeholder paths', async () => {
    const h = harness(); await h.session.openImported(imported);
    let finish!: (value: SavedImportedMarkdown) => void;
    let draft = markdown;
    vi.mocked(h.bridge.saveImportedMarkdownAs).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = h.session.save(() => draft);
    await vi.waitFor(() => expect(finish).toBeDefined());
    draft += '\n저장 중 입력'; h.session.markDirty(); finish(saved); await saving;
    expect(h.state).toMatchObject({ untitled: false, dirty: true, pendingAssets: [], saveStatus: 'idle' });
    expect(h.state.file?.content).toBe(rewritten + '\n저장 중 입력');
    expect(h.state.html).toBe(rewritten + '\n저장 중 입력');
    await h.session.save(() => draft);
    expect(h.bridge.writeMarkdown).toHaveBeenLastCalledWith(saved.path, rewritten + '\n저장 중 입력', saved.hash);
  });
  it('preserves edits arriving while the rewritten saved document is rendering', async () => {
    const h = harness(); await h.session.openImported(imported);
    let draft = markdown; let finish!: (html: string) => void;
    h.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = h.session.save(() => draft); await vi.waitFor(() => expect(finish).toBeDefined());
    draft += '\n렌더 중 입력'; h.session.markDirty(); finish('stale'); await saving;
    expect(h.state.file?.content).toBe(rewritten + '\n렌더 중 입력');
    expect(h.state.html).toBe(rewritten + '\n렌더 중 입력'); expect(h.state.dirty).toBe(true);
  });
  it('clears imported path mapping when another document replaces the saved import', async () => {
    const h = harness(); await h.session.openImported(imported); await h.session.save(() => markdown);
    expect(h.state.importedAssetsDir).toBe(saved.assetsDir);
    await h.session.newDocument(); expect(h.state.importedAssetsDir).toBeNull(); expect(h.state.pendingAssets).toEqual([]);
  });
});

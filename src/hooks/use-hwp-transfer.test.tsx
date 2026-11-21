// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileBridge } from '@/data/tauri-bridge';
import { IMPORT_ASSET_PREFIX } from '@/domain/hwp-assets';
import type { TransferOptions } from '@/lib/hwp/worker-client';
import { parseHwp } from '@/lib/hwp/parse';
import { buildHwpx, xp, xpic, xtable } from '@/lib/hwp/parse/testing/builders';
import { useOpenFile } from './use-open-file';

const workers = vi.hoisted(() => ({ parse: vi.fn(), generate: vi.fn(), dispose: vi.fn() }));
vi.mock('@/lib/hwp/worker-client', () => ({ createHwpWorkerClient: () => workers }));
vi.mock('@/data/tauri-bridge', () => ({
  localImageUrl: (path: string) => `asset://localhost${path}`,
  fileBridge: {
    available: () => true,
    onOpened: vi.fn(), onChanged: vi.fn(), onCloseBlocked: vi.fn(), onFilesDropped: vi.fn(),
    takePending: vi.fn(), read: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), e2eConfig: vi.fn(),
    setDocumentDirty: vi.fn(), readHwpBytes: vi.fn(), readDocumentImage: vi.fn(), pickHwp: vi.fn(), saveHwpxAs: vi.fn(),
    saveDocxAs: vi.fn(),
    writeMarkdown: vi.fn(), saveMarkdownAs: vi.fn(), confirmClose: vi.fn(),
  },
}));
vi.mock('@/lib/markdown', async original => {
  const real = await original<typeof import('@/lib/markdown')>();
  return { ...real, markdownToHtmlAsync: async (source: string) => real.markdownToHtml(source) };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const sourceFile = { path: '/tmp/문서/a.md', content: '# 원래 문서\n', hash: 'original', mtimeMs: 0 };
const asset = { name: 'img-001.png', mimeType: 'image/png', bytes: Uint8Array.of(137, 80, 78, 71) };
const parsed = { markdown: `# 한글 제목\n\n![사진](${IMPORT_ASSET_PREFIX}${asset.name})`, warnings: [{ code: 'footnote-skipped', count: 1 }], assets: [asset],
  stats: { headings: 1, paragraphs: 0, tables: 0, images: 1, imageReferences: 1, imageMappings: 1, skippedImages: 0 } };

describe('HWP transfer ViewModel integration', () => {
  let root: Root; let host: HTMLDivElement; let reader: ReturnType<typeof useOpenFile>;
  function Harness() { reader = useOpenFile(); return null; }
  const mount = async () => { await act(async () => root.render(<Harness />)); };
  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pending-image'), revokeObjectURL: vi.fn() });
    for (const key of ['onOpened', 'onChanged', 'onCloseBlocked', 'onFilesDropped'] as const) vi.mocked(fileBridge[key]).mockResolvedValue(() => {});
    vi.mocked(fileBridge.takePending).mockResolvedValue([sourceFile.path]);
    vi.mocked(fileBridge.read).mockResolvedValue(sourceFile);
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue(null);
    vi.mocked(fileBridge.watch).mockResolvedValue(); vi.mocked(fileBridge.unwatch).mockResolvedValue();
    vi.mocked(fileBridge.setDocumentDirty).mockResolvedValue();
    vi.mocked(fileBridge.pickHwp).mockResolvedValue('/tmp/보고서.hwpx');
    vi.mocked(fileBridge.readHwpBytes).mockResolvedValue(Uint8Array.of(80, 75));
    vi.mocked(fileBridge.readDocumentImage).mockResolvedValue(asset.bytes);
    vi.mocked(fileBridge.saveHwpxAs).mockResolvedValue({ path: '/tmp/내보냄.hwpx' });
    workers.parse.mockResolvedValue(parsed); workers.generate.mockResolvedValue({ bytes: Uint8Array.of(80, 75), warnings: [] });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('selects a native HWPX file, reports progress/warnings and opens a dirty untitled document', async () => {
    let complete!: (value: typeof parsed) => void;
    workers.parse.mockImplementation((_bytes, _format, options: TransferOptions) => {
      options.onProgress?.(47, '표 변환 중'); return new Promise(resolve => { complete = resolve; });
    });
    await mount(); let pending!: Promise<void> | undefined;
    await act(async () => { pending = reader.importDocument(); });
    expect(reader.importStatus).toBe('importing'); expect(reader.importProgress).toBe(47); expect(reader.importMessage).toBe('표 변환 중');
    await act(async () => { complete(parsed); await pending; });
    expect(fileBridge.readHwpBytes).toHaveBeenCalledExactlyOnceWith('/tmp/보고서.hwpx');
    expect(workers.parse).toHaveBeenCalledWith(Uint8Array.of(80, 75), 'hwpx', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(reader).toMatchObject({ untitled: true, dirty: true, title: '제목 없음', importStatus: 'done', pendingAssets: [asset], importWarningsOpen: true });
    expect(reader.file?.path).toBe('');
    await act(async () => reader.dismissImportWarnings()); expect(reader.importWarningsOpen).toBe(false);
    await act(async () => reader.showImportWarnings()); expect(reader.importWarningsOpen).toBe(true);
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled(); expect(fileBridge.saveMarkdownAs).not.toHaveBeenCalled();
  });
  it('routes native drops to HWP import or the existing Markdown opener and explains unsupported files', async () => {
    await mount(); const drop = vi.mocked(fileBridge.onFilesDropped).mock.calls[0][0];
    await act(async () => { drop({ paths: ['/tmp/그림.png'] }); }); expect(reader.dropNotice).toContain('문서를 선택');
    await act(async () => { drop({ paths: ['/tmp/첫.hwp', '/tmp/둘.hwpx'] }); });
    expect(fileBridge.readHwpBytes).toHaveBeenLastCalledWith('/tmp/첫.hwp'); expect(reader.dropNotice).toContain('한 번에 하나');
    await act(async () => { drop({ paths: ['/tmp/다음.md'] }); }); expect(reader.closeBlocked).toBe(true);
    await act(async () => { await reader.confirmClose(false); });
    expect(fileBridge.read).toHaveBeenLastCalledWith('/tmp/다음.md');
  });
  it('shows parser failures without replacing or writing the original document', async () => {
    workers.parse.mockRejectedValue(Error('암호화 문서를 가져올 수 없습니다.'));
    await mount(); await act(async () => { await reader.importDocument(); });
    expect(reader.error).toContain('암호화'); expect(reader.importStatus).toBe('error'); expect(reader.file).toEqual(sourceFile);
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
  });
  it('keeps actual HWPX captions, placeholders and distinct loss warnings in the untitled editor', async () => {
    const caption = (text: string) => `<hp:caption><hp:subList>${xp(text)}</hp:subList></hp:caption>`;
    const body = xp('검증 제목', 'styleIDRef="1"')
      + `<hp:p><hp:run>${xtable().replace('<hp:tr>', caption('표 설명') + '<hp:tr>')}</hp:run></hp:p>`
      + xpic().replace('</hp:pic>', caption('그림 설명') + '</hp:pic>')
      + '<hp:p><hp:run><hp:ctrl><hp:fieldBegin id="1" type="HYPERLINK"><hp:parameters><hp:stringParam name="Command">https://example.invalid/private-target</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>링크 표시 글</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl></hp:run></hp:p>';
    const bytes = await buildHwpx({ body }); const original = bytes.slice();
    vi.mocked(fileBridge.readHwpBytes).mockResolvedValue(bytes);
    workers.parse.mockImplementation((input, format, options: TransferOptions) => parseHwp(input, options.onProgress, format));
    await mount(); await act(async () => { await reader.importDocument(); });
    expect(reader).toMatchObject({ untitled: true, dirty: true, importStatus: 'done', importWarningsOpen: true,
      file: { path: '', hash: '' }, importResult: { done: true, kind: 'hwpx', assetCount: 1 } });
    expect(reader.importWarnings).toEqual([
      { code: 'object-skipped', count: 2, detail: 'caption-layout' },
      { code: 'object-skipped', count: 1, detail: 'field-metadata' },
    ]);
    const preview = new DOMParser().parseFromString(reader.html, 'text/html');
    for (const text of ['검증 제목', '표 설명', '그림 설명', '링크 표시 글',
      '[캡션 배치 제외: 텍스트만 가져옴]', '[필드 정보 제외: 표시 글만 가져옴]']) {
      expect(preview.body.textContent).toContain(text);
    }
    expect(preview.querySelectorAll('table')).toHaveLength(1);
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('blob:pending-image');
    expect(reader.file?.content).not.toContain('private-target');
    expect(bytes).toEqual(original);
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
    expect(fileBridge.saveMarkdownAs).not.toHaveBeenCalled();
    expect(fileBridge.saveHwpxAs).not.toHaveBeenCalled();
  });
  it('native picker cancellation leaves the document unchanged', async () => {
    vi.mocked(fileBridge.pickHwp).mockResolvedValue(null); await mount();
    await act(async () => { await reader.importDocument(); }); expect(workers.parse).not.toHaveBeenCalled(); expect(reader.file).toEqual(sourceFile);
  });
  it('renders pending pictures via blob URLs while preserving mdSrc in block and source previews', async () => {
    await mount(); await act(async () => { await reader.importDocument(); });
    const html = new DOMParser().parseFromString(reader.html, 'text/html'); const image = html.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('blob:pending-image'); expect(image.getAttribute('data-md-src')).toBe(IMPORT_ASSET_PREFIX + asset.name);
    const preview = await reader.renderFile({ ...reader.file!, content: `${parsed.markdown}\n\n수정` });
    expect(preview).toContain('blob:pending-image'); expect(URL.createObjectURL).toHaveBeenCalledOnce();
    await act(async () => { await reader.confirmClose(false); });
    await act(async () => { await reader.newDocument(); });
    await act(async () => { await reader.confirmClose(false); });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pending-image');
  });
  it('exports the exact current draft, resolves local images through Rust and preserves document state', async () => {
    const warnings = [{ code: 'inline-format-simplified', count: 1 }];
    workers.generate.mockImplementation(async (markdown, resolve, options: TransferOptions) => {
      expect(markdown).toBe('변경 내용'); options.onProgress?.(64, '패키징 중');
      expect(await resolve('./그림%20사진.png')).toEqual({ bytes: asset.bytes });
      return { bytes: Uint8Array.of(80, 75), warnings };
    });
    await mount(); await act(async () => { reader.setContentGetter(() => '변경 내용'); reader.markDirty(); await reader.exportDocument(); });
    expect(fileBridge.readDocumentImage).toHaveBeenCalledWith(sourceFile.path, './그림 사진.png');
    expect(fileBridge.saveHwpxAs).toHaveBeenCalledWith(Uint8Array.of(80, 75), 'a.hwpx');
    expect(reader).toMatchObject({ dirty: true, file: sourceFile, exportProgress: 64, exportWarnings: warnings, exportWarningsOpen: true,
      exportResult: { done: true, path: '/tmp/내보냄.hwpx' } });
    expect(fileBridge.writeMarkdown).not.toHaveBeenCalled();
  });
  it('exports pending import pictures from memory and refuses remote/absolute reads in the resolver', async () => {
    workers.generate.mockImplementation(async (_markdown, resolve) => {
      expect(await resolve(IMPORT_ASSET_PREFIX + asset.name)).toEqual({ bytes: asset.bytes, mimeType: asset.mimeType });
      expect(await resolve('https://example.invalid/a.png')).toBeNull(); expect(await resolve('/private/a.png')).toBeNull();
      return { bytes: Uint8Array.of(80, 75), warnings: [] };
    });
    await mount(); await act(async () => { await reader.importDocument(); });
    await act(async () => { await reader.exportDocument(); });
    expect(fileBridge.readDocumentImage).not.toHaveBeenCalled(); expect(reader.dirty).toBe(true); expect(reader.untitled).toBe(true);
    expect(reader.pendingAssets[0].bytes.byteLength).toBe(4); expect(fileBridge.saveHwpxAs).toHaveBeenCalledWith(expect.any(Uint8Array), '보고서.hwpx');
  });
  it('native export panel cancellation is not reported as a completed export', async () => {
    vi.mocked(fileBridge.saveHwpxAs).mockResolvedValue(null); await mount();
    await act(async () => { await reader.exportDocument(); }); expect(reader.exportStatus).toBe('idle'); expect(reader.exportResult).toBeNull();
  });
  it('reports export errors and cancels an active generation before saving', async () => {
    workers.generate.mockRejectedValueOnce(Error('변환 모듈을 시작하지 못했습니다.')); await mount();
    await act(async () => { await reader.exportDocument(); }); expect(reader.transferError).toContain('변환 모듈'); expect(reader.exportStatus).toBe('error');
    workers.generate.mockImplementation((_md, _resolve, options: TransferOptions) => new Promise((_done, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')));
    }));
    let pending!: Promise<void>; await act(async () => { pending = reader.exportDocument(); });
    await act(async () => { reader.cancelExport(); await pending; });
    expect(reader.exportStatus).toBe('idle'); expect(fileBridge.saveHwpxAs).not.toHaveBeenCalled();
  });
  it('releases native drop subscriptions, workers and memory images on unmount', async () => {
    const release = vi.fn(); vi.mocked(fileBridge.onFilesDropped).mockResolvedValue(release);
    await mount(); await act(async () => { await reader.importDocument(); });
    await act(async () => root.unmount());
    expect(release).toHaveBeenCalledOnce(); expect(workers.dispose).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pending-image');
  });
  it('runs E2E import/export only when Rust supplies their environment configuration', async () => {
    vi.mocked(fileBridge.e2eConfig).mockResolvedValue({ statePath: '/tmp/state.json', query: '', importPath: '/tmp/e2e.hwp', exportPath: '/tmp/e2e.hwpx' });
    await mount(); expect(fileBridge.readHwpBytes).toHaveBeenCalledExactlyOnceWith('/tmp/e2e.hwp');
    expect(reader.importResult).toMatchObject({ done: true, kind: 'hwp', untitled: true, dirty: true, assetCount: 1 });
    expect(fileBridge.saveHwpxAs).toHaveBeenCalledOnce(); expect(fileBridge.read).not.toHaveBeenCalled();
  });
  it('[md-word] does not start while HWPX generation is active', async () => {
    workers.generate.mockImplementation((_md, _resolve, options: TransferOptions) => new Promise((_done, reject) => options.signal?.addEventListener('abort', () => reject(Error('cancel')))));
    await mount(); let pending!: Promise<void>; await act(async () => { pending = reader.exportDocument(); });
    await act(async () => { await reader.exportMarkdownWord(); });
    expect(fileBridge.saveDocxAs).not.toHaveBeenCalled(); await act(async () => { reader.cancelExport(); await pending; });
  });

  it('[md-word] saves current editor content with a docx name', async () => {
    vi.mocked(fileBridge.saveDocxAs).mockResolvedValue({ path: '/tmp/a.docx' }); await mount();
    await act(async () => reader.setContentGetter(() => '# 편집 중 내용'));
    await act(async () => { await reader.exportMarkdownWord(); });
    const [bytes, name] = vi.mocked(fileBridge.saveDocxAs).mock.calls[0];
    const zip = await (await import('jszip')).default.loadAsync(bytes);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('편집 중 내용'); expect(name).toBe('a.docx');
    expect(reader.wordStatus).toBe('done'); expect(reader.wordMessage).toContain('현재 편집 내용 기준');
  });
  it('[md-word] resolves local images and leaves remote images alone', async () => {
    vi.mocked(fileBridge.saveDocxAs).mockResolvedValue({ path: '/tmp/a.docx' }); await mount();
    await act(async () => reader.setContentGetter(() => '![a](image%20one.png) ![b](https://example.com/a.png)'));
    await act(async () => { await reader.exportMarkdownWord(); });
    expect(fileBridge.readDocumentImage).toHaveBeenCalledExactlyOnceWith(sourceFile.path, 'image one.png');
    expect(reader.wordMessage).toContain('원격 그림 1개는 링크로');
  });
  it('[md-word] clears status when save is cancelled', async () => {
    vi.mocked(fileBridge.saveDocxAs).mockResolvedValue(null); await mount(); await act(async () => { await reader.exportMarkdownWord(); });
    expect(reader.wordStatus).toBe('idle'); expect(reader.wordMessage).toBe(''); expect(reader.transferError).toBeNull();
  });
  it('[md-word] reports saving failure', async () => {
    vi.mocked(fileBridge.saveDocxAs).mockRejectedValue(Error('save failed')); await mount(); await act(async () => { await reader.exportMarkdownWord(); });
    expect(reader.wordStatus).toBe('error'); expect(reader.transferError).toContain('save failed');
  });
  it('[md-word] does not start twice while saving', async () => {
    let finish!: (value: null) => void; vi.mocked(fileBridge.saveDocxAs).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mount(); let pending!: Promise<void>; await act(async () => { pending = reader.exportMarkdownWord(); });
    await act(async () => { await reader.exportMarkdownWord(); });
    await act(async () => { await vi.waitFor(() => expect(fileBridge.saveDocxAs).toHaveBeenCalledOnce()); });
    await act(async () => { finish(null); await pending; });
  });
  it('[md-word] names a new document and does not resolve its relative images', async () => {
    vi.mocked(fileBridge.saveDocxAs).mockResolvedValue({ path: '/tmp/new.docx' }); await mount();
    await act(async () => reader.newDocument()); await act(async () => reader.setContentGetter(() => '![a](x.png)'));
    await act(async () => { await reader.exportMarkdownWord(); });
    expect(fileBridge.saveDocxAs).toHaveBeenCalledWith(expect.any(Uint8Array), '제목 없음.docx'); expect(fileBridge.readDocumentImage).not.toHaveBeenCalled();
  });

});

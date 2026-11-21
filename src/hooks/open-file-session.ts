import { importedAssetPrefix, type E2eConfig, type FileBridge, type HwpFileBridge, type MarkdownFile } from '@/data/tauri-bridge';
import { detectUnsupportedSyntax, type UnsupportedKind } from '@/domain/unsupported-syntax';
import { detectEnvelope, type DocumentEnvelope } from '@/domain/document-envelope';
import { rebaseRelativeImages } from '@/domain/image-src';

import { IMPORT_ASSET_PREFIX, type ImportAsset } from '@/domain/hwp-assets';
import type { ImportWarning } from '@/domain/hwp-warnings';
import type { OriginalDocument } from '@/domain/original-view';
import type { HwpImporter } from '@/lib/hwp/worker-client';
import type { HwpFormat, ImportReport } from '@/types/hwp';

export interface ImportedDocument {
  markdown: string; suggestedName: string; assets: ImportAsset[];
  warnings: ImportWarning[]; source: HwpFormat;
  original?: OriginalDocument;
}
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
export interface OpenFileState {
  file: MarkdownFile | null;
  html: string;
  isLoading: boolean;
  error: string | null;
  loadCount: number;
  revision: number;
  preserveScroll: boolean;
  e2e: E2eConfig | null;
  dirty: boolean;
  saveStatus: SaveStatus;
  externalPending: boolean;
  closeBlocked: boolean;
  untitled: boolean;
  unsupported: UnsupportedKind[];
  envelope: DocumentEnvelope;
  suggestedName: string;
  pendingAssets: ImportAsset[];
  importedAssetsDir: string | null;
  importWarnings: ImportWarning[];
  importStatus: 'idle' | 'importing' | 'done' | 'error';
  importProgress: number;
  importMessage: string;
  importResult: ImportReport | null;
  original: OriginalDocument | null;
}

export const emptyFileState: OpenFileState = {
  file: null, html: '', isLoading: false, error: null, loadCount: 0,
  revision: 0, preserveScroll: false, e2e: null,
  dirty: false, saveStatus: 'idle', externalPending: false, closeBlocked: false,
  untitled: false, unsupported: [], envelope: detectEnvelope(''),
  suggestedName: '제목 없음.md', pendingAssets: [], importedAssetsDir: null, importWarnings: [],
  importStatus: 'idle', importProgress: 0, importMessage: '', importResult: null,
  original: null,
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const directory = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** Serialized file lifecycle. The content getter returns exact source, or enveloped rich Markdown. */
export function createOpenFileSession(
  bridge: FileBridge & Partial<HwpFileBridge>,
  render: (file: MarkdownFile, assets?: ImportAsset[]) => Promise<string>,
  changed: (state: OpenFileState) => void,
  importer?: HwpImporter,
) {
  let state = { ...emptyFileState };
  let disposed = false;
  let generation = 0;
  let importController: AbortController | null = null;
  const cancelActiveImport = () => { importController?.abort(); importController = null; };
  let editVersion = 0;
  let externalVersion = 0;
  let requestedPath: string | null = null;
  let contentDirectory: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  let dirtyQueue: Promise<void> = Promise.resolve();
  let pendingAction: (() => Promise<void>) | null = null;
  let contentGetter: (() => string) | null = null;
  const listeners: (() => void)[] = [];
  const update = (patch: Partial<OpenFileState>) => {
    state = { ...state, ...patch };
    if (!disposed) changed(state);
  };
  const notifyDirty = (dirty: boolean) => {
    dirtyQueue = dirtyQueue.then(async () => {
      if (!disposed && bridge.available()) await bridge.setDocumentDirty(dirty);
    }).catch((error: unknown) => { if (!disposed) update({ error: message(error) }); });
    return dirtyQueue;
  };
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      if (!disposed) update({ error: message(error), isLoading: false });
    });
    return queue;
  };
  const reset = (patch: Partial<OpenFileState>) => {
    editVersion++;
    pendingAction = null;
    update({ ...emptyFileState, loadCount: state.loadCount, revision: state.revision + 1, e2e: state.e2e, ...patch });
    void notifyDirty(patch.dirty ?? false);
  };
  const blockReplacement = (action: () => Promise<void>) => {
    pendingAction = action;
    update({ closeBlocked: true });
    return queue;
  };

  const open = (path: string, reload = false, discard = false): Promise<void> => {
    if (disposed || (!reload && requestedPath === path)) return queue;
    if (state.dirty && !discard) return blockReplacement(() => open(path, reload, true));
    cancelActiveImport();
    requestedPath = path;
    const id = ++generation;
    const version = editVersion;
    update({ isLoading: true, error: null, importStatus: 'idle', importProgress: 0 });
    return enqueue(async () => {
      if (disposed || id !== generation) return;
      try {
        const file = await bridge.read(path);
        if (disposed || id !== generation) return;
        const html = await render(file);
        if (disposed || id !== generation) return;
        // An automatic refresh may have started just before the first keystroke.
        if (!discard && version !== editVersion) {
          requestedPath = state.file?.path || null;
          update({ isLoading: false, externalPending: true });
          return;
        }
        requestedPath = file.path;
        contentDirectory = directory(file.path);
        reset({ file, html, loadCount: state.loadCount + 1, preserveScroll: reload,
          unsupported: detectUnsupportedSyntax(file.content), envelope: detectEnvelope(file.content) });
        await bridge.watch(file.path);
      } catch (error) {
        if (!disposed && id === generation) {
          requestedPath = null;
          update({ isLoading: false, error: message(error) });
        }
      }
    });
  };

  const save = (getContent?: () => string, as = false): Promise<void> => {
    if (getContent) contentGetter = getContent;
    const id = generation;
    return enqueue(async () => {
      if (disposed || id !== generation || !state.file) return;
      // Do not even serialize unchanged documents. This guarantees byte-identical no-op saves.
      if (!as && !state.untitled && !state.dirty) return;
      const version = editVersion;
      const externalAtStart = externalVersion;
      const before = state.file;
      const previousStatus = state.saveStatus;
      const wasUntitled = state.untitled;
      update({ saveStatus: 'saving', error: null });
      try {
        const raw = !state.dirty ? before.content : (getContent || contentGetter || (() => before.content))();
        const origin = contentDirectory;
        const mapped = state.importedAssetsDir ? raw.split(IMPORT_ASSET_PREFIX).join(importedAssetPrefix(state.importedAssetsDir)) : raw;
        let content = origin && !wasUntitled ? rebaseRelativeImages(mapped, origin, directory(before.path)) : mapped;
        const importAssets = state.pendingAssets;
        const savingAssets = importAssets.length > 0;
        if (savingAssets && !bridge.saveImportedMarkdownAs) throw new Error('가져온 이미지 저장 모듈을 사용할 수 없습니다.');
        const savedImport = savingAssets
          ? await bridge.saveImportedMarkdownAs!(content, state.suggestedName, importAssets) : null;
        let result = savingAssets ? savedImport : as || wasUntitled
          ? await bridge.saveMarkdownAs(content, before.path.split('/').at(-1) || state.suggestedName, wasUntitled ? null : before.path)
          : await bridge.writeMarkdown(before.path, content, before.hash);
        if (savedImport) content = content.split(IMPORT_ASSET_PREFIX).join(importedAssetPrefix(savedImport.assetsDir));
        if (!result) { if (!disposed && id === generation) update({ saveStatus: previousStatus }); return; }
        // The native panel returns its destination only after writing. Use the returned
        // hash for the path adjustment too, so an intervening external edit is never overwritten.
        if ((as || wasUntitled) && !wasUntitled) {
          const rebased = rebaseRelativeImages(content, directory(before.path), directory(result.path));
          if (rebased !== content) {
            result = await bridge.writeMarkdown(result.path, rebased, result.hash);
            content = rebased;
          }
        }
        if (disposed || id !== generation) return;
        let file: MarkdownFile = { path: result.path, hash: result.hash, mtimeMs: result.mtimeMs, content };
        // Edits made while the first asset save was in flight must survive the
        // path rewrite. Refresh the current draft using the saved asset folder.
        let renderedVersion = version;
        const currentImportedDraft = () => {
          renderedVersion = editVersion;
          const latest = (getContent || contentGetter || (() => content))();
          return latest.split(IMPORT_ASSET_PREFIX).join(importedAssetPrefix(savedImport!.assetsDir));
        };
        if (savedImport && version !== editVersion) file = { ...file, content: currentImportedDraft() };
        const moved = as || wasUntitled || content !== raw;
        let html = moved ? await render(file) : state.html;
        while (savedImport && renderedVersion !== editVersion && !disposed && id === generation) {
          file = { ...file, content: currentImportedDraft() };
          html = await render(file, []);
        }
        if (disposed || id !== generation) return;
        const stillDirty = version !== editVersion;
        requestedPath = file.path;
        if (!stillDirty || savedImport) contentDirectory = directory(file.path);
        update({ file, untitled: false, dirty: stillDirty, saveStatus: stillDirty ? 'idle' : 'saved', externalPending: externalVersion !== externalAtStart,
          envelope: detectEnvelope(file.content), unsupported: detectUnsupportedSyntax(file.content),
          ...(savedImport ? { pendingAssets: [], importedAssetsDir: savedImport.assetsDir } : {}),
          ...((!stillDirty || savedImport) && moved ? { html, revision: state.revision + 1, preserveScroll: true } : {}) });
        await notifyDirty(stillDirty);
        if (as || wasUntitled) await bridge.watch(file.path);
      } catch (error) {
        if (!disposed && id === generation) update({ saveStatus: message(error).startsWith('conflict:') ? 'conflict' : 'error',
          externalPending: state.externalPending || message(error).startsWith('conflict:'), error: message(error) });
      }
    });
  };

  const close = (discard = false): Promise<void> => {
    if (disposed) return queue;
    if (state.dirty && !discard) return blockReplacement(() => close(true));
    cancelActiveImport();
    ++generation;
    requestedPath = null;
    contentDirectory = null;
    reset({});
    return enqueue(() => bridge.available() ? bridge.unwatch() : Promise.resolve());
  };
  const newDocument = (discard = false): Promise<void> => {
    if (disposed) return queue;
    if (state.dirty && !discard) return blockReplacement(() => newDocument(true));
    cancelActiveImport();
    ++generation;
    requestedPath = null;
    contentDirectory = null;
    reset({ file: { path: '', content: '', hash: '', mtimeMs: 0 }, untitled: true });
    return enqueue(() => bridge.available() ? bridge.unwatch() : Promise.resolve());
  };

  const commitImported = async (document: ImportedDocument, id: number) => {
    if (disposed || id !== generation) return;
    const version = editVersion;
    const file: MarkdownFile = { path: '', content: document.markdown, hash: '', mtimeMs: 0 };
    const html = await render(file, document.assets);
    if (disposed || id !== generation) return;
    if (version !== editVersion) throw new Error('가져오는 동안 문서가 편집되어 교체하지 않았습니다. 다시 가져와 주세요.');
    if (bridge.available()) await bridge.unwatch();
    if (disposed || id !== generation) return;
    if (version !== editVersion) throw new Error('가져오는 동안 문서가 편집되어 교체하지 않았습니다. 다시 가져와 주세요.');
    requestedPath = null;
    contentDirectory = null;
    reset({ file, html, untitled: true, dirty: true, suggestedName: document.suggestedName,
      pendingAssets: document.assets, importWarnings: document.warnings,
      original: document.original ?? null,
      importStatus: 'done', importProgress: 100, importMessage: '한글 문서 가져오기 완료',
      importResult: { done: true, kind: document.source, untitled: true, dirty: true,
        markdownLength: document.markdown.length, warningCodes: document.warnings.map(w => w.code), assetCount: document.assets.length },
      loadCount: state.loadCount + 1, unsupported: detectUnsupportedSyntax(document.markdown), envelope: detectEnvelope(document.markdown) });
  };
  const openImported = (document: ImportedDocument, discard = false): Promise<void> => {
    if (disposed) return queue;
    if (state.dirty && !discard) return blockReplacement(() => openImported(document, true));
    cancelActiveImport();
    const id = ++generation;
    return enqueue(() => commitImported(document, id));
  };
  const importHwp = (path: string, discard = false): Promise<void> => {
    if (disposed) return queue;
    if (state.dirty && !discard) return blockReplacement(() => importHwp(path, true));
    cancelActiveImport();
    requestedPath = null;
    const controller = new AbortController();
    importController = controller;
    const id = ++generation;
    const version = editVersion;
    update({ importStatus: 'importing', importProgress: 0, importMessage: '한글 파일 읽는 중', isLoading: true, error: null });
    return enqueue(async () => {
      if (disposed || id !== generation) return;
      try {
        if (!bridge.available() || !bridge.readHwpBytes || !importer) throw new Error('한글 가져오기는 MDViewer 앱에서 사용할 수 있습니다.');
        const format = path.toLowerCase().endsWith('.hwpx') ? 'hwpx' : 'hwp';
        const bytes = await bridge.readHwpBytes(path);
        if (disposed || id !== generation) return;
        // Keep the import snapshot independent of a parser that mutates or transfers its input.
        const original: OriginalDocument = { bytes: bytes.slice(), kind: format };
        const result = await importer.parse(bytes, format, { signal: controller.signal,
          onProgress: (importProgress, importMessage) => {
            if (!disposed && id === generation) update({ importProgress, importMessage });
          } });
        if (disposed || id !== generation) return;
        if (version !== editVersion) throw new Error('가져오는 동안 문서가 편집되어 교체하지 않았습니다. 다시 가져와 주세요.');
        await commitImported({ ...result, suggestedName: path.split('/').at(-1)!.replace(/\.hwpx?$/i, '.md'), source: format,
          original }, id);
      } catch (error) {
        if (!disposed && id === generation) update({ importStatus: 'error', isLoading: false, error: message(error) });
      } finally { if (importController === controller) importController = null; }
    });
  };
  const openPath = (path: string) => /\.hwpx?$/i.test(path) ? importHwp(path) : open(path);

  return {
    open, openPath, close, newDocument, openImported, importHwp,
    cancelImport() {
      if (!importController) return;
      cancelActiveImport(); ++generation;
      update({ importStatus: 'idle', isLoading: false, importProgress: 0, importMessage: '' });
    },
    async pickHwp() {
      try {
        if (!bridge.available() || !bridge.pickHwp) throw new Error('한글 가져오기는 MDViewer 앱에서 사용할 수 있습니다.');
        const path = await bridge.pickHwp();
        if (path && !disposed) await importHwp(path);
      } catch (error) { if (!disposed) update({ error: message(error), importStatus: 'error' }); }
    },
    save: (getContent?: () => string) => save(getContent),
    saveAs: (getContent?: () => string) => save(getContent, true),
    setContentGetter(getContent: () => string) { contentGetter = getContent; },
    markDirty() {
      if (disposed || !state.file) return;
      editVersion++;
      const first = !state.dirty;
      update({ dirty: true, saveStatus: state.saveStatus === 'saving' ? 'saving' : 'idle' });
      if (first) void notifyDirty(true);
    },
    reloadFromDisk() { return state.file?.path ? open(state.file.path, true, true) : queue; },
    cancelClose() { pendingAction = null; update({ closeBlocked: false }); },
    async confirmClose(shouldSave: boolean, getContent?: () => string) {
      const id = generation;
      const action = pendingAction;
      if (shouldSave) {
        await save(getContent);
        if (disposed || id !== generation || state.dirty || state.saveStatus === 'error' || state.saveStatus === 'conflict' || state.untitled) return;
      }
      pendingAction = null;
      update({ closeBlocked: false });
      if (action) await action();
      else if (bridge.available()) await bridge.confirmClose();
    },
    async start() {
      if (!bridge.available()) return;
      const startupGeneration = generation;
      try {
        for (const subscribe of [
          () => bridge.onOpened(({ path }) => { void openPath(path); }),
          () => bridge.onChanged((event) => {
            if (event.source !== 'external' || event.path !== (requestedPath ?? state.file?.path) || event.hash === state.file?.hash) return;
            externalVersion++;
            if (state.dirty || state.saveStatus === 'saving' || state.importStatus === 'importing') update({ externalPending: true });
            else void open(event.path, true);
          }),
          () => bridge.onCloseBlocked(() => { pendingAction = null; update({ closeBlocked: true }); }),
        ]) {
          const unlisten = await subscribe();
          if (disposed) { unlisten(); return; }
          listeners.push(unlisten);
        }
        const e2e = await bridge.e2eConfig();
        if (disposed) return;
        update({ e2e });
        const pending = await bridge.takePending();
        if (!disposed && generation === startupGeneration && !requestedPath && !state.untitled) {
          if (e2e?.importPath) await importHwp(e2e.importPath);
          else if (pending[0]) await openPath(pending[0]);
        }
      } catch (error) { if (!disposed) update({ error: message(error) }); }
    },
    async pick() {
      try {
        if (!bridge.available()) throw new Error('파일 열기는 MDViewer 앱에서 사용할 수 있습니다.');
        const path = await bridge.pick();
        if (path && !disposed) await openPath(path);
      } catch (error) { if (!disposed) update({ error: message(error) }); }
    },
    e2eGateOpen: () => bridge.e2eGateOpen(),
    async stop() {
      disposed = true;
      cancelActiveImport();
      ++generation;
      for (const unlisten of listeners.splice(0)) unlisten();
      await enqueue(() => bridge.available() ? bridge.unwatch() : Promise.resolve());
    },
  };
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { fileBridge, importedAssetPrefix, localImageUrl, type MarkdownFile } from '@/data/tauri-bridge';
import { resolveImagePath } from '@/domain/resolve-image-path';
import { htmlToMarkdown, markdownToHtmlAsync } from '@/lib/markdown';
import { applyEnvelope } from '@/domain/document-envelope';
import { IMPORT_ASSET_PREFIX, type ImportAsset } from '@/domain/hwp-assets';
import { createHwpWorkerClient, type HwpWorkerClient } from '@/lib/hwp/worker-client';
import { useHwpTransfer } from './use-hwp-transfer';
import { createOpenFileSession, emptyFileState } from './open-file-session';

export async function renderMarkdownFile(file: MarkdownFile, importedUrls: ReadonlyMap<string, string> = new Map()) {
  const html = await markdownToHtmlAsync(file.content);
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const image of document.querySelectorAll('img')) {
    const original = image.getAttribute('data-md-src') ?? image.getAttribute('src') ?? '';
    image.setAttribute('data-md-src', original);
    const memoryUrl = importedUrls.get(original);
    const source = resolveImagePath(original, file.path);
    if (memoryUrl) image.setAttribute('src', memoryUrl);
    else if (!source) image.removeAttribute('src');
    else image.setAttribute('src', /^(https?:|data:)/i.test(source) ? source : localImageUrl(source));
    // Markdown content must not retain responsive candidates that bypass resolution.
    image.removeAttribute('srcset');
  }
  return document.body.innerHTML;
}

export function useOpenFile() {
  const [state, setState] = useState(emptyFileState);
  const [dismissedWarnings, setDismissedWarnings] = useState<typeof state.importWarnings | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const session = useRef<ReturnType<typeof createOpenFileSession> | null>(null);
  const stateRef = useRef(state);
  const workers = useRef<HwpWorkerClient | null>(null);
  const assetUrls = useRef(new Map<ImportAsset, string>());
  const renderFile = useCallback((file: MarkdownFile, assets = stateRef.current.pendingAssets) => {
    const urls = new Map<string, string>();
    for (const asset of assets) {
      let url = assetUrls.current.get(asset);
      if (!url) {
        url = URL.createObjectURL(new Blob([asset.bytes.slice().buffer], { type: asset.mimeType }));
        assetUrls.current.set(asset, url);
      }
      urls.set(IMPORT_ASSET_PREFIX + asset.name, url);
    }
    return renderMarkdownFile(file, urls);
  }, []);
  useEffect(() => {
    if (state.isLoading) return;
    for (const [asset, url] of assetUrls.current) {
      if (!state.pendingAssets.includes(asset)) { URL.revokeObjectURL(url); assetUrls.current.delete(asset); }
    }
  }, [state.pendingAssets, state.isLoading, state.importStatus]);
  const editorRef = useRef(editor);
  const contentGetter = useRef<(() => string) | null>(null);
  stateRef.current = state;
  editorRef.current = editor;

  const getContent = useCallback(() => {
    // Source/split UI registers the exact current textarea string with this getter.
    const current = stateRef.current;
    if (contentGetter.current) {
      const content = contentGetter.current();
      return current.importedAssetsDir ? content.split(IMPORT_ASSET_PREFIX).join(importedAssetPrefix(current.importedAssetsDir)) : content;
    }
    if (current.unsupported.length) throw new Error('소스 편집 내용이 연결되지 않았습니다.');
    if (!editorRef.current) return current.file?.content || '';
    const path = current.file?.path || '';
    return applyEnvelope(htmlToMarkdown(editorRef.current.getHTML(), path.slice(0, path.lastIndexOf('/'))), current.envelope);
  }, []);

  useEffect(() => {
    const client = createHwpWorkerClient();
    workers.current = client;
    const current = createOpenFileSession(fileBridge, (file, assets = []) => renderFile(file, assets), (next) => { stateRef.current = next; setState(next); }, client);
    current.setContentGetter(getContent);
    session.current = current;
    void current.start();
    return () => {
      session.current = null; workers.current = null; client.dispose(); void current.stop();
      for (const url of assetUrls.current.values()) URL.revokeObjectURL(url);
      assetUrls.current.clear();
    };
  }, [getContent, renderFile]);

  const pickHwp = useCallback(() => session.current?.pickHwp(), []);
  const importHwp = useCallback((path: string) => session.current?.importHwp(path), []);
  const openPath = useCallback((path: string) => session.current?.openPath(path), []);
  const cancelImport = useCallback(() => session.current?.cancelImport(), []);
  const transfer = useHwpTransfer({ file: state.file, untitled: state.untitled, suggestedName: state.suggestedName,
    pendingAssets: state.pendingAssets, e2e: state.e2e, importResult: state.importResult, getContent, pickHwp, openPath, workers });

  const pickFile = useCallback(() => { void session.current?.pick(); }, []);
  const closeFile = useCallback(() => { void session.current?.close(); }, []);
  const saveFile = useCallback(() => session.current?.save(getContent), [getContent]);
  const saveAs = useCallback(() => session.current?.saveAs(getContent), [getContent]);
  const newDocument = useCallback(() => session.current?.newDocument(), []);
  const markDirty = useCallback(() => session.current?.markDirty(), []);
  const reloadFromDisk = useCallback(() => session.current?.reloadFromDisk(), []);
  const confirmClose = useCallback((save: boolean) => session.current?.confirmClose(save, getContent), [getContent]);
  const cancelClose = useCallback(() => session.current?.cancelClose(), []);
  const setContentGetter = useCallback((getter: (() => string) | null) => { contentGetter.current = getter; }, []);
  const e2eGateOpen = useCallback(() => session.current?.e2eGateOpen() ?? Promise.resolve(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleFileShortcut(event, { pickFile, saveFile, saveAs, newDocument });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickFile, saveFile, saveAs, newDocument]);

  return { ...state, ...transfer,
    importWarningsOpen: state.importWarnings.length > 0 && dismissedWarnings !== state.importWarnings,
    dismissImportWarnings: () => setDismissedWarnings(state.importWarnings),
    showImportWarnings: () => setDismissedWarnings(null), pickHwp, importHwp, openPath, cancelImport, renderFile, getContent, editor, setEditor, pickFile, closeFile, saveFile, save: saveFile, saveAs,
    newDocument, markDirty, reloadFromDisk, confirmClose, cancelClose, setContentGetter, e2eGateOpen,
    title: state.untitled ? '제목 없음' : state.file?.path.split('/').at(-1) || '',
  };
}

export function handleFileShortcut(event: KeyboardEvent, actions: {
  pickFile: () => unknown; saveFile: () => unknown; saveAs: () => unknown; newDocument: () => unknown;
}) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const action = key === 's' ? (event.shiftKey ? actions.saveAs : actions.saveFile)
    : !event.shiftKey && key === 'o' ? actions.pickFile
    : !event.shiftKey && key === 'n' ? actions.newDocument : null;
  if (!action) return;
  event.preventDefault();
  if (!event.repeat) void action();
}

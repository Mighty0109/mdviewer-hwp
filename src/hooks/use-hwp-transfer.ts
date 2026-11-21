'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fileBridge, type E2eConfig, type HwpFileBridge, type MarkdownFile } from '@/data/tauri-bridge';
import { IMPORT_ASSET_PREFIX, type ImportAsset } from '@/domain/hwp-assets';
import type { HwpWorkerClient } from '@/lib/hwp/worker-client';
import type { ExportWarning } from '@/lib/hwp/generate';
import type { ExportReport, ImportReport } from '@/types/hwp';

export interface HwpTransferInput {
  file: MarkdownFile | null; untitled: boolean; suggestedName: string; pendingAssets: ImportAsset[];
  e2e: E2eConfig | null; importResult: ImportReport | null;
  getContent(): string;
  pickHwp(): unknown;
  openPath(path: string): unknown;
  workers: { current: HwpWorkerClient | null };
}

/** Transfer ViewModel. Filesystem commands and drop events stay outside views. */
export function useHwpTransfer(input: HwpTransferInput, bridge: HwpFileBridge = fileBridge) {
  const latest = useRef(input); latest.current = input;
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState('');
  const [exportWarnings, setExportWarnings] = useState<ExportWarning[]>([]);
  const [dismissedWarnings, setDismissedWarnings] = useState<ExportWarning[] | null>(null);
  const [exportResult, setExportResult] = useState<ExportReport | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const wordJob = useRef(false);
  const [wordStatus, setWordStatus] = useState<'idle' | 'converting' | 'done' | 'error'>('idle');
  const [wordMessage, setWordMessage] = useState('');
  const [wordOwner, setWordOwner] = useState<MarkdownFile | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let release: (() => void) | undefined;
    if (bridge.available() && bridge.onFilesDropped) {
      void bridge.onFilesDropped(({ paths }) => {
        if (disposed) return;
        const supported = paths.filter(path => /\.(?:md|markdown|hwp|hwpx)$/i.test(path));
        setDropNotice(!supported.length ? '마크다운(.md) 또는 한글(.hwp/.hwpx) 문서를 선택해 주세요.'
          : paths.length > 1 ? '문서는 한 번에 하나씩 엽니다. 첫 번째 지원 문서를 선택했습니다.' : null);
        if (supported[0]) void latest.current.openPath(supported[0]);
      }).then(unlisten => { if (disposed) unlisten(); else release = unlisten; })
        .catch(error => { if (!disposed) setTransferError(String(error)); });
    }
    return () => { disposed = true; mounted.current = false; release?.(); controller.current?.abort(); };
  }, [bridge]);

  const importDocument = useCallback(async () => { await latest.current.pickHwp(); }, []);
  const exportDocument = useCallback(async () => {
    const current = latest.current;
    if (!current.file || controller.current) return;
    const job = new AbortController(); controller.current = job;
    const active = () => mounted.current && !job.signal.aborted;
    setTransferError(null); setExportWarnings([]); setExportResult(null);
    setExportStatus('exporting'); setExportProgress(0); setExportMessage('HWPX 내보내기 준비 중');
    try {
      if (!bridge.available() || !current.workers.current) throw new Error('HWPX 내보내기는 MDViewer 앱에서 사용할 수 있습니다.');
      const markdown = current.getContent();
      const result = await current.workers.current.generate(markdown, async source => {
        if (job.signal.aborted) return null;
        if (source.startsWith(IMPORT_ASSET_PREFIX)) {
          const asset = current.pendingAssets.find(asset => IMPORT_ASSET_PREFIX + asset.name === source);
          return asset ? { bytes: asset.bytes, mimeType: asset.mimeType } : null;
        }
        // Remote/data sources are handled inside the worker; local reads are Rust-validated.
        if (current.untitled || !current.file?.path || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(source)) return null;
        let relative = source.split(/[?#]/, 1)[0];
        try { relative = decodeURIComponent(relative); } catch { /* literal percent filename */ }
        return { bytes: await bridge.readDocumentImage(current.file.path, relative) };
      }, { signal: job.signal, onProgress: (percent, message) => {
        if (active()) { setExportProgress(percent); setExportMessage(message); }
      } });
      if (!active()) return;
      setExportWarnings(result.warnings);
      setExportMessage('저장 위치 선택 중');
      const name = (current.file.path.split('/').at(-1) || current.suggestedName).replace(/\.md$/i, '') + '.hwpx';
      const saved = await bridge.saveHwpxAs(result.bytes, name);
      if (!active()) return;
      if (saved) { setExportResult({ done: true, path: saved.path }); setExportStatus('done'); }
      else setExportStatus('idle');
    } catch (error) {
      if (active()) { setTransferError(error instanceof Error ? error.message : String(error)); setExportStatus('error'); }
    } finally { if (controller.current === job) controller.current = null; }
  }, [bridge]);
  const cancelExport = useCallback(() => {
    controller.current?.abort(); controller.current = null; setExportStatus('idle');
  }, []);
  const exportMarkdownWord = useCallback(async () => {
    const current = latest.current;
    if (!current.file || wordJob.current || controller.current || !bridge.available()) return;
    wordJob.current = true;
    setWordOwner(current.file); setTransferError(null); setWordStatus('converting'); setWordMessage('Word로 변환 중…');
    try {
      const { generateDocx, summarizeDocxWarnings } = await import('@/lib/docx');
      const result = await generateDocx(current.getContent(), async source => {
        if (source.startsWith(IMPORT_ASSET_PREFIX)) {
          const asset = current.pendingAssets.find(asset => IMPORT_ASSET_PREFIX + asset.name === source);
          return asset ? { bytes: asset.bytes, mimeType: asset.mimeType } : null;
        }
        if (current.untitled || !current.file?.path || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(source)) return null;
        let relative = source.split(/[?#]/, 1)[0];
        try { relative = decodeURIComponent(relative); } catch { /* literal percent filename */ }
        return { bytes: await bridge.readDocumentImage(current.file.path, relative) };
      });
      if (!mounted.current || latest.current.file !== current.file) return;
      const name = (current.file.path.split('/').at(-1) || current.suggestedName).replace(/\.(?:md|markdown)$/i, '') + '.docx';
      const saved = await bridge.saveDocxAs(result.bytes, name);
      if (!mounted.current || latest.current.file !== current.file) return;
      if (saved) {
        const summary = summarizeDocxWarnings(result.warnings);
        setWordStatus('done'); setWordMessage(`Word 저장 완료: ${saved.path} · 현재 편집 내용 기준${summary ? ` · ${summary}` : ''}`);
      } else { setWordStatus('idle'); setWordMessage(''); }
    } catch (error) {
      if (mounted.current && latest.current.file === current.file) {
        setTransferError(error instanceof Error ? error.message : String(error)); setWordStatus('error'); setWordMessage('');
      }
    } finally {
      wordJob.current = false;
      if (mounted.current && latest.current.file !== current.file) { setWordStatus('idle'); setWordMessage(''); }
    }
  }, [bridge]);
  const exported = useRef<string | null>(null);
  useEffect(() => {
    const config = input.e2e;
    if (!config?.exportPath || !input.file || (config.importPath && !input.importResult?.done)
      || exported.current === config.exportPath) return;
    exported.current = config.exportPath;
    void exportDocument();
  }, [input.e2e, input.file, input.importResult, exportDocument]);

  return { importDocument, exportDocument, exportMarkdownWord, wordStatus: wordStatus === 'converting' || wordOwner === input.file ? wordStatus : 'idle' as const,
    wordMessage: wordStatus === 'converting' || wordOwner === input.file ? wordMessage : '', cancelExport, exportStatus, exportProgress, exportMessage,
    exportWarnings, exportResult, transferError, dropNotice,
    exportWarningsOpen: exportWarnings.length > 0 && dismissedWarnings !== exportWarnings,
    dismissExportWarnings: () => setDismissedWarnings(exportWarnings) };
}

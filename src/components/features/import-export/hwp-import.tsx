'use client';
import type { useOpenFile } from '@/hooks/use-open-file';
import { HwpProgress, HwpWarnings } from './hwp-warnings';

type Reader = ReturnType<typeof useOpenFile>;
export function HwpImport({ reader }: { reader: Pick<Reader, 'importStatus' | 'importProgress' | 'importMessage'
  | 'cancelImport' | 'showImportWarnings' | 'importWarnings' | 'importWarningsOpen' | 'dismissImportWarnings'> }) {
  return <>
    {reader.importStatus === 'importing' && <HwpProgress percent={reader.importProgress} message={reader.importMessage} onCancel={reader.cancelImport} />}
    {reader.importWarnings.length > 0 && <button className="border-b border-[var(--color-border)] px-4 py-2 text-left text-xs"
      onClick={reader.showImportWarnings}>가져오기 경고 {reader.importWarnings.reduce((n, w) => n + w.count, 0)}건</button>}
    <HwpWarnings title="한글 가져오기 경고" open={reader.importWarningsOpen} onClose={reader.dismissImportWarnings} warnings={reader.importWarnings} />
  </>;
}

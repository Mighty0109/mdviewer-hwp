'use client';
import type { useOpenFile } from '@/hooks/use-open-file';
import { HwpProgress, HwpWarnings } from './hwp-warnings';

type Reader = ReturnType<typeof useOpenFile>;
export function HwpExport({ reader }: { reader: Pick<Reader, 'exportStatus' | 'exportProgress' | 'exportMessage'
  | 'cancelExport' | 'exportWarnings' | 'exportWarningsOpen' | 'dismissExportWarnings' | 'exportResult'> & Partial<Pick<Reader, 'wordStatus' | 'wordMessage'>> }) {
  return <>
    {reader.exportStatus === 'exporting' && <HwpProgress percent={reader.exportProgress} message={reader.exportMessage} onCancel={reader.cancelExport} />}
    {reader.exportResult?.done && <p role="status" className="border-b border-[var(--color-border)] px-4 py-2 text-xs">HWPX 내보내기 완료: {reader.exportResult.path}</p>}
    {(reader.wordStatus === 'converting' || reader.wordStatus === 'done') && <p role="status" className="border-b border-[var(--color-border)] px-4 py-2 text-xs">{reader.wordMessage}</p>}
    <HwpWarnings title="HWPX 내보내기 경고" open={reader.exportWarningsOpen} onClose={reader.dismissExportWarnings} warnings={reader.exportWarnings} />
  </>;
}

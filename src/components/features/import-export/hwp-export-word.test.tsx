// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HwpExport } from './hwp-export';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const base = { exportStatus: 'idle' as const, exportProgress: 0, exportMessage: '', cancelExport: vi.fn(), exportWarnings: [], exportWarningsOpen: false, dismissExportWarnings: vi.fn(), exportResult: null };
async function render(reader: Parameters<typeof HwpExport>[0]['reader'], check: (host: HTMLDivElement) => void) {
  const host = document.createElement('div'); const root = createRoot(host);
  try { await act(async () => root.render(<HwpExport reader={reader} />)); check(host); } finally { await act(async () => root.unmount()); }
}
it('shows Word progress without a cancel button', async () => { await render({ ...base, wordStatus: 'converting', wordMessage: 'Word로 변환 중…' }, host => { expect(host.textContent).toContain('Word로 변환 중'); expect(host.textContent).not.toContain('변환 취소'); }); });
it('shows original document limitation on completion', async () => { await render({ ...base, wordStatus: 'done', wordMessage: '앱에서 수정한 내용은 반영되지 않음' }, host => expect(host.textContent).toContain('수정한 내용은 반영되지 않음')); });
it('keeps existing output when Word state is absent', async () => { await render(base, host => expect(host.querySelector('[role="status"]')).toBeNull()); });

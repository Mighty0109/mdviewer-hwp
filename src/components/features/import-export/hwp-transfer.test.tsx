// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { HwpImport } from './hwp-import';
import { HwpExport } from './hwp-export';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('HWP transfer feedback', () => {
  it('shows accessible conversion progress and provides cancellation', async () => {
    const host = document.createElement('div'); const root = createRoot(host); const cancel = vi.fn();
    try {
      await act(async () => root.render(<HwpImport reader={{ importStatus: 'importing', importProgress: 53, importMessage: '표 변환 중',
        cancelImport: cancel, importWarnings: [], importWarningsOpen: false, dismissImportWarnings: vi.fn(), showImportWarnings: vi.fn() }} />));
      expect(host.querySelector('progress')?.value).toBe(53); expect(host.querySelector('[role="status"]')?.textContent).toContain('표 변환 중');
      await act(async () => host.querySelector('button')?.click()); expect(cancel).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); }
  });
  it('displays each import loss with its count/detail and source-mode explanation, and can reopen warnings', async () => {
    const host = document.createElement('div'); const root = createRoot(host); const dismiss = vi.fn(); const show = vi.fn();
    try {
      await act(async () => root.render(<HwpImport reader={{ importStatus: 'done', importProgress: 100, importMessage: '', cancelImport: vi.fn(),
        importWarnings: [{ code: 'table-raw-html', count: 2 }, { code: 'image-skipped', count: 3, detail: 'format: emf' }],
        importWarningsOpen: true, dismissImportWarnings: dismiss, showImportWarnings: show }} />));
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('소스 모드');
      expect(host.querySelectorAll('[data-warning-code]')).toHaveLength(2);
      expect(host.textContent).toContain('(3건)'); expect(host.textContent).toContain('format: emf');
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '확인')?.click());
      expect(dismiss).toHaveBeenCalledOnce();
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('가져오기 경고 5건'))?.click());
      expect(show).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); }
  });
  it('shows export warnings even when the save panel is cancelled, without claiming a saved file', async () => {
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      await act(async () => root.render(<HwpExport reader={{ exportStatus: 'idle', exportProgress: 100, exportMessage: '', cancelExport: vi.fn(),
        exportWarnings: [{ code: 'image-remote', count: 1 }, { code: 'inline-format-simplified', count: 1 }],
        exportWarningsOpen: true, dismissExportWarnings: vi.fn(), exportResult: null }} />));
      expect(host.textContent).toContain('외부 네트워크 그림을 제외'); expect(host.textContent).toContain('문단 단위로 단순화');
      expect(host.textContent).not.toContain('내보내기 완료');
    } finally { await act(async () => root.unmount()); }
  });
  it('explains caption layout and field metadata losses separately with their counts', async () => {
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      await act(async () => root.render(<HwpImport reader={{ importStatus: 'done', importProgress: 100, importMessage: '', cancelImport: vi.fn(),
        importWarnings: [{ code: 'object-skipped', count: 2, detail: 'caption-layout' },
          { code: 'object-skipped', count: 1, detail: 'field-metadata' }],
        importWarningsOpen: true, dismissImportWarnings: vi.fn(), showImportWarnings: vi.fn() }} />));
      const items = host.querySelectorAll('[data-warning-code="object-skipped"]');
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toBe('캡션의 텍스트를 가져오고 배치를 단순화했습니다. (2건)');
      expect(items[1].textContent).toBe('필드의 표시 글을 가져오고 하이퍼링크 대상 등 부가 정보를 제외했습니다. (1건)');
      expect(host.textContent).toContain('가져오기 경고 3건');
      expect(host.textContent).not.toContain('지원하지 않는 개체를 제외했습니다.');
    } finally { await act(async () => root.unmount()); }
  });
});

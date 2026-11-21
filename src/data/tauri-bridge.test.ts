import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fileBridge, importedAssetPrefix, reportE2eState } from './tauri-bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, convertFileSrc: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('Rust bridge contract', () => {
  beforeEach(() => vi.clearAllMocks());
  it('sends first-save assets as one framed binary body with exact bytes and UTF-8 metadata', async () => {
    const backing = Uint8Array.of(42, 0, 255, 137, 99);
    const assets = [
      { name: 'img-001.png', mimeType: 'image/png', bytes: backing.subarray(1, 4) },
      { name: 'img-002.jpg', mimeType: 'image/jpeg', bytes: Uint8Array.of(255, 216, 0, 217) },
    ];
    const saved = { path: '/tmp/한글.md', hash: 'hash', mtimeMs: 1, assetsDir: '한글.assets-2' };
    vi.mocked(invoke).mockResolvedValueOnce(saved).mockResolvedValueOnce(null);
    expect(await fileBridge.saveImportedMarkdownAs('![그림](mdviewer-import-assets/img-001.png)', '한글.md', assets)).toEqual(saved);
    const [command, packet] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe('save_imported_markdown_as'); expect(packet).toBeInstanceOf(Uint8Array);
    const bytes = packet as Uint8Array;
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))).toEqual({
      content: '![그림](mdviewer-import-assets/img-001.png)', suggestedName: '한글.md',
      assets: [{ name: 'img-001.png', mimeType: 'image/png', byteLength: 3 }, { name: 'img-002.jpg', mimeType: 'image/jpeg', byteLength: 4 }],
    });
    expect(bytes.subarray(4 + length)).toEqual(Uint8Array.of(0, 255, 137, 255, 216, 0, 217));
    expect(backing).toEqual(Uint8Array.of(42, 0, 255, 137, 99));
    expect(await fileBridge.saveImportedMarkdownAs('', '한글.md', [])).toBeNull();
    expect(importedAssetPrefix('한글 문서 (1).assets')).toBe('%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C%20%281%29.assets/');
  });
  it('uses the agreed command names and camelCase arguments', async () => {
    await fileBridge.takePending();
    await fileBridge.read('/tmp/한글.md');
    await fileBridge.watch('/tmp/한글.md');
    await fileBridge.unwatch();
    await fileBridge.pick();
    await fileBridge.e2eConfig();
    await reportE2eState({ loadCount: 1 });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['take_pending_files'], ['read_markdown', { path: '/tmp/한글.md' }],
      ['watch_file', { path: '/tmp/한글.md' }], ['unwatch_file'],
      ['pick_markdown_file'], ['e2e_config'], ['report_e2e_state', { json: '{"loadCount":1}' }],
    ]);
  });
  it('unwraps event payloads and returns unlisten handles', async () => {
    const release = vi.fn();
    vi.mocked(listen).mockResolvedValue(release);
    const opened = vi.fn();
    expect(await fileBridge.onOpened(opened)).toBe(release);
    const handler = vi.mocked(listen).mock.calls[0][1];
    handler({ event: 'file-opened', id: 1, payload: { path: '/tmp/a.md' } });
    expect(opened).toHaveBeenCalledWith({ path: '/tmp/a.md' });
  });
  it('uses hash-checked save, Save As and close protection command contracts', async () => {
    await fileBridge.writeMarkdown('/tmp/한글.md', '내용', 'open-hash');
    await fileBridge.saveMarkdownAs('내용', '한글.md', '/tmp/old.md');
    await fileBridge.saveMarkdownAs('', '제목 없음.md', null);
    await fileBridge.setDocumentDirty(true);
    await fileBridge.confirmClose();
    await fileBridge.e2eGateOpen();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['write_markdown', { path: '/tmp/한글.md', content: '내용', expectedHash: 'open-hash' }],
      ['save_markdown_as', { content: '내용', suggestedName: '한글.md', previousPath: '/tmp/old.md' }],
      ['save_markdown_as', { content: '', suggestedName: '제목 없음.md', previousPath: null }],
      ['set_document_dirty', { dirty: true }], ['confirm_close'], ['e2e_gate_open'],
    ]);
  });
  it('subscribes to close-blocked and preserves external/self source tags', async () => {
    const release = vi.fn(); vi.mocked(listen).mockResolvedValue(release);
    const close = vi.fn(); const changed = vi.fn();
    expect(await fileBridge.onCloseBlocked(close)).toBe(release);
    await fileBridge.onChanged(changed);
    const calls = vi.mocked(listen).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['close-blocked', 'file-changed']);
    calls[0][1]({ event: 'close-blocked', id: 1, payload: null });
    for (const source of ['self', 'external']) calls[1][1]({ event: 'file-changed', id: 2, payload: { path: '/tmp/a.md', hash: 'h', source } });
    expect(close).toHaveBeenCalledOnce();
    expect(changed.mock.calls.map(([event]) => event.source)).toEqual(['self', 'external']);
  });
  it('uses HWP command contracts and decodes raw bytes without text/base64 conversion', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('/tmp/보고서.hwp').mockResolvedValueOnce(Uint8Array.of(0, 255, 17).buffer)
      .mockResolvedValueOnce([137, 80, 78, 71]).mockResolvedValueOnce({ path: '/tmp/결과.hwpx' });
    expect(await fileBridge.pickHwp()).toBe('/tmp/보고서.hwp');
    expect(await fileBridge.readHwpBytes('/tmp/보고서.hwp')).toEqual(Uint8Array.of(0, 255, 17));
    expect(await fileBridge.readDocumentImage('/tmp/문서.md', '그림.png')).toEqual(Uint8Array.of(137, 80, 78, 71));
    expect(await fileBridge.saveHwpxAs(Uint8Array.of(80, 75), '결과.hwpx')).toEqual({ path: '/tmp/결과.hwpx' });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['pick_hwp_file'], ['read_hwp_bytes', { path: '/tmp/보고서.hwp' }],
      ['read_document_image', { docPath: '/tmp/문서.md', relPath: '그림.png' }],
      ['save_hwpx_as', { bytes: [80, 75], suggestedName: '결과.hwpx' }],
    ]);
  });
  it('unwraps native files-dropped payloads and releases the listener', async () => {
    const release = vi.fn(); vi.mocked(listen).mockResolvedValue(release); const handler = vi.fn();
    expect(await fileBridge.onFilesDropped(handler)).toBe(release);
    expect(vi.mocked(listen).mock.calls[0][0]).toBe('files-dropped');
    vi.mocked(listen).mock.calls[0][1]({ event: 'files-dropped', id: 1, payload: { paths: ['/tmp/한글.hwpx'] } });
    expect(handler).toHaveBeenCalledWith({ paths: ['/tmp/한글.hwpx'] });
  });

});

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));
import { message } from '@tauri-apps/plugin-dialog';
it('[md-word] sends bytes and name to save command', async () => {
  await fileBridge.saveDocxAs(Uint8Array.of(80, 75), '문서.docx');
  expect(invoke).toHaveBeenLastCalledWith('save_docx_as', { bytes: [80, 75], suggestedName: '문서.docx' });
});
it('[close-dialog] passes native warning and three named buttons', async () => {
  vi.mocked(message).mockResolvedValueOnce('취소'); await fileBridge.askUnsavedChanges();
  expect(message).toHaveBeenLastCalledWith('저장하지 않은 변경이 있습니다.', { title: 'MDViewer', kind: 'warning', buttons: { yes: '저장 후 닫기', no: '버리고 닫기', cancel: '취소' } });
});
it('[close-dialog] maps choices conservatively', async () => {
  for (const [answer, expected] of [['저장 후 닫기', 'save'], ['버리고 닫기', 'discard'], ['취소', 'cancel'], ['Cancel', 'cancel'], ['other', 'cancel']] as const) {
    vi.mocked(message).mockResolvedValueOnce(answer); expect(await fileBridge.askUnsavedChanges()).toBe(expected);
  }
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHwpWorkerClient, type WorkerPort } from './worker-client';
import type { HwpWorkerRequest, HwpWorkerResponse } from '@/types/hwp';
import type { HwpImportResult } from '@/domain/hwp-warnings';

const result: HwpImportResult = { markdown: '# 한글', warnings: [], assets: [],
  stats: { headings: 1, paragraphs: 0, tables: 0, images: 0, imageReferences: 0, imageMappings: 0, skippedImages: 0 } };
function harness(timeout = 120_000) {
  const worker: WorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  const client = createHwpWorkerClient(() => worker, timeout);
  const send = (data: HwpWorkerResponse) => worker.onmessage?.({ data } as MessageEvent<HwpWorkerResponse>);
  const request = () => vi.mocked(worker.postMessage).mock.calls[0][0];
  return { client, worker, send, request };
}
afterEach(() => vi.useRealTimers());
describe('HWP worker lifecycle', () => {
  it('reports progress, ignores unrelated IDs and returns parse results without detaching source buffers', async () => {
    const h = harness(); const progress = vi.fn(); const bytes = Uint8Array.of(1, 2, 3);
    const pending = h.client.parse(bytes, 'hwpx', { onProgress: progress });
    const request = h.request(); expect(request.type).toBe('parse');
    expect((request as Extract<HwpWorkerRequest, { type: 'parse' }>).bytes).not.toBe(bytes);
    h.send({ type: 'parse-result', id: 99, result });
    expect(h.worker.terminate).not.toHaveBeenCalled();
    h.send({ type: 'progress', id: request.id, percent: 45, message: '변환 중' });
    h.send({ type: 'parse-result', id: request.id, result });
    await expect(pending).resolves.toEqual(result);
    expect(progress).toHaveBeenCalledWith(45, '변환 중');
    expect(bytes).toEqual(Uint8Array.of(1, 2, 3)); expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(h.worker.onmessage).toBeNull();
  });
  it('preserves parser error codes and terminates', async () => {
    const h = harness(); const pending = h.client.parse(new Uint8Array());
    h.send({ type: 'error', id: h.request().id, message: '암호화 문서', code: 'encrypted' });
    await expect(pending).rejects.toMatchObject({ message: '암호화 문서', code: 'encrypted' });
    expect(h.worker.terminate).toHaveBeenCalledOnce();
  });
  it('rejects constructor, load, and message decode failures with useful errors', async () => {
    await expect(createHwpWorkerClient(() => { throw Error('load'); }).parse(new Uint8Array())).rejects.toThrow('변환 모듈을 시작하지 못했습니다');
    for (const event of ['onerror', 'onmessageerror'] as const) {
      const h = harness(); const pending = h.client.parse(new Uint8Array());
      h.worker[event]?.({} as ErrorEvent & MessageEvent);
      await expect(pending).rejects.toThrow(event === 'onerror' ? '변환 모듈' : '변환 결과');
      expect(h.worker.terminate).toHaveBeenCalledOnce();
    }
  });
  it('aborts in-flight work, detaches listeners, and refuses already cancelled operations', async () => {
    const h = harness(); const controller = new AbortController();
    const pending = h.client.parse(new Uint8Array(), 'hwp', { signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    await expect(h.client.parse(new Uint8Array(), 'hwp', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.worker.postMessage).toHaveBeenCalledOnce();
  });
  it('disposal terminates all active workers and refuses reuse', async () => {
    const workers: WorkerPort[] = [];
    const client = createHwpWorkerClient(() => { const worker = harness().worker; workers.push(worker); return worker; });
    const first = client.parse(new Uint8Array()); const second = client.generate('한글');
    client.dispose();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(client.generate('')).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('bounds stalled worker execution', async () => {
    vi.useFakeTimers(); const h = harness(100); const pending = h.client.generate('내용');
    const rejected = expect(pending).rejects.toThrow('시간이 초과');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(h.worker.terminate).toHaveBeenCalledOnce();
  });
  it('resolves local image RPC in memory and keeps source buffers available', async () => {
    const h = harness(); const bytes = Uint8Array.of(7, 8); const resolveImage = vi.fn(async () => ({ bytes }));
    const pending = h.client.generate('![사진](사진.png)', resolveImage);
    const id = h.request().id;
    h.send({ type: 'image-request', id, requestId: 3, source: '사진.png' });
    await vi.waitFor(() => expect(h.worker.postMessage).toHaveBeenCalledTimes(2));
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({ type: 'image-result', id, requestId: 3, image: { bytes } });
    h.send({ type: 'generate-result', id, result: { bytes, warnings: [] } });
    await expect(pending).resolves.toEqual({ bytes, warnings: [] }); expect(bytes.byteLength).toBe(2);
  });
  it('turns image read failures into missing-image responses so the generator can warn', async () => {
    const h = harness(); const pending = h.client.generate('사진', async () => { throw Error('missing'); });
    h.send({ type: 'image-request', id: h.request().id, requestId: 1, source: 'missing.png' });
    await vi.waitFor(() => expect(h.worker.postMessage).toHaveBeenCalledTimes(2));
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({ type: 'image-result', id: h.request().id, requestId: 1, image: null });
    h.client.dispose(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects postMessage failures without leaking workers', async () => {
    const h = harness(); vi.mocked(h.worker.postMessage).mockImplementation(() => { throw Error('clone'); });
    await expect(h.client.parse(new Uint8Array())).rejects.toThrow('clone'); expect(h.worker.terminate).toHaveBeenCalledOnce();
  });
});

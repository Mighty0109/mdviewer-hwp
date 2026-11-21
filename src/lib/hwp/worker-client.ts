import type { HwpImportResult, HwpProgress } from '@/domain/hwp-warnings';
import type { GenerateResult, ResolveImage } from './generate';
import type { HwpFormat, HwpWorkerRequest, HwpWorkerResponse } from '@/types/hwp';

export interface WorkerPort {
  onmessage: ((event: MessageEvent<HwpWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: HwpWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface TransferOptions { signal?: AbortSignal; onProgress?: HwpProgress }
export interface HwpImporter {
  parse(bytes: Uint8Array, format?: HwpFormat, options?: TransferOptions): Promise<HwpImportResult>;
}
export interface HwpWorkerClient extends HwpImporter {
  generate(markdown: string, resolveImage?: ResolveImage, options?: TransferOptions): Promise<GenerateResult>;
  dispose(): void;
}
const defaultFactory = (kind: 'parse' | 'generate'): WorkerPort => kind === 'parse'
  ? new Worker(new URL('../../workers/hwp-parser.worker.ts', import.meta.url))
  : new Worker(new URL('../../workers/hwp-generator.worker.ts', import.meta.url));
const aborted = () => new DOMException('변환을 취소했습니다.', 'AbortError');

/** Each operation owns its worker. All exit paths release handlers and terminate it. */
export function createHwpWorkerClient(factory = defaultFactory, timeoutMs = 120_000): HwpWorkerClient {
  let sequence = 0;
  let disposed = false;
  const active = new Set<() => void>();
  function run<T extends HwpImportResult | GenerateResult>(request: HwpWorkerRequest, options: TransferOptions, resolveImage?: ResolveImage): Promise<T> {
    return new Promise((resolve, reject) => {
      if (disposed || options.signal?.aborted) { reject(aborted()); return; }
      let worker: WorkerPort;
      try { worker = factory(request.type === 'parse' ? 'parse' : 'generate'); }
      catch { reject(new Error('변환 모듈을 시작하지 못했습니다.')); return; }
      let finished = false;
      const finish = (error?: Error, result?: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        active.delete(cancel);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => finish(aborted());
      const timer = setTimeout(() => finish(new Error('문서 변환 시간이 초과되었습니다.')), timeoutMs);
      active.add(cancel);
      options.signal?.addEventListener('abort', cancel, { once: true });
      worker.onerror = () => finish(new Error('변환 모듈을 시작하지 못했습니다.'));
      worker.onmessageerror = () => finish(new Error('변환 결과를 읽지 못했습니다.'));
      worker.onmessage = ({ data }) => {
        if (finished || data.id !== request.id) return;
        if (data.type === 'progress') options.onProgress?.(Math.min(100, Math.max(0, data.percent)), data.message);
        else if (data.type === 'error') finish(Object.assign(new Error(data.message), { code: data.code }));
        else if (data.type === 'parse-result' || data.type === 'generate-result') finish(undefined, data.result as T);
        else if (data.type === 'image-request') {
          void Promise.resolve().then(() => resolveImage?.(data.source)).then(image => {
            if (!finished) worker.postMessage({ type: 'image-result', id: data.id, requestId: data.requestId,
              image: image instanceof Uint8Array ? { bytes: image } : image ?? null });
          }).catch(() => {
            if (!finished) worker.postMessage({ type: 'image-result', id: data.id, requestId: data.requestId, image: null });
          });
        }
      };
      try {
        // Snapshot inputs: transferring must never detach the caller's buffers.
        worker.postMessage(request, request.type === 'parse' ? [request.bytes.buffer as ArrayBuffer] : []);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  return {
    parse: (bytes, format, options = {}) => run<HwpImportResult>({ type: 'parse', id: ++sequence, bytes: bytes.slice(), format }, options),
    generate: (markdown, resolveImage, options = {}) => run<GenerateResult>({ type: 'generate', id: ++sequence, markdown }, options, resolveImage),
    dispose() { disposed = true; for (const cancel of [...active]) cancel(); },
  };
}

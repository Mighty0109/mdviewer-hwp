/// <reference lib="webworker" />
import { generateHwpx, type ResolvedImage } from '@/lib/hwp/generate';
import type { HwpWorkerRequest, HwpWorkerResponse } from '@/types/hwp';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (response: HwpWorkerResponse) => scope.postMessage(response);
let requestId = 0;
const images = new Map<number, (image: ResolvedImage | null) => void>();
scope.onmessage = async ({ data }: MessageEvent<HwpWorkerRequest>) => {
  if (data.type === 'image-result') {
    images.get(data.requestId)?.(data.image); images.delete(data.requestId); return;
  }
  if (data.type !== 'generate') return;
  const { id, markdown } = data;
  try {
    send({ type: 'progress', id, percent: 5, message: 'HWPX 문서 구성 중' });
    const result = await generateHwpx(markdown, source => new Promise(resolve => {
      const key = ++requestId; images.set(key, resolve);
      send({ type: 'image-request', id, requestId: key, source });
    }));
    send({ type: 'progress', id, percent: 100, message: 'HWPX 문서 생성 완료' });
    scope.postMessage({ type: 'generate-result', id, result } satisfies HwpWorkerResponse, [result.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};

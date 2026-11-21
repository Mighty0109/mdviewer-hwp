/// <reference lib="webworker" />
import { parseHwp } from '@/lib/hwp/parse';
import type { HwpWorkerRequest, HwpWorkerResponse } from '@/types/hwp';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (response: HwpWorkerResponse) => scope.postMessage(response);
scope.onmessage = async ({ data }: MessageEvent<HwpWorkerRequest>) => {
  if (data.type !== 'parse') return;
  const { id, bytes, format } = data;
  try {
    const result = await parseHwp(bytes, (percent, message) => send({ type: 'progress', id, percent, message }), format);
    scope.postMessage({ type: 'parse-result', id, result } satisfies HwpWorkerResponse,
      result.assets.map(asset => asset.bytes.buffer as ArrayBuffer));
  } catch (error) {
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error),
      code: error instanceof Error && 'code' in error ? String(error.code) : undefined });
  }
};

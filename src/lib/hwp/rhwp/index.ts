import { OriginalViewError, type OriginalViewAdapter } from '@/domain/original-view';
import { browserDependencies } from './browser';

/** Small boundary for fake modules in tests; no rhwp code runs in Node. */
export interface RhwpDocumentHandle {
  pageCount(): number;
  renderPageSvg(pageIndex: number): string;
  free(): void;
}

export interface RhwpModule {
  default(input: { module_or_path: ArrayBuffer }): Promise<unknown>;
  HwpDocument: new (bytes: Uint8Array) => RhwpDocumentHandle;
}

export interface RhwpAdapterDependencies {
  registerTextMeasurement(): void;
  loadModule(): Promise<RhwpModule>;
  loadWasm(): Promise<ArrayBuffer>;
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trim() || '알 수 없는 오류입니다.';
}

function release(document: RhwpDocumentHandle | undefined): void {
  // A trapped WASM instance may also trap during free. Cleanup must not crash
  // the editor or replace the useful load/render error with a secondary error.
  try { document?.free(); } catch { /* The JS handle is still discarded. */ }
}

let browserAdapter: OriginalViewAdapter | undefined;

/** Defaults share a lazy runtime; injected dependencies get an isolated runtime. */
export function createRhwpAdapter(deps?: RhwpAdapterDependencies): OriginalViewAdapter {
  if (!deps) return browserAdapter ??= createRhwpAdapter(browserDependencies);
  const dependencies = deps;
  let initialized: Promise<RhwpModule> | undefined;
  async function initialize() {
    try {
      dependencies.registerTextMeasurement();
      const module = await dependencies.loadModule();
      await module.default({ module_or_path: await dependencies.loadWasm() });
      return module;
    } catch (error) {
      throw new OriginalViewError('wasm-load', `원본 보기 모듈을 불러오지 못했습니다: ${reason(error)}`);
    }
  }
  return {
    async open(original) {
      if (original.kind !== 'hwp' && original.kind !== 'hwpx') {
        throw new OriginalViewError('unsupported', 'HWP 또는 HWPX 원본만 볼 수 있습니다.');
      }
      if (original.bytes.byteLength === 0) throw new OriginalViewError('corrupt', '원본 문서가 비어 있습니다.');
      const module = await (initialized ??= initialize());
      let document: RhwpDocumentHandle | undefined;
      try {
        document = new module.HwpDocument(original.bytes.slice());
      } catch (error) {
        const detail = reason(error);
        const code = /unsupported|not supported|encrypted|password|지원하지|지원되지|암호|비밀번호/i.test(detail)
          ? 'unsupported' : 'corrupt';
        throw new OriginalViewError(code, `원본 문서를 열지 못했습니다: ${detail}`);
      }
      let pageCount: number;
      try {
        pageCount = document.pageCount();
        if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw Error('유효한 쪽 정보가 없습니다.');
      } catch (error) {
        release(document);
        throw new OriginalViewError('corrupt', `원본 문서의 쪽 정보를 읽지 못했습니다: ${reason(error)}`);
      }
      return {
        pageCount,
        async renderPage(pageIndex) {
          if (!document) throw new OriginalViewError('render', '이미 닫힌 원본 문서입니다.');
          if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
            throw new OriginalViewError('render', '원본 문서의 쪽 번호가 범위를 벗어났습니다.');
          }
          try {
            return new Blob([document.renderPageSvg(pageIndex)], { type: 'image/svg+xml' });
          } catch (error) {
            throw new OriginalViewError('render', `원본 ${pageIndex + 1}쪽을 그리지 못했습니다: ${reason(error)}`);
          }
        },
        dispose() {
          const released = document;
          document = undefined;
          release(released);
        },
      };
    },
  };
}

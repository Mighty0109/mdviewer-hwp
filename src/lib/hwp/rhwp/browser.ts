import type { RhwpAdapterDependencies } from './index';

/** Lazy browser-only boundary. Importing this file does not load or run rhwp. */
export const browserDependencies: RhwpAdapterDependencies = {
  registerTextMeasurement() {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw Error('Canvas 텍스트 측정을 사용할 수 없습니다.');
    let lastFont = '';
    const measureTextWidth = (font: string, text: string): number => {
      if (font !== lastFont) { context.font = font; lastFont = font; }
      return context.measureText(text).width;
    };
    // rhwp's documented callback takes (font, text), before WASM init.
    Object.assign(globalThis, { measureTextWidth });
  },
  loadModule: () => import('@rhwp/core'),
  async loadWasm() {
    // The response is never passed to wasm-bindgen: no application/wasm MIME
    // requirement, and no redirect to a remote origin or upload of document data.
    const response = await fetch('/rhwp_bg.wasm', { redirect: 'error' });
    if (!response.ok) throw Error(`WASM 파일을 읽지 못했습니다 (HTTP ${response.status}).`);
    return response.arrayBuffer();
  },
};

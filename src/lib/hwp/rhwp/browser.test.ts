import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserDependencies } from './browser';

afterEach(() => { vi.unstubAllGlobals(); });

describe('rhwp browser boundary', () => {
  it('fetches only the local WASM and reads bytes regardless of response MIME', async () => {
    const bytes = new ArrayBuffer(8);
    const arrayBuffer = vi.fn(async () => bytes);
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer }));
    vi.stubGlobal('fetch', fetch);
    expect(await browserDependencies.loadWasm()).toBe(bytes);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/rhwp_bg.wasm', { redirect: 'error' });
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it('reports an HTTP failure before trying to compile an error page', async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer })));
    await expect(browserDependencies.loadWasm()).rejects.toThrow('404');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('registers the font-first global canvas measurement callback without mounting DOM', () => {
    const measureText = vi.fn((_text: string) => ({ width: 27.5 }));
    const ctx = { font: '', measureText };
    const createElement = vi.fn(() => ({ getContext: vi.fn(() => ctx) }));
    vi.stubGlobal('document', { createElement });
    vi.stubGlobal('measureTextWidth', undefined);
    browserDependencies.registerTextMeasurement();
    const measure = (globalThis as unknown as { measureTextWidth(font: string, text: string): number }).measureTextWidth;
    expect(measure('bold 14px sans-serif', '한글')).toBe(27.5);
    expect(ctx.font).toBe('bold 14px sans-serif');
    expect(measureText).toHaveBeenLastCalledWith('한글');
    measure('12px serif', '문서');
    expect(ctx.font).toBe('12px serif');
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas');
  });

  it('reports missing canvas support while registering', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    expect(() => browserDependencies.registerTextMeasurement()).toThrow('Canvas');
  });
});

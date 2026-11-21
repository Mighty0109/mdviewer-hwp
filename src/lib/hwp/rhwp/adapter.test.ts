import { describe, expect, it, vi } from 'vitest';
import { OriginalViewError, type OriginalDocument } from '@/domain/original-view';
import { createRhwpAdapter, type RhwpAdapterDependencies } from './index';

function harness() {
  const events: string[] = [];
  const wasm = new ArrayBuffer(8);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>테스트</text></svg>';
  const renderPageSvg = vi.fn((_page: number) => svg);
  const pageCount = vi.fn(() => 3);
  const free = vi.fn();
  const construct = vi.fn((bytes: Uint8Array) => { bytes.fill(0); });
  const init = vi.fn(async (_input: { module_or_path: ArrayBuffer }) => { events.push('init'); });
  class HwpDocument {
    constructor(bytes: Uint8Array) { events.push('document'); construct(bytes); }
    pageCount = pageCount;
    renderPageSvg = renderPageSvg;
    free = free;
  }
  const deps: RhwpAdapterDependencies = {
    registerTextMeasurement: vi.fn(() => { events.push('measure'); }),
    loadModule: vi.fn(async () => ({ default: init, HwpDocument })),
    loadWasm: vi.fn(async () => wasm),
  };
  return { adapter: createRhwpAdapter(deps), deps, events, wasm, svg, renderPageSvg, pageCount, free, construct, init };
}

describe('read-only rhwp adapter (injected module only)', () => {
  it('opens a copied snapshot, reports all pages and produces only the requested SVG Blob', async () => {
    const h = harness();
    const bytes = Uint8Array.of(1, 2, 3);
    const doc = await h.adapter.open({ bytes, kind: 'hwp' });
    expect(h.events).toEqual(['measure', 'init', 'document']);
    expect(h.init).toHaveBeenCalledWith({ module_or_path: h.wasm });
    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(h.construct.mock.calls[0][0]).not.toBe(bytes);
    expect(doc.pageCount).toBe(3);
    expect(h.renderPageSvg).not.toHaveBeenCalled();
    const page = await doc.renderPage(2);
    expect(page).toBeInstanceOf(Blob);
    expect(page.type).toBe('image/svg+xml');
    expect(await page.text()).toBe(h.svg);
    expect(h.renderPageSvg).toHaveBeenCalledExactlyOnceWith(2);
    doc.dispose();
    expect(h.free).toHaveBeenCalledOnce();
  });

  it('initializes once across concurrent and later HWP/HWPX opens', async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' }),
      h.adapter.open({ bytes: Uint8Array.of(2), kind: 'hwpx' }),
    ]);
    first.dispose(); second.dispose();
    const third = await h.adapter.open({ bytes: Uint8Array.of(3), kind: 'hwpx' });
    expect(h.deps.registerTextMeasurement).toHaveBeenCalledOnce();
    expect(h.deps.loadModule).toHaveBeenCalledOnce();
    expect(h.deps.loadWasm).toHaveBeenCalledOnce();
    expect(h.init).toHaveBeenCalledOnce();
    expect(h.construct).toHaveBeenCalledTimes(3);
    third.dispose();
  });

  it('releases once and rejects rendering after disposal without touching native memory', async () => {
    const h = harness();
    const doc = await h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' });
    doc.dispose(); doc.dispose();
    expect(h.free).toHaveBeenCalledOnce();
    await expect(doc.renderPage(0)).rejects.toMatchObject({ code: 'render' });
    expect(h.renderPageSvg).not.toHaveBeenCalled();
  });

  it.each([-1, 3, 0.5, NaN, Infinity])('rejects invalid page index %s before native rendering', async index => {
    const h = harness();
    const doc = await h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' });
    await expect(doc.renderPage(index)).rejects.toBeInstanceOf(OriginalViewError);
    expect(h.renderPageSvg).not.toHaveBeenCalled();
    doc.dispose();
  });

  it.each(['registerTextMeasurement', 'loadModule', 'loadWasm', 'init'] as const)(
    'turns %s failures into a stable wasm-load error, including later opens', async stage => {
      const h = harness();
      const fail = () => { throw Error('테스트 로딩 실패'); };
      if (stage === 'init') h.init.mockImplementation(fail);
      else vi.mocked(h.deps[stage]).mockImplementation(fail);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' })).rejects.toMatchObject({
          name: 'OriginalViewError', code: 'wasm-load', reason: expect.stringContaining('테스트 로딩 실패'),
        });
      }
      expect(h.construct).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Unsupported format: HWP 3', 'unsupported'],
    ['Encrypted document', 'unsupported'],
    ['Password protected file', 'unsupported'],
    ['암호화된 문서', 'unsupported'],
    ['Invalid ZIP archive', 'corrupt'],
    ['Truncated HWP stream', 'corrupt'],
  ])('classifies document failures: %s', async (message, code) => {
    const h = harness();
    h.construct.mockImplementation(() => { throw message; });
    await expect(h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwpx' })).rejects.toMatchObject({
      name: 'OriginalViewError', code, reason: expect.stringContaining(message),
    });
    expect(h.free).not.toHaveBeenCalled();
  });

  it('rejects empty and unsupported snapshots without loading WASM', async () => {
    const h = harness();
    await expect(h.adapter.open({ bytes: new Uint8Array(), kind: 'hwp' })).rejects.toMatchObject({ code: 'corrupt' });
    await expect(h.adapter.open({ bytes: Uint8Array.of(1), kind: 'pdf' } as unknown as OriginalDocument))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(h.init).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, 'throws'])(
    'releases a partially opened document when page count is invalid: %s', async count => {
      const h = harness();
      h.pageCount.mockImplementation(() => {
        if (count === 'throws') throw Error('쪽 정보 손상');
        return count as number;
      });
      await expect(h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' })).rejects.toMatchObject({
        name: 'OriginalViewError', code: 'corrupt', reason: expect.any(String),
      });
      expect(h.free).toHaveBeenCalledOnce();
    },
  );

  it.each([Error('SVG 생성 실패'), 'WASM trap', undefined])('normalizes page-render errors: %s', async failure => {
    const h = harness();
    const doc = await h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' });
    h.renderPageSvg.mockImplementation(() => { throw failure; });
    await expect(doc.renderPage(0)).rejects.toMatchObject({
      name: 'OriginalViewError', code: 'render', reason: expect.stringMatching(/\S/),
    });
    doc.dispose();
    expect(h.free).toHaveBeenCalledOnce();
  });

  it('does not let native cleanup errors escape into document-close UI', async () => {
    const h = harness();
    const doc = await h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' });
    h.free.mockImplementation(() => { throw Error('free trap'); });
    expect(() => { doc.dispose(); doc.dispose(); }).not.toThrow();
    expect(h.free).toHaveBeenCalledOnce();
    await expect(doc.renderPage(0)).rejects.toMatchObject({ code: 'render' });
  });

  it('preserves the page-count error even if native cleanup fails', async () => {
    const h = harness();
    h.pageCount.mockImplementation(() => { throw Error('쪽 정보 손상'); });
    h.free.mockImplementation(() => { throw Error('free trap'); });
    await expect(h.adapter.open({ bytes: Uint8Array.of(1), kind: 'hwp' })).rejects.toMatchObject({
      code: 'corrupt', reason: expect.stringContaining('쪽 정보 손상'),
    });
    expect(h.free).toHaveBeenCalledOnce();
  });
});

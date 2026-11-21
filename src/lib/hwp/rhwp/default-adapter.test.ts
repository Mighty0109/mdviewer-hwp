import { afterEach, expect, it, vi } from 'vitest';
import { createRhwpAdapter } from './index';

const fake = vi.hoisted(() => ({ init: vi.fn(async () => {}), free: vi.fn() }));
// Never evaluate the downloaded npm module in Node, including through the default loader.
vi.mock('@rhwp/core', () => ({
  default: fake.init,
  HwpDocument: class {
    pageCount() { return 2; }
    renderPageSvg() { return '<svg xmlns="http://www.w3.org/2000/svg"/>'; }
    free = fake.free;
  },
}));
afterEach(() => vi.unstubAllGlobals());

it('lazily shares one browser initialization across default factory calls', async () => {
  const bytes = new ArrayBuffer(8);
  const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
  const createElement = vi.fn(() => ({ getContext: () => ({ font: '', measureText: () => ({ width: 1 }) }) }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', { createElement });
  vi.stubGlobal('measureTextWidth', undefined);
  const first = createRhwpAdapter();
  const second = createRhwpAdapter();
  expect(fetch).not.toHaveBeenCalled();
  expect(createElement).not.toHaveBeenCalled();
  fake.init.mockImplementation(async () => {
    expect(globalThis).toHaveProperty('measureTextWidth', expect.any(Function));
  });
  const docs = await Promise.all([first, second].map(adapter => adapter.open({ bytes: Uint8Array.of(1), kind: 'hwpx' })));
  expect(fake.init).toHaveBeenCalledExactlyOnceWith({ module_or_path: bytes });
  expect(fetch).toHaveBeenCalledOnce();
  expect(createElement).toHaveBeenCalledOnce();
  for (const doc of docs) { expect(doc.pageCount).toBe(2); doc.dispose(); }
  expect(fake.free).toHaveBeenCalledTimes(2);
});

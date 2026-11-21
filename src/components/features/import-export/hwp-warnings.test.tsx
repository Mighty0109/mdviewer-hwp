// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HwpWarnings } from './hwp-warnings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('HWP warning labels', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (warnings: { code: string; count: number; detail?: string }[]) => act(async () => {
    root.render(<HwpWarnings open onClose={vi.fn()} title="가져오기 경고" warnings={warnings} />);
  });

  it('explains flattened table cells in Korean without exposing the code', async () => {
    await render([{ code: 'table-cell-flattened', count: 2 }]);
    const item = container.querySelector('li')!;
    expect(item.textContent).toBe('표 셀 안의 여러 문단·줄바꿈·제목·목록을 한 칸 텍스트로 펼쳤습니다. (2건)');
    expect(container.textContent).not.toContain('table-cell-flattened');
  });

  it.each([
    ['format', '지원하지 않는 그림 형식'],
    ['size', '그림 크기 상한 초과'],
    ['count', '그림 개수 상한 초과'],
    ['missing', '그림 파일을 찾지 못함'],
  ])('keeps the image warning title and translates the %s detail on its own line', async (detail, label) => {
    await render([{ code: 'image-skipped', count: 3, detail }]);
    const item = container.querySelector('li')!;
    expect(item.firstChild?.textContent).toBe('그림을 제외하고 본문에 자리 표시를 남겼습니다.');
    expect(item.textContent).toContain('(3건)');
    expect(item.querySelector('p.break-words.text-xs')?.textContent).toBe(label);
    expect([...item.querySelectorAll('p')].some(line => line.textContent === detail)).toBe(false);
  });

  it.each(['format: emf', 'unrecognized-detail', 'toString'])('keeps unknown image details verbatim: %s', async detail => {
    await render([{ code: 'image-skipped', count: 1, detail }]);
    const item = container.querySelector('li')!;
    expect(item.firstChild?.textContent).toBe('그림을 제외하고 본문에 자리 표시를 남겼습니다.');
    expect(item.querySelector('p')?.textContent).toBe(detail);
  });

  it('keeps unknown warning codes and their details verbatim', async () => {
    await render([{ code: 'future-warning', count: 7, detail: 'format' }]);
    const item = container.querySelector('li')!;
    expect(item.firstChild?.textContent).toBe('future-warning');
    expect(item.textContent).toContain('(7건)');
    expect(item.querySelector('p')?.textContent).toBe('format');
  });

  it.each([
    ['caption-layout', '캡션의 텍스트를 가져오고 배치를 단순화했습니다.'],
    ['field-metadata', '필드의 표시 글을 가져오고 하이퍼링크 대상 등 부가 정보를 제외했습니다.'],
  ])('keeps the object %s explanation in place of its generic title and detail', async (detail, label) => {
    await render([{ code: 'object-skipped', count: 4, detail }]);
    const item = container.querySelector('li')!;
    expect(item.textContent).toBe(`${label} (4건)`);
    expect(item.querySelector('p')).toBeNull();
  });

  it('keeps an unknown object detail below its generic title', async () => {
    await render([{ code: 'object-skipped', count: 5, detail: 'format' }]);
    const item = container.querySelector('li')!;
    expect(item.firstChild?.textContent).toBe('지원하지 않는 개체를 제외했습니다.');
    expect(item.textContent).toContain('(5건)');
    expect(item.querySelector('p')?.textContent).toBe('format');
  });

  it('keeps every warning title, count and detail in its own list item', async () => {
    await render([
      { code: 'table-cell-flattened', count: 2 },
      { code: 'image-skipped', count: 3, detail: 'format' },
      { code: 'image-skipped', count: 4, detail: 'missing' },
      { code: 'object-skipped', count: 5, detail: 'caption-layout' },
      { code: 'future-warning', count: 6, detail: 'raw detail' },
    ]);
    const items = [...container.querySelectorAll('li')];
    expect(items).toHaveLength(5);
    expect(items.map(item => item.textContent)).toEqual([
      '표 셀 안의 여러 문단·줄바꿈·제목·목록을 한 칸 텍스트로 펼쳤습니다. (2건)',
      '그림을 제외하고 본문에 자리 표시를 남겼습니다. (3건)지원하지 않는 그림 형식',
      '그림을 제외하고 본문에 자리 표시를 남겼습니다. (4건)그림 파일을 찾지 못함',
      '캡션의 텍스트를 가져오고 배치를 단순화했습니다. (5건)',
      'future-warning (6건)raw detail',
    ]);
    expect(items.map(item => item.querySelector('p')?.textContent ?? null)).toEqual([
      null, '지원하지 않는 그림 형식', '그림 파일을 찾지 못함', null, 'raw detail',
    ]);
  });
});

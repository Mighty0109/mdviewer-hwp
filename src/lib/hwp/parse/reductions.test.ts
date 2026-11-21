import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { parseHwp } from './index';
import { buildHwp, buildHwpx, concat, control, para, png, record, word, xp } from './testing/builders';

async function parseCellTable(kind: 'hwp' | 'hwpx', binary: Uint8Array, hwpx: string) {
  if (kind === 'hwp') {
    const table = new Uint8Array(22); table.set(word(1), 4); table.set(word(2), 6);
    const cells = [0, 1].map(col => {
      const cell = new Uint8Array(30); cell.set(word(col), 8); cell.set(word(1), 12); cell.set(word(1), 14);
      return concat(record(72, 2, cell), binary);
    });
    return parseHwp(buildHwp({ body: control('tbl', concat(record(77, 2, table), ...cells)) }));
  }
  const cells = [0, 1].map(col => `<hp:tc><hp:cellAddr rowAddr="0" colAddr="${col}"/><hp:cellSpan rowSpan="1" colSpan="1"/><hp:subList>${hwpx}</hp:subList></hp:tc>`).join('');
  return parseHwp(await buildHwpx({ body: `<hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2"><hp:tr>${cells}</hp:tr></hp:tbl></hp:run></hp:p>` }));
}

describe('reported import reductions', () => {
  it.each([78, 79, 80, 81, 82, 83])('warns for every shape and container alongside a picture (tag %i)', async tag => {
    const picture = new Uint8Array(73); picture.set(word(1), 71);
    const body = control('gso', concat(record(86, 2, new Uint8Array()),
      record(tag, 3, new Uint8Array()), record(85, 3, picture)));
    const result = await parseHwp(buildHwp({ body }));
    expect(result.stats.images).toBe(1);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].bytes).toEqual(png);
    expect(result.markdown).toContain('![이미지 1](mdviewer-import-assets/img-001.png)');
    expect(result.warnings).toEqual([{ code: 'shape-skipped', count: 2 }]);
    expect(result.markdown).toContain('\\[도형 제외\\]');
    expect(result.markdown.match(/도형 제외/g)).toHaveLength(2);
  });

  it('reports identical page-number warnings and placeholders for HWP and HWPX', async () => {
    const binary = await parseHwp(buildHwp({ body: concat(para('앞 문단'), control('pgnp', new Uint8Array()), para('뒤 문단')) }));
    const hwpx = await parseHwp(await buildHwpx({ body: xp('앞 문단')
      + '<hp:p><hp:run><hp:ctrl><hp:pageNum/></hp:ctrl></hp:run></hp:p>' + xp('뒤 문단') }));
    expect(hwpx.warnings).toEqual([{ code: 'object-skipped', count: 1 }]);
    expect(binary.warnings).toEqual(hwpx.warnings);
    expect(hwpx.markdown).toContain('\\[자동 번호 필드 제외\\]');
    expect(binary.markdown).toBe(hwpx.markdown);
  });

  describe.each(['hwp', 'hwpx'] as const)('%s table cells', kind => {
    it.each([
      { name: 'two paragraphs', binary: concat(para('첫 문단', 3), para('둘 문단', 3)), hwpx: xp('첫 문단') + xp('둘 문단') },
      { name: 'a line break', binary: para('첫 줄\n둘 줄', 3), hwpx: xp('첫 줄<hp:lineBreak/>둘 줄') },
      { name: 'a heading', binary: para('셀 제목', 3, 1), hwpx: xp('셀 제목', 'styleIDRef="1"') },
      { name: 'a list', binary: para('셀 목록', 3, 0, 1), hwpx: xp('셀 목록', 'paraPrIDRef="1"') },
      { name: 'two paragraphs and a list', binary: concat(para('첫 문단', 3), para('둘 문단', 3), para('셀 목록', 3, 0, 1)),
        hwpx: xp('첫 문단') + xp('둘 문단') + xp('셀 목록', 'paraPrIDRef="1"') },
    ])('warns once per table when flattening $name in cells', async ({ binary, hwpx }) => {
      const result = await parseCellTable(kind, binary, hwpx);
      expect(result.stats.tables).toBe(1);
      expect(result.warnings).toEqual([{ code: 'table-cell-flattened', count: 1 }]);
    });

    it('puts one flattening placeholder after the table and preserves its GFM row and column counts', async () => {
      const result = await parseCellTable(kind, concat(para('첫 문단', 3), para('둘 문단', 3), para('셀 목록', 3, 0, 1)),
        xp('첫 문단') + xp('둘 문단') + xp('셀 목록', 'paraPrIDRef="1"'));
      expect(result.warnings).toEqual([{ code: 'table-cell-flattened', count: 1 }]);
      expect(result.markdown.match(/표 셀 구조 평탄화/g)).toHaveLength(1);
      expect(result.markdown).toMatch(/\| --- \| --- \|\n\n\\\[표 셀 구조 평탄화\\\]$/);
      const tokens = marked.lexer(result.markdown).filter(t => t.type !== 'space');
      expect(tokens.map(t => t.type)).toEqual(['table', 'paragraph']);
      expect(tokens[0]).toMatchObject({ header: [{ text: expect.stringContaining('첫 문단') }, { text: expect.stringContaining('셀 목록') }], rows: [] });
      expect(tokens[1]).toMatchObject({ text: '\\[표 셀 구조 평탄화\\]' });
    });

    it('keeps simple cells free of flattening warnings', async () => {
      const result = await parseCellTable(kind, para('단순 셀', 3), xp('단순 셀'));
      expect(result.markdown).toBe('| 단순 셀 | 단순 셀 |\n| --- | --- |');
      expect(result.warnings).toEqual([]);
    });
  });

  it('places nested-cell flattening notices outside the containing GFM table', async () => {
    const inner = '<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>'
      + xp('첫 문단') + xp('둘 문단') + xp('목록', 'paraPrIDRef="1"') + '</hp:subList></hp:tc></hp:tr></hp:tbl>';
    const outer = `<hp:p><hp:run><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p><hp:run>${inner}</hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>`;
    const result = await parseHwp(await buildHwpx({ body: outer + xp('사이') + outer }));
    expect(result.warnings).toContainEqual({ code: 'table-cell-flattened', count: 2 });
    expect(result.markdown.match(/표 셀 구조 평탄화/g)).toHaveLength(2);
    const tokens = marked.lexer(result.markdown).filter(t => t.type !== 'space');
    expect(tokens.map(t => t.type)).toEqual(['table', 'paragraph', 'paragraph', 'table', 'paragraph']);
    for (const token of tokens.filter(t => t.type === 'table')) {
      expect(token.raw).not.toContain('표 셀 구조 평탄화');
      expect(token).toMatchObject({ header: [{ text: expect.stringContaining('첫 문단') }], rows: [] });
    }
  });
});

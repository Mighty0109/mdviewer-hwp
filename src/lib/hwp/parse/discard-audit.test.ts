import { describe, expect, it } from 'vitest';
import { parseHwp } from './index';
import { buildHwp, buildHwpx, concat, control, para, picture, record, utf16, word, xp, xtable } from './testing/builders';

describe('discard branch audit', () => {
  it.each([
    { name: 'unknown paragraph record', body: concat(para('본문'), record(511, 1, Uint8Array.of(42))) },
    { name: 'unhandled component beside a picture', body: concat(picture(1), record(89, 2, Uint8Array.of(42))) },
    { name: 'orphan paragraph text', body: record(67, 0, utf16('버려진 글')) },
    { name: 'text under a normally contentless control', body: control('cold', para('버려진 글', 2)) },
    { name: 'text before a table outside its caption list', body: control('tbl', concat(para('버려진 글', 2),
      record(77, 2, concat(new Uint8Array(4), word(1), word(1))),
      record(72, 2, concat(new Uint8Array(12), word(1), word(1))), para('셀', 3))) },
    { name: 'orphan nested control', body: control('gso', record(71, 2, Uint8Array.from([120, 120, 120, 120]))) },
  ])('labels binary content at the $name bypass', async ({ body }) => {
    const result = await parseHwp(buildHwp({ body }));
    expect(result.warnings.some(w => w.code === 'object-skipped')).toBe(true);
    expect(result.markdown).toContain('개체 제외');
  });

  it('keeps binary layout records and empty paragraphs silent', async () => {
    const result = await parseHwp(buildHwp({ body: concat(para(''), record(68, 1, new Uint8Array(8)),
      record(69, 1, new Uint8Array(36)), record(70, 1, new Uint8Array(12)),
      control('cold', new Uint8Array()), control('pgct', new Uint8Array()), control('pghd', new Uint8Array()),
      control('bokm', new Uint8Array()), para('본문')) }));
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toBe('본문');
  });

  it.each([
    { name: 'unknown picture child', body: '<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="imageA"/><hp:futureObject><hp:t>누락 글</hp:t></hp:futureObject></hp:pic></hp:run></hp:p>' },
    { name: 'unknown table child', body: `<hp:p><hp:run>${xtable().replace('</hp:tbl>', '<hp:futureObject><hp:t>누락 글</hp:t></hp:futureObject></hp:tbl>')}</hp:run></hp:p>` },
    { name: 'unknown table row child', body: `<hp:p><hp:run>${xtable().replace('</hp:tr>', '<hp:futureObject>누락 글</hp:futureObject></hp:tr>')}</hp:run></hp:p>` },
    { name: 'foreign cell metadata', body: `<hp:p><hp:run>${xtable().replace('<hp:subList>', '<x:cellSz xmlns:x="urn:extension">누락 글</x:cellSz><hp:subList>')}</hp:run></hp:p>` },
    { name: 'foreign inline object', body: xp('앞<x:object xmlns:x="urn:extension"/>뒤') },
    { name: 'text inside line layout', body: '<hp:p><hp:run><hp:t>본문</hp:t></hp:run><hp:linesegarray>' + xp('누락 글') + '</hp:linesegarray></hp:p>' },
    { name: 'text outside a text element', body: '<hp:p><hp:run>누락 글</hp:run></hp:p>' },
    { name: 'text outside a paragraph', body: '누락 글' + xp('본문') },
    { name: 'core namespace caption lookalike', body: '<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="imageA"/><hc:caption>누락 글</hc:caption></hp:pic></hp:run></hp:p>' },
    { name: 'additional picture source', body: '<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="imageA"/><hc:img binaryItemIDRef="imageA"/></hp:pic></hp:run></hp:p>' },
  ])('labels HWPX content at the $name bypass', async ({ body }) => {
    const result = await parseHwp(await buildHwpx({ body }));
    expect(result.warnings).toContainEqual({ code: 'object-skipped', count: 1 });
    expect(result.markdown).toContain('제외');
  });

  it('keeps HWPX page, line, picture and cell geometry metadata silent', async () => {
    const body = '<hp:p><hp:run><hp:secPr><hp:pagePr width="100"/><hp:grid lineGrid="0"/></hp:secPr>'
      + '<hp:pic><hc:img binaryItemIDRef="imageA"/><hp:offset x="0" y="0"/><hp:imgRect><hc:pt0 x="0" y="0"/></hp:imgRect></hp:pic>'
      + '</hp:run><hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p>'
      + `<hp:p><hp:run>${xtable().replace('<hp:subList>', '<hp:cellSz width="100"/><hp:cellMargin left="0"/><hp:subList>')}</hp:run></hp:p>`;
    const result = await parseHwp(await buildHwpx({ body }));
    expect(result.warnings).toEqual([]);
    expect(result.stats).toMatchObject({ images: 1, tables: 1 });
  });

  it('does not split body text around empty HWPX section and line properties', async () => {
    const result = await parseHwp(await buildHwpx({ body: '<hp:p><hp:run><hp:t>앞</hp:t><hp:secPr><hp:pagePr/></hp:secPr>'
      + '<hp:linesegarray><hp:lineseg/></hp:linesegarray><hp:t>뒤</hp:t></hp:run></hp:p>' }));
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toBe('앞뒤');
  });
});

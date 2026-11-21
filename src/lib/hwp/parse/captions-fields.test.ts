import { describe, expect, it } from 'vitest';
import { parseHwp } from './index';
import { binaryTable, buildHwp, buildHwpx, concat, control, para, picture, record, word, xp, xtable } from './testing/builders';

describe('caption and field reductions', () => {
  it('retains binary table caption paragraphs before TABLE without treating them as cells', async () => {
    const bytes = buildHwp({ body: concat(para('앞 문단'), binaryTable(false, false, 0, ['표 캡션 첫째', '표 캡션 둘째']), para('뒤 문단')) });
    const original = bytes.slice();
    const result = await parseHwp(bytes);
    expect(result.markdown).toContain('표 캡션 첫째');
    expect(result.markdown).toContain('표 캡션 둘째');
    expect(result.markdown).toContain('캡션 배치 제외: 텍스트만 가져옴');
    expect(result.warnings).toContainEqual({ code: 'object-skipped', count: 1, detail: 'caption-layout' });
    expect(result.markdown.indexOf('앞 문단')).toBeLessThan(result.markdown.indexOf('표 캡션 첫째'));
    expect(result.markdown.indexOf('표 캡션 둘째')).toBeLessThan(result.markdown.indexOf('뒤 문단'));
    expect(result.markdown).toContain('| 셀 1\\-1 | 셀 1\\-2 |');
    expect(result.stats.tables).toBe(1);
    expect(bytes).toEqual(original);
  });

  it('retains binary picture caption text with an explicit text-only reduction', async () => {
    // LIST_HEADER and its paragraphs remain descendants of the picture's gso control.
    const body = concat(picture(1), record(72, 2, new Uint8Array(22)), para('그림 캡션', 3));
    const result = await parseHwp(buildHwp({ body }));
    expect(result.markdown).toContain('그림 캡션');
    expect(result.markdown).toContain('글상자 텍스트만 가져옴');
    expect(result.warnings).toContainEqual({ code: 'textbox-text-only', count: 1 });
    expect(result.stats.images).toBe(1);
  });

  it('does not mistake a binary table inside a caption for the parent TABLE record', async () => {
    const table = new Uint8Array(22); table.set(word(1), 4); table.set(word(1), 6);
    const cell = new Uint8Array(30); cell.set(word(1), 12); cell.set(word(1), 14);
    const body = control('tbl', concat(record(72, 2, new Uint8Array(22)), para('외부 캡션', 3), binaryTable(false, false, 3),
      record(77, 2, table), record(72, 2, cell), para('외부 셀', 3)));
    const result = await parseHwp(buildHwp({ body }));
    expect(result.stats.tables).toBe(2);
    expect(result.markdown).toContain('외부 캡션');
    expect(result.markdown).toContain('| 외부 셀 |\n| --- |');
    expect(result.markdown).toContain('| 셀 1\\-1 | 셀 1\\-2 |');
    expect(result.warnings).toEqual([{ code: 'object-skipped', count: 1, detail: 'caption-layout' }]);
  });

  it.each(['table', 'picture'] as const)('retains HWPX %s captions and labels their flattened layout once', async kind => {
    const caption = `<hp:caption side="BOTTOM"><hp:subList>${xp('캡션 첫째 &amp; &lt;표시&gt;')}${xp('캡션 둘째')}</hp:subList></hp:caption>`;
    const object = kind === 'table' ? xtable().replace('</hp:tbl>', caption + '</hp:tbl>')
      : `<hp:pic><hc:img binaryItemIDRef="imageA"/>${caption}</hp:pic>`;
    const bytes = await buildHwpx({ prefix: 'q', body: `<hp:p><hp:run><hp:t>앞 문단</hp:t>${object}<hp:t>뒤 문단</hp:t></hp:run></hp:p>` });
    const original = bytes.slice();
    const result = await parseHwp(bytes);
    expect(result.markdown).toContain('캡션 첫째 & \\<표시\\>');
    expect(result.markdown).toContain('캡션 둘째');
    expect(result.markdown).toContain('캡션 배치 제외: 텍스트만 가져옴');
    expect(result.warnings).toEqual([{ code: 'object-skipped', count: 1, detail: 'caption-layout' }]);
    expect(result.markdown.indexOf('앞 문단')).toBeLessThan(result.markdown.indexOf('캡션 첫째'));
    expect(result.markdown.indexOf('캡션 둘째')).toBeLessThan(result.markdown.indexOf('뒤 문단'));
    expect(result.stats.tables).toBe(kind === 'table' ? 1 : 0);
    expect(result.stats.images).toBe(kind === 'picture' ? 1 : 0);
    expect(bytes).toEqual(original);
  });

  it('applies exclusion and tracked-deletion policy inside captions', async () => {
    const caption = `<hp:caption><hp:subList><hp:p><hp:run><hp:t>남길 캡션</hp:t><hp:footNote>${xp('숨긴 각주')}</hp:footNote><hp:delete><hp:t>숨긴 변경</hp:t></hp:delete></hp:run></hp:p></hp:subList></hp:caption>`;
    const result = await parseHwp(await buildHwpx({ body: `<hp:p><hp:run>${xtable().replace('</hp:tbl>', caption + '</hp:tbl>')}</hp:run></hp:p>` }));
    expect(result.markdown).toContain('남길 캡션');
    expect(result.markdown).not.toContain('숨긴');
    for (const code of ['object-skipped', 'footnote-skipped', 'change-tracking-ignored']) {
      expect(result.warnings.some(w => w.code === code)).toBe(true);
    }
    expect(result.markdown).toContain('각주/미주 제외');
    expect(result.markdown).toContain('변경추적 삭제 내용 제외');
  });

  it('does not use a caption picture as the missing parent picture source', async () => {
    const caption = `<hp:caption><hp:subList><hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="imageA"/></hp:pic></hp:run></hp:p></hp:subList></hp:caption>`;
    const result = await parseHwp(await buildHwpx({ body: `<hp:p><hp:run><hp:pic>${caption}</hp:pic></hp:run></hp:p>` }));
    expect(result.stats).toMatchObject({ images: 1, imageReferences: 2, skippedImages: 1 });
    expect(result.assets).toHaveLength(1);
    expect(result.markdown).toContain('mdviewer-import-assets/img-001.png');
    expect(result.markdown).toContain('이미지 2 제외: missing');
    expect(result.warnings).toContainEqual({ code: 'image-skipped', count: 1, detail: 'missing' });
  });

  it('reports an empty caption layout once without inventing text', async () => {
    const bytes = [buildHwp({ body: binaryTable(false, false, 0, ['']) }),
      await buildHwpx({ body: `<hp:p><hp:run>${xtable().replace('</hp:tbl>', '<hp:caption><hp:subList/></hp:caption></hp:tbl>')}</hp:run></hp:p>` })];
    for (const source of bytes) {
      const result = await parseHwp(source);
      expect(result.warnings).toEqual([{ code: 'object-skipped', count: 1, detail: 'caption-layout' }]);
      expect(result.markdown.match(/캡션 배치 제외/g)).toHaveLength(1);
      expect(result.stats.tables).toBe(1);
    }
  });

  it.each(['HYPERLINK', 'UNKNOWN'])('warns once per HWPX %s field while retaining its display text', async type => {
    const begin = `<hp:ctrl><hp:fieldBegin id="1" type="${type}"><hp:parameters><hp:stringParam name="Command">https://example.invalid/target</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
    const body = `<hp:p><hp:run><hp:t>앞</hp:t>${begin}<hp:t>표시 텍스트</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl><hp:t>뒤</hp:t></hp:run></hp:p>`;
    const result = await parseHwp(await buildHwpx({ body: body + body }));
    expect(result.markdown.match(/표시 텍스트/g)).toHaveLength(2);
    expect(result.markdown.match(/필드 정보 제외/g)).toHaveLength(2);
    expect(result.markdown).not.toContain('example.invalid');
    expect(result.warnings).toEqual([{ code: 'object-skipped', count: 2, detail: 'field-metadata' }]);
  });

  it('keeps binary field display text with the existing warning and placeholder', async () => {
    const result = await parseHwp(buildHwp({ body: control('%hlk', para('필드 표시', 2)) }));
    expect(result.markdown).toContain('필드 표시');
    expect(result.markdown).toContain('개체 제외');
    expect(result.warnings).toContainEqual({ code: 'object-skipped', count: 1 });
  });
});

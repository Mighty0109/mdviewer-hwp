import { describe, expect, it } from 'vitest';
import * as CFB from 'cfb';
import { parseHwp } from './index';
import { binaryTable, buildHwp, buildHwpx, concat, control, para, picture, png, record, word, xp, xpic, xtable, xmlHeader } from './testing/builders';

const xregion = (kind: 'header' | 'footer', body: string) => `<hp:p><hp:run><hp:ctrl><hp:${kind}><hp:subList>${body}</hp:subList></hp:${kind}></hp:ctrl></hp:run></hp:p>`;

describe('header and footer import', () => {
  it.each(['hwp', 'hwpx'] as const)('keeps the pre-change %s markdown without headers or footers byte-for-byte', async kind => {
    const bytes = kind === 'hwp' ? buildHwp({ body: concat(
      para('합성 제목', 0, 1), para('일반 문단 & 한글 😀'), para('번호 항목', 0, 0, 1), para('글머리 항목', 0, 0, 2),
      binaryTable(), picture(1), control('fn', para('숨긴 각주', 2)), control('en', para('숨긴 미주', 2)),
      control('gso', para('글상자 내용', 2)), binaryTable(true), control('eqed', new Uint8Array()),
      control('gso', record(79, 2, new Uint8Array(73))), control('xxxx', new Uint8Array()),
    ) }) : await buildHwpx({ body: [
      xp('합성 제목', 'styleIDRef="1"'), xp('일반 문단 &amp; 한글 😀'), xp('번호 항목', 'paraPrIDRef="1"'), xp('글머리 항목', 'paraPrIDRef="2"'),
      `<hp:p><hp:run>${xtable()}</hp:run></hp:p>`, xpic(),
      ...['footNote', 'endNote'].map(tag => `<hp:p><hp:run><hp:ctrl><hp:${tag}>${xp('숨긴 내용')}</hp:${tag}></hp:ctrl></hp:run></hp:p>`),
      `<hp:p><hp:run><hp:rect><hp:subList>${xp('글상자 내용')}</hp:subList></hp:rect></hp:run></hp:p>`,
      `<hp:p><hp:run>${xtable(true)}<hp:equation/><hp:ellipse/><hp:ole/></hp:run></hp:p>`,
    ].join('') });
    const result = await parseHwp(bytes);
    // Capture against the unchanged parser before introducing header/footer collection.
    expect(result.markdown).toMatchInlineSnapshot(`
      "## 합성 제목

      일반 문단 & 한글 😀

      1. 번호 항목

        - 글머리 항목

      | 셀 1\\-1 | 셀 1\\-2 |
      | --- | --- |
      | 셀 2\\-1 | 셀 2\\-2 |

      ![이미지 1](mdviewer-import-assets/img-001.png)

      \\[각주/미주 제외\\]

      \\[각주/미주 제외\\]

      \\[글상자 텍스트만 가져옴\\]

      글상자 내용

      <table>
      <tr><td rowspan="1" colspan="2">셀 1-1</td></tr>
      <tr><td rowspan="1" colspan="1">셀 2-1</td><td rowspan="1" colspan="1">셀 2-2</td></tr>
      </table>

      \\[수식 제외\\]

      \\[도형 제외\\]

      \\[개체 제외\\]"
    `);
  });

  it('places the header table before the body and footer after it with identical HWP and HWPX markdown', async () => {
    const sources = [buildHwp({ body: concat(para('본문 앞'), control('foot', para('회사 꼬리글', 2)),
      control('head', binaryTable(false, false, 2)), para('본문 뒤')) }),
    await buildHwpx({ body: xp('본문 앞') + xregion('footer', xp('회사 꼬리글'))
      + xregion('header', `<hp:p><hp:run>${xtable()}</hp:run></hp:p>`) + xp('본문 뒤') })];
    const results = await Promise.all(sources.map(source => parseHwp(source)));
    for (const result of results) {
      expect(result.markdown).toBe('| 셀 1\\-1 | 셀 1\\-2 |\n| --- | --- |\n| 셀 2\\-1 | 셀 2\\-2 |\n\n본문 앞\n\n본문 뒤\n\n회사 꼬리글');
      expect(result.warnings).toEqual([]);
      expect(result.stats).toMatchObject({ paragraphs: 7, tables: 1 });
    }
    expect(results[0].markdown).toBe(results[1].markdown);
  });

  it('deduplicates repeated section headers and footers by structure and retains distinct variants in encounter order', async () => {
    const labels = ['홀수 머리글', '짝수 머리글', '홀수 머리글'];
    const binarySections = labels.map(label => concat(control('head', concat(para(label, 2), binaryTable(false, false, 2), picture(1, 2))),
      control('foot', para('반복 꼬리글', 2)), para('본문')));
    const cfb = CFB.read(buildHwp({ flags: 0, body: binarySections[0] }), { type: 'array' });
    binarySections.slice(1).forEach((body, i) => CFB.utils.cfb_add(cfb, `BodyText/Section${i + 1}`, body));
    const xmlSections = labels.map(label => xregion('header', xp(label) + `<hp:p><hp:run>${xtable()}</hp:run></hp:p>` + xpic())
      + xregion('footer', xp('반복 꼬리글')) + xp('본문'));
    const sources = [Uint8Array.from(CFB.write(cfb, { type: 'buffer' })), await buildHwpx({ body: xmlSections[0], extra:
      Object.fromEntries(xmlSections.slice(1).map((body, i) => [`Contents/section${i + 1}.xml`, `<hs:sec ${xmlHeader}>${body}</hs:sec>`])),
    })];
    const table = '| 셀 1\\-1 | 셀 1\\-2 |\n| --- | --- |\n| 셀 2\\-1 | 셀 2\\-2 |';
    const image = '![이미지 1](mdviewer-import-assets/img-001.png)';
    const results = await Promise.all(sources.map(source => parseHwp(source)));
    for (const result of results) {
      expect(result.markdown).toBe(`홀수 머리글\n\n${table}\n\n${image}\n\n짝수 머리글\n\n${table}\n\n${image}\n\n본문\n\n본문\n\n본문\n\n반복 꼬리글`);
      expect(result.stats).toMatchObject({ tables: 2, paragraphs: 14, imageReferences: 3, imageMappings: 3 });
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].bytes).toEqual(png);
      expect(result.warnings).toEqual([]);
    }
    expect(results[0].markdown).toBe(results[1].markdown);
  });

  it('keeps repetition within a region, identical body text, and separate header and footer roles', async () => {
    const sources = [buildHwp({ body: concat(control('head', concat(para('동일', 2), para('동일', 2))),
      control('head', para('동일', 2)), para('동일'), control('foot', para('동일', 2))) }),
    await buildHwpx({ body: xregion('header', xp('동일') + xp('동일')) + xregion('header', xp('동일'))
      + xp('동일') + xregion('footer', xp('동일')) })];
    for (const source of sources) expect((await parseHwp(source)).markdown).toBe(Array(5).fill('동일').join('\n\n'));
  });

  it('preserves merged header cells and their logo while sharing the asset with the body and footer', async () => {
    const table = new Uint8Array(22); table.set(word(1), 4); table.set(word(2), 6);
    const cell = new Uint8Array(30); cell.set(word(2), 12); cell.set(word(1), 14);
    const binaryHeader = control('head', control('tbl', concat(record(77, 4, table), record(72, 4, cell),
      para('로고 & 문서번호', 5), picture(1, 5)), 2));
    const xmlTable = '<hp:tbl rowCnt="1" colCnt="2"><hp:tr><hp:tc><hp:cellAddr rowAddr="0" colAddr="0"/>'
      + '<hp:cellSpan rowSpan="1" colSpan="2"/><hp:subList>' + xp('로고 &amp; 문서번호') + xpic() + '</hp:subList></hp:tc></hp:tr></hp:tbl>';
    const sources = [buildHwp({ body: concat(binaryHeader, picture(1), control('foot', concat(picture(1, 2), para('회사', 2)))) }),
      await buildHwpx({ body: xregion('header', `<hp:p><hp:run>${xmlTable}</hp:run></hp:p>`)
        + xpic() + xregion('footer', xpic() + xp('회사')) })];
    const results = await Promise.all(sources.map(source => parseHwp(source)));
    for (const result of results) {
      expect(result.markdown).toBe('<table>\n<tr><td rowspan="1" colspan="2">로고 &amp; 문서번호<br><img src="mdviewer-import-assets/img-001.png" alt="이미지 1"></td></tr>\n</table>'
        + '\n\n![이미지 1](mdviewer-import-assets/img-001.png)\n\n![이미지 1](mdviewer-import-assets/img-001.png)\n\n회사');
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].bytes).toEqual(png);
      expect(result.stats).toMatchObject({ images: 3, imageReferences: 3, imageMappings: 3 });
      expect(result.warnings).toEqual([{ code: 'table-raw-html', count: 1 }]);
    }
    expect(results[0].markdown).toBe(results[1].markdown);
  });

  it('retains the existing automatic-page-field markers and warnings inside headers', async () => {
    const sources = [buildHwp({ body: concat(control('head', concat(para('페이지', 2), control('pgnp', new Uint8Array(), 2))), para('본문')) }),
      await buildHwpx({ body: xregion('header', xp('페이지') + '<hp:p><hp:run><hp:autoNum/></hp:run></hp:p>') + xp('본문') })];
    for (const source of sources) {
      const result = await parseHwp(source);
      expect(result.markdown).toBe('페이지\n\n\\[자동 번호 필드 제외\\]\n\n본문');
      expect(result.warnings).toEqual([{ code: 'object-skipped', count: 1 }]);
    }
    const automatic = await parseHwp(buildHwp({ body: concat(control('head', control('atno', new Uint8Array(), 2)), para('본문')) }));
    expect(automatic.markdown).toBe('\\[개체 제외\\]\n\n본문');
    expect(automatic.warnings).toEqual([{ code: 'object-skipped', count: 1 }]);
  });

  it('does not add output or warnings for empty headers and footers', async () => {
    const sources = [buildHwp({ body: concat(control('head', para(' \t', 2)), para('본문'), control('foot', new Uint8Array())) }),
      await buildHwpx({ body: xregion('header', xp(' \t')) + xp('본문') + xregion('footer', '') })];
    for (const source of sources) {
      const result = await parseHwp(source);
      expect(result.markdown).toBe('본문');
      expect(result.warnings).toEqual([]);
    }
  });
});

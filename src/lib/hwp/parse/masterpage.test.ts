import { describe, expect, it } from 'vitest';
import * as CFB from 'cfb';
import { parseHwp } from './index';
import { buildHwp, buildHwpx, concat, control, para, picture, record, xp, xpic, xmlHeader } from './testing/builders';

const masterText = '본문으로 옮기면 안 되는 바탕쪽';
const binaryMaster = (texts: string[]) => control('secd', concat(record(73, 2, new Uint8Array(40)),
  ...texts.map(text => concat(record(72, 2, new Uint8Array(24)), para(text, 3)))));
const inlineMaster = (texts: string[]) => `<hp:p><hp:run><hp:secPr><hp:pagePr width="100"/>${texts.map(text =>
  `<hp:masterPage><hp:subList>${xp(text)}</hp:subList></hp:masterPage>`).join('')}</hp:secPr></hp:run></hp:p>`;
const masterRef = '<hp:p><hp:run><hp:secPr><hp:masterPage idRef="master0"/><hp:masterPage idRef="master0"/></hp:secPr></hp:run></hp:p>';
const packageWithMaster = (text: string, sections: string[]) => buildHwpx({ body: sections[0], extra: {
  'Contents/content.hpf': `<package><manifest><item id="master0" href="masterpage0.xml"/>${sections.map((_, i) =>
    `<item id="s${i}" href="section${i}.xml"/>`).join('')}</manifest><spine>${sections.map((_, i) => `<itemref idref="s${i}"/>`).join('')}</spine></package>`,
  'Contents/masterpage0.xml': `<hm:masterPage xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ${xmlHeader}><hp:subList>${xp(text)}</hp:subList></hm:masterPage>`,
  ...Object.fromEntries(sections.slice(1).map((body, i) => [`Contents/section${i + 1}.xml`, `<hs:sec ${xmlHeader}>${body}</hs:sec>`])),
} });

describe('master page reductions', () => {
  it.each([0, 1])('reports one identical warning and body placeholder per section for text-bearing HWP and inline HWPX master pages (format %i)', async format => {
    const sources = [buildHwp({ body: concat(binaryMaster([masterText, masterText]), binaryMaster([masterText]), para('본문')) }),
      await buildHwpx({ body: inlineMaster([masterText, masterText]) + inlineMaster([masterText]) + xp('본문') })];
    for (const bytes of [sources[format]]) {
      const original = bytes.slice();
      const result = await parseHwp(bytes);
      expect(result.warnings).toEqual([{ code: 'masterpage-skipped', count: 1 }]);
      expect(result.markdown).toBe('\\[바탕쪽 제외\\]\n\n본문');
      expect(bytes).toEqual(original);
    }
  });

  it.each([{ texts: [] }, { texts: [''] }, { texts: [' \t\n'] }])('does not warn for absent or empty master-page text ($texts)', async ({ texts }) => {
    const sources = [buildHwp({ body: concat(binaryMaster(texts), para('본문')) }),
      await buildHwpx({ body: inlineMaster(texts) + xp('본문') })];
    for (const bytes of sources) {
      const result = await parseHwp(bytes);
      expect(result.warnings).toEqual([]);
      expect(result.markdown).toBe('본문');
    }
  });

  it('resolves manifest master-page references and reports once in each affected section, without leaking text', async () => {
    const source = await packageWithMaster(masterText, [masterRef + inlineMaster([masterText]) + xp('첫 구역'),
      xp('둘 구역'), masterRef + xp('셋 구역')]);
    const result = await parseHwp(source);
    expect(result.warnings).toEqual([{ code: 'masterpage-skipped', count: 2 }]);
    expect(result.markdown).toBe('\\[바탕쪽 제외\\]\n\n첫 구역\n\n둘 구역\n\n\\[바탕쪽 제외\\]\n\n셋 구역');
  });

  it('keeps empty external master pages silent even when referenced', async () => {
    const result = await parseHwp(await packageWithMaster(' \t', [masterRef + xp('본문')]));
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toBe('본문');
  });

  it('resets the binary master-page warning for each section', async () => {
    const cfb = CFB.read(buildHwp({ flags: 0, body: concat(binaryMaster([masterText]), para('첫 구역')) }), { type: 'array' });
    CFB.utils.cfb_add(cfb, 'BodyText/Section1', para('둘 구역'));
    CFB.utils.cfb_add(cfb, 'BodyText/Section2', concat(binaryMaster([masterText]), para('셋 구역')));
    const result = await parseHwp(Uint8Array.from(CFB.write(cfb, { type: 'buffer' })));
    expect(result.warnings).toEqual([{ code: 'masterpage-skipped', count: 2 }]);
    expect(result.markdown).toBe('\\[바탕쪽 제외\\]\n\n첫 구역\n\n둘 구역\n\n\\[바탕쪽 제외\\]\n\n셋 구역');
  });

  it('also labels picture-only master pages instead of treating visible objects as empty', async () => {
    const bytes = [buildHwp({ body: concat(control('secd', concat(record(72, 2, new Uint8Array(24)), picture(1, 3))), para('본문')) }),
      await buildHwpx({ body: `<hp:p><hp:run><hp:secPr><hp:masterPage><hp:subList>${xpic()}</hp:subList></hp:masterPage></hp:secPr></hp:run></hp:p>` + xp('본문') })];
    for (const source of bytes) {
      const result = await parseHwp(source);
      expect(result.warnings).toEqual([{ code: 'masterpage-skipped', count: 1 }]);
      expect(result.markdown).toBe('\\[바탕쪽 제외\\]\n\n본문');
      expect(result.assets).toEqual([]);
    }
  });

  it('rejects missing referenced master pages rather than silently treating them as empty', async () => {
    await expect(parseHwp(await buildHwpx({ body: masterRef }))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('keeps contentless controls in empty master pages silent', async () => {
    const bytes = [buildHwp({ body: concat(control('secd', concat(record(72, 2, new Uint8Array(24)), control('bokm', new Uint8Array(), 3))), para('본문')) }),
      await buildHwpx({ body: inlineMaster(['<hp:tab/><hp:lineBreak/>']) + xp('본문') })];
    for (const source of bytes) {
      const result = await parseHwp(source);
      expect(result.warnings).toEqual([]);
      expect(result.markdown).toBe('본문');
    }
  });

  it('labels unknown master-page objects without transferring their text', async () => {
    const result = await parseHwp(await buildHwpx({ body: '<hp:p><hp:run><hp:secPr><hp:masterPage><hp:subList>'
      + '<hp:p><hp:run><hp:futureObject/></hp:run></hp:p></hp:subList></hp:masterPage></hp:secPr></hp:run></hp:p>' + xp('본문') }));
    expect(result.warnings).toEqual([{ code: 'masterpage-skipped', count: 1 }]);
    expect(result.markdown).toBe('\\[바탕쪽 제외\\]\n\n본문');
  });
});

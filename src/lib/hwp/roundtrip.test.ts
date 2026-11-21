import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { generateHwpx, parseHwp } from './index';
import { summarizeMarkdown } from '@/domain/hwp-roundtrip-summary';
import { IMPORT_ASSET_PREFIX } from '@/domain/hwp-assets';
import { buildHwp, buildHwpx, concat, para, picture, png, binaryTable, xp, xpic, xtable } from './parse/testing/builders';

describe('Markdown/HWPX round trip', () => {
  it('preserves headings, paragraphs, list items, table dimensions and image count', async () => {
    const markdown = '# 한글 & 제목 😀\n\n첫 문단입니다.\n\n## 두 번째 제목\n\n둘째 문단입니다.\n\n- 항목 하나\n- 항목 둘\n\n1. 순서 항목\n2. 순서 둘\n\n| 이름 | 값 |\n| --- | --- |\n| 한글 | 123 |\n| 테스트 | & |\n\n![사진](사진.png)\n';
    const generated = await generateHwpx(markdown, () => ({ bytes: png }));
    const original = generated.bytes.slice();
    const parsed = await parseHwp(generated.bytes, undefined, 'hwpx');
    expect(generated.bytes).toEqual(original);
    expect(summarizeMarkdown(parsed.markdown)).toEqual(summarizeMarkdown(markdown));
    expect(parsed.assets).toHaveLength(1); expect(parsed.assets[0].bytes).toEqual(png);
    expect(parsed.warnings).toEqual([]); expect(parsed.markdown).toContain('한글 & 제목 😀');
    const zip = await JSZip.loadAsync(generated.bytes);
    expect(await zip.file('mimetype')!.async('string')).toBe('application/hwp+zip');
    expect(new TextDecoder().decode(generated.bytes.subarray(30, 38))).toBe('mimetype');
  });
  it('exports pending import assets again without changing the original binary input', async () => {
    const bytes = buildHwp({ body: concat(para('제목', 0, 1), para('문단'), binaryTable(), picture(1)) });
    const original = bytes.slice(); const imported = await parseHwp(bytes, undefined, 'hwp');
    const generated = await generateHwpx(imported.markdown, source => {
      const asset = imported.assets.find(asset => IMPORT_ASSET_PREFIX + asset.name === source);
      return asset ? { bytes: asset.bytes, mimeType: asset.mimeType } : null;
    });
    const parsed = await parseHwp(generated.bytes);
    expect(summarizeMarkdown(parsed.markdown)).toEqual(summarizeMarkdown(imported.markdown));
    expect(bytes).toEqual(original); expect(parsed.assets[0].bytes).toEqual(png);
  });
  it('warns about unavailable and remote export pictures and preserves placeholders on reimport', async () => {
    const resolver = async () => null;
    const generated = await generateHwpx('# 제목\n\n![없음](missing.png)\n\n![외부](https://example.invalid/a.png)', resolver);
    expect(generated.warnings.map(w => w.code)).toEqual(expect.arrayContaining(['image-missing', 'image-remote']));
    const imported = await parseHwp(generated.bytes);
    expect(imported.markdown).toContain('이미지 제외'); expect(imported.assets).toHaveLength(0);
  });
  it.each(['hwp', 'hwpx'] as const)('retains %s caption text and loss placeholders through HWPX export and reimport', async format => {
    const caption = (text: string) => `<hp:caption><hp:subList>${xp(text)}</hp:subList></hp:caption>`;
    const bytes = format === 'hwp'
      ? buildHwp({ body: concat(binaryTable(false, false, 0, ['표 설명']), picture(1)) })
      : await buildHwpx({ body: `<hp:p><hp:run>${xtable().replace('<hp:tr>', caption('표 설명') + '<hp:tr>')}</hp:run></hp:p>`
        + xpic().replace('</hp:pic>', caption('그림 설명') + '</hp:pic>') });
    const original = bytes.slice(); const imported = await parseHwp(bytes, undefined, format);
    expect(imported.warnings).toContainEqual({ code: 'object-skipped', count: format === 'hwp' ? 1 : 2, detail: 'caption-layout' });
    const generated = await generateHwpx(imported.markdown, source => {
      const asset = imported.assets.find(asset => IMPORT_ASSET_PREFIX + asset.name === source);
      return asset ? { bytes: asset.bytes, mimeType: asset.mimeType } : null;
    });
    const reimported = await parseHwp(generated.bytes, undefined, 'hwpx');
    for (const text of ['표 설명', '캡션 배치 제외: 텍스트만 가져옴', ...(format === 'hwpx' ? ['그림 설명'] : [])]) {
      expect(imported.markdown).toContain(text); expect(reimported.markdown).toContain(text);
    }
    expect(summarizeMarkdown(reimported.markdown)).toEqual(summarizeMarkdown(imported.markdown));
    expect(reimported.assets).toHaveLength(1); expect(reimported.assets[0].bytes).toEqual(png);
    expect(bytes).toEqual(original);
  });
});

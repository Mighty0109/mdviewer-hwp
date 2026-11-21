import { describe, expect, it } from 'vitest';
import { escapeHwpMarkdown } from './hwp-escape';
import { detectUnsupportedSyntax } from './unsupported-syntax';
import { headingLevelForStyle, paragraphStyleFromFlags } from './hwp-style-map';
import { IMPORT_ASSET_PREFIX, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_TOTAL_IMAGES, imageFormat } from './hwp-assets';
import { summarizeMarkdown } from './hwp-roundtrip-summary';

describe('HWP domain policies', () => {
  it('escapes literal syntax without triggering source-only math, HTML, or footnotes', () => {
    for (const text of ['$a$ $b$', '[^note]', '<이름> <tag>', '\\(equation\\)', '\\[equation\\]', '1. 개요', '1) 목록', '(괄호)', '- 목록', '# 제목', '*강조* _밑줄_', '|표| ~취소~', '![그림](x)', '---\n본문']) {
      const escaped = escapeHwpMarkdown(text);
      expect(detectUnsupportedSyntax(escaped), text).toEqual([]);
      expect(escaped).not.toBe(text);
    }
  });
  it('maps only the named Korean heading styles and explicit paragraph list flags', () => {
    expect(headingLevelForStyle('제목 2')).toBe(2);
    expect(headingLevelForStyle('개요 9')).toBe(6);
    expect(headingLevelForStyle('바탕글')).toBe(0);
    expect(paragraphStyleFromFlags(2 << 23).list).toBe('ordered');
    expect(paragraphStyleFromFlags(3 << 23 | 2 << 25)).toMatchObject({ list: 'bullet', level: 2 });
  });
  it('keeps the asset contract and explicit limits', () => {
    expect(IMPORT_ASSET_PREFIX).toBe('mdviewer-import-assets/');
    expect([MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_TOTAL_IMAGES]).toEqual([8 * 1024 ** 2, 64 * 1024 ** 2, 500]);
    expect(imageFormat('A.JPEG')).toEqual({ extension: 'jpg', mimeType: 'image/jpeg' });
    expect(imageFormat('A.emf')).toBeUndefined();
  });
  it('summarizes roundtrip semantic blocks', () => {
    expect(summarizeMarkdown('# 제목\n\n첫 문단\n계속\n\n둘째 문단\n\n1. 목록\n\n| A | B |\n| --- | --- |\n| C | D |\n\n![그림](x.png)'))
      .toEqual({ headings: 1, paragraphs: 3, tables: [{ rows: 2, cols: 2 }], images: 1 });
  });
});

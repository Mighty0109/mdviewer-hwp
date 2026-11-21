import { describe, expect, it } from 'vitest';
import { detectUnsupportedSyntax, isTooLargeForRich, RICH_DOCUMENT_LIMIT } from './unsupported-syntax';

describe('lossless source routing', () => {
  it.each([
    ['---\ntitle: 한글\n---\n본문', 'frontmatter'],
    ['\uFEFF+++\r\ntitle="한글"\r\n+++', 'frontmatter'],
    ['<details><summary>한글</summary></details>', 'html'],
    ['<!-- 보존 -->', 'html'], ['<!DOCTYPE html>', 'html'], ['<custom-tag data-x="1">', 'html'],
    ['<script\n내용', 'html'], ['<details', 'html'],
    ['본문[^주]\n\n[^주]: 각주', 'footnote'],
    ['$$\nx^2\n$$', 'math'], ['인라인 $x+1$ 보존', 'math'], ['\\(x+1\\)', 'math'],
  ])('routes %s to source (%s)', (md, kind) => expect(detectUnsupportedSyntax(md)).toContain(kind));
  it('ignores code fences, inline code, escaped markers and autolinks', () => {
    const md = '```md\n---\n<!-- x -->\n[^n]: x\n$$\n```\n\n~~~\n<div> $x$\n~~~\n\n`<b> $x$ [^x]`\n\n`` ` <b> $$ ``\n\n<https://example.com> <a@example.com>\n\n\\$x\\$ \\<b> \\[\^x]';
    expect(detectUnsupportedSyntax(md)).toEqual([]);
  });
  it('recognizes longer fences and blockquote code, including an unclosed fence', () => {
    expect(detectUnsupportedSyntax('````\n```\n<html>\n````\n')).toEqual([]);
    expect(detectUnsupportedSyntax('> ```\n> <html>\n> $$\n> ```')).toEqual([]);
    expect(detectUnsupportedSyntax('~~~\n<html> $$')).toEqual([]);
  });
  it('allows plain line breaks but keeps other HTML and break attributes source-only', () => {
    expect(detectUnsupportedSyntax('| 제목 |\n| --- |\n| 첫째<br>둘째<BR />셋째 |')).toEqual([]);
    expect(detectUnsupportedSyntax('첫째<br class="x">둘째')).toContain('html');
    expect(detectUnsupportedSyntax('<br><span>내용</span>')).toContain('html');
  });
  it('uses UTF-8 bytes and only routes documents over 300KB', () => {
    expect(isTooLargeForRich('a'.repeat(RICH_DOCUMENT_LIMIT))).toBe(false);
    expect(isTooLargeForRich('가'.repeat(RICH_DOCUMENT_LIMIT / 3 + 1))).toBe(true);
    expect(detectUnsupportedSyntax('a'.repeat(RICH_DOCUMENT_LIMIT + 1))).toEqual(['too-large']);
  });
  it('returns every applicable reason in a stable order', () => {
    expect(detectUnsupportedSyntax('---\ntitle: x\n---\n<div>[^n] $x$')).toEqual(['frontmatter', 'html', 'footnote', 'math']);
  });
  it('does not mistake escaped backticks or indented list content for inert code', () => {
    expect(detectUnsupportedSyntax('\\`<b>\\`')).toContain('html');
    expect(detectUnsupportedSyntax('- item\n    <div>text</div>')).toContain('html');
    expect(detectUnsupportedSyntax('``<b>`')).toContain('html');
    expect(detectUnsupportedSyntax('    ```\n<b>\n    ```')).toContain('html');
  });
});

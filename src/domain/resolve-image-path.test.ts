import { describe, expect, it } from 'vitest';
import { resolveImagePath } from './resolve-image-path';

describe('Markdown image resolution', () => {
  const path = '/Users/홍길동/문서/readme.md';
  it('resolves relative paths, dot segments, spaces, Hangul and URL encoding', () => {
    expect(resolveImagePath('./img/한글 그림.png', path)).toBe('/Users/홍길동/문서/img/한글 그림.png');
    expect(resolveImagePath('../img/a%20b.png?raw=1#image', path)).toBe('/Users/홍길동/img/a b.png');
    expect(resolveImagePath('/tmp/img.png', path)).toBe('/tmp/img.png');
    expect(resolveImagePath('./100%.png', path)).toBe('/Users/홍길동/문서/100%.png');
  });
  it('preserves remote and embedded images and rejects unsupported schemes', () => {
    for (const source of ['https://example.com/a.png?q=1', 'http://example.com/a.png', 'data:image/png;base64,a']) {
      expect(resolveImagePath(source, path)).toBe(source);
    }
    for (const source of ['javascript:alert(1)', 'file:///etc/passwd', '//example.com/a.png', '', './%00.png']) {
      expect(resolveImagePath(source, path)).toBeNull();
    }
    expect(resolveImagePath('./a.png', 'relative.md')).toBeNull();
  });
});

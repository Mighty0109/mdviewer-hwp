import { describe, expect, it } from 'vitest';
import { rebaseRelativeImages, toDocumentRelativeSrc } from './image-src';

describe('image source preservation', () => {
  it('reverses both Tauri asset schemes while preserving ordinary Markdown spelling', () => {
    for (const src of ['asset://localhost/Users/a/img/%ED%95%9C%EA%B8%80%20a.png', 'http://asset.localhost/Users/a/img/%ED%95%9C%EA%B8%80%20a.png']) {
      expect(toDocumentRelativeSrc(src, '/Users/a/docs')).toBe('../img/%ED%95%9C%EA%B8%80%20a.png');
    }
    for (const src of ['./img/a.png', 'https://example.com/a.png', 'data:image/png;base64,x', '/img/a.png']) {
      expect(toDocumentRelativeSrc(src, '/Users/a')).toBe(src);
    }
  });
  it('rebases inline images, titles, query suffixes and reference images only', () => {
    const md = '![한글](./img/a.png "제목")\n![다른](<img/한글 그림.png>)\n![괄호](img/a(b).png?raw=1#x)\n![참조][id]\n![축약][]\n![바로]\n[id]: ./img/ref.png "참조"\n[축약]: ./short.png\n[바로]: bare.png\n[링크](./keep.md)';
    const actual = rebaseRelativeImages(md, '/docs', '/else/sub');
    expect(actual).toContain('![한글](../../docs/img/a.png "제목")');
    expect(actual).toContain('![다른](<../../docs/img/한글%20그림.png>)');
    expect(actual).toContain('![괄호](../../docs/img/a(b).png?raw=1#x)');
    expect(actual).toContain('[id]: ../../docs/img/ref.png "참조"');
    expect(actual).toContain('[축약]: ../../docs/short.png');
    expect(actual).toContain('[바로]: ../../docs/bare.png');
    expect(actual).toContain('[링크](./keep.md)');
  });
  it('does not modify code examples, absolute paths or remote URLs', () => {
    const md = '```md\n![example](./img/a.png)\n```\n`![inline](./a.png)`\n![remote](https://x/a.png)\n![absolute](/tmp/a.png)\n![data](data:image/png;base64,x)';
    expect(rebaseRelativeImages(md, '/docs', '/else')).toBe(md);
    expect(rebaseRelativeImages('![a](./a.png)', '/docs', '/docs')).toBe('![a](./a.png)');
  });
});

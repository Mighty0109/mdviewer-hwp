// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { MarkdownImage } from './markdown-image';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { applyEnvelope, detectEnvelope } from '@/domain/document-envelope';
import { htmlToMarkdown, markdownToHtml } from './markdown';

describe('Markdown reader import', () => {
  it('retains Korean headings, tables, fenced code and image paths', () => {
    const html = markdownToHtml('# 한글 제목\n\n| 이름 | 값 |\n| --- | --- |\n| 읽기 | 확인 |\n\n```rust\nfn main() {}\n```\n\n![사진](./img/한글.png)');
    expect(html).toContain('<h1>한글 제목</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code class="language-rust">');
    expect(html).toContain('src="./img/');
  });

  it('imports checked and unchecked tasks into the TipTap schema', () => {
    const html = markdownToHtml('- [x] 완료\n- [ ] 대기');
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('완료');
    expect(html).toContain('대기');
  });

  it('retains ordinary and nested lists alongside task lists', () => {
    const html = markdownToHtml('- 설명\n- [x] 완료\n  - [ ] 하위 작업\n- 마무리');
    expect(html).toContain('<ul>\n<li>설명</li>');
    expect(html.match(/data-type="taskList"/g)).toHaveLength(2);
    expect(html).toContain('하위 작업');
    expect(html).toContain('<li>마무리</li>');
  });
});

// PLAN round-trip allowance: markers/indentation, emphasis delimiters, table
// separators, fence style and blank-line runs may normalize. EOL/EOF, soft
// breaks, Hangul, code content, task state and original image sources may not.
const sampleKo = readFileSync(`${process.cwd()}/fixtures/sample-ko.md`, 'utf8');
const cases = [
  ['sample-ko', sampleKo],
  ['lists/emphasis normalization', '* 첫째\n* _둘째_\n\n> **인용**'],
  ['nested tasks', '- [x] 완료\n  - [ ] 하위\n- [ ] 대기'],
  ['mixed lists', '- 설명\n- [x] 완료\n- 끝'],
  ['tilde fence normalization', '~~~rust\nfn main() {\n    println!("한글");\n}\n~~~\n'],
  ['long code fences', '````md\n```js\nconst x = 1;\n```\n````\n'],
  ['table alignment', '| 왼쪽 | 오른쪽 |\n| :--- | ---: |\n| 한글 | 코드 |\n'],
  ['soft breaks and CRLF', '# 제목\r\n\r\n한 줄\r\n다음 줄\r\n'],
  ['image title/path', '![한글](./img/한글.png "설명")\n'],
];

function normalizedHtml(md: string) {
  const root = new DOMParser().parseFromString(markdownToHtml(md), 'text/html');
  // Tight/loose list paragraphs have the same meaning for this policy.
  for (const p of root.querySelectorAll('li > div > p, li > p')) p.replaceWith(...p.childNodes);
  for (const block of root.querySelectorAll('li, li > div')) {
    for (const child of block.childNodes) if (child.nodeType === 3) child.textContent = child.textContent?.trim() || '';
  }
  return root.body.innerHTML.replace(/>\s+</g, '><').trim();
}

describe('Markdown round-trip policy', () => {
  it.each(cases)('preserves rendered meaning and is idempotent: %s', (_name, md) => {
    const envelope = detectEnvelope(md);
    const once = applyEnvelope(htmlToMarkdown(markdownToHtml(md)), envelope);
    const twice = applyEnvelope(htmlToMarkdown(markdownToHtml(once)), envelope);
    expect(normalizedHtml(once)).toBe(normalizedHtml(md));
    expect(twice).toBe(once);
    expect(once.endsWith(envelope.eol)).toBe(envelope.trailingNewline);
  });
  it('keeps task state in Markdown syntax and soft line breaks without hard-break spaces', () => {
    expect(htmlToMarkdown(markdownToHtml('- [x] 완료\n- [ ] 대기'))).toBe('- [x] 완료\n- [ ] 대기');
    expect(htmlToMarkdown(markdownToHtml('한 줄\n다음 줄'))).toBe('한 줄\n다음 줄');
  });
  it('prefers original image source and reverses asset URLs for newly inserted images', () => {
    expect(htmlToMarkdown('<img src="http://asset.localhost/tmp/img/a.png" data-md-src="./img/a.png" alt="한글">', '/tmp')).toBe('![한글](./img/a.png)');
    expect(htmlToMarkdown('<img src="asset://localhost/tmp/img/a.png" alt="한글">', '/tmp')).toBe('![한글](img/a.png)');
  });
  it('preserves sample-ko blocks through the actual TipTap schema and serialization', () => {
    const editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell, MarkdownImage, TaskList, TaskItem.configure({ nested: true })],
      content: markdownToHtml(sampleKo),
    });
    try {
      const once = applyEnvelope(htmlToMarkdown(editor.getHTML()), detectEnvelope(sampleKo));
      expect(normalizedHtml(once)).toBe(normalizedHtml(sampleKo));
      editor.commands.setContent(markdownToHtml(once));
      expect(applyEnvelope(htmlToMarkdown(editor.getHTML()), detectEnvelope(sampleKo))).toBe(once);
    } finally { editor.destroy(); }
  });
  it('preserves a resolved Korean image destination through the TipTap node attributes', () => {
    const editor = new Editor({ extensions: [StarterKit, MarkdownImage], content: '<img src="asset://localhost/tmp/img/%ED%95%9C%EA%B8%80.png" data-md-src="./img/한글.png" alt="한글">' });
    try { expect(htmlToMarkdown(editor.getHTML())).toBe('![한글](./img/한글.png)'); }
    finally { editor.destroy(); }
  });
  it('preserves table cell line breaks through TipTap, edits and serialization', () => {
    const md = '| 제목 |\n| --- |\n| **첫째**<br>둘째<br>셋째 |\n';
    const editor = new Editor({ extensions: [StarterKit, Table, TableRow, TableHeader, TableCell], content: markdownToHtml(md) });
    try {
      editor.commands.insertContentAt(1, '수정');
      const saved = htmlToMarkdown(editor.getHTML());
      expect(saved).toContain('**첫째**<br>둘째<br>셋째');
      expect(normalizedHtml(saved)).toContain('첫째</strong><br>둘째<br>셋째');
      editor.commands.setContent(markdownToHtml(saved));
      expect(htmlToMarkdown(editor.getHTML())).toBe(saved);
    } finally { editor.destroy(); }
  });
});

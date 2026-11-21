import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import { markedMathExtension, markedFootnoteExtension, markedTaskListExtension } from './marked-extensions';
import { toDocumentRelativeSrc } from '@/domain/image-src';

let turndownInstance: TurndownService | null = null;

function getTurndownService(): TurndownService {
  if (turndownInstance) return turndownInstance;

  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  service.use(gfm);
  // TipTap emits a colgroup before tbody; GFM's first-tbody heuristic otherwise
  // keeps the entire table as raw HTML. Serialize rows from their actual table.
  service.remove('colgroup');
  service.addRule('editorTableCell', {
    filter: ['th', 'td'],
    replacement: (content) => ` ${content.trim().replace(/\n+/g, '<br>').replace(/(?<!\\)\|/g, '\\|')} |`,
  });
  service.addRule('editorTableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const row = node as HTMLTableRowElement;
      const table = row.closest('table');
      const heading = row === table?.rows[0];
      const border = heading ? `\n|${Array.from(row.cells, (cell) => {
        const align = cell.getAttribute('align') || cell.style.textAlign;
        return ` ${align === 'left' ? ':---' : align === 'right' ? '---:' : align === 'center' ? ':---:' : '---'} |`;
      }).join('')}` : '';
      return `\n|${content}${border}`;
    },
  });
  service.addRule('editorTable', { filter: 'table', replacement: (content) => `\n\n${content.trim()}\n\n` });

  service.addRule('softBreak', {
    filter: 'br',
    replacement: (_content, node) => (node as HTMLElement).closest('td, th') ? '<br>' : '\n',
  });
  // TaskItem's label is UI chrome; checked state belongs to the li attribute.
  service.addRule('taskCheckbox', {
    filter: (node) => node.nodeName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox',
    replacement: () => '',
  });
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const item = node as HTMLElement;
      const parent = item.parentElement;
      const ordered = parent?.nodeName === 'OL';
      const start = Number(parent?.getAttribute('start') || '1');
      const index = parent ? Array.from(parent.children).indexOf(item) : 0;
      const prefix = ordered ? `${start + index}. ` : '- ';
      return prefix + content.replace(/^\n+/, '').trimEnd().replace(/\n/g, '\n' + ' '.repeat(prefix.length)) + '\n';
    },
  });
  service.addRule('taskItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
      return `- [${checked ? 'x' : ' '}] ${content.trim().replace(/\n/g, '\n    ')}\n`;
    },
  });
  // A code block containing ``` needs a longer outer fence to remain one block.
  service.addRule('safeCodeFence', {
    filter: (node) => node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE',
    replacement: (_content, node) => {
      const code = (node as HTMLElement).querySelector('code')!;
      const text = (code.textContent || '').replace(/\n$/, '');
      const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      const language = code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1] || '';
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });

  // Underline -> custom marker
  service.addRule('underline', {
    filter: ['u'],
    replacement: (content) => `<u>${content}</u>`,
  });

  // Superscript (exclude footnote refs)
  service.addRule('superscript', {
    filter: (node) => {
      return node.nodeName === 'SUP' && !node.classList.contains('footnote-ref');
    },
    replacement: (content) => `<sup>${content}</sup>`,
  });

  // Subscript
  service.addRule('subscript', {
    filter: ['sub'],
    replacement: (content) => `<sub>${content}</sub>`,
  });

  // Highlight / mark
  service.addRule('highlight', {
    filter: ['mark'],
    replacement: (content) => `==${content}==`,
  });

  // Math inline: <span class="math-inline" data-math="...">
  service.addRule('mathInline', {
    filter: (node) => {
      return node.nodeName === 'SPAN' && node.classList.contains('math-inline');
    },
    replacement: (_content, node) => {
      const math = (node as HTMLElement).getAttribute('data-math') || '';
      return `$${math}$`;
    },
  });

  // Math block: <div class="math-block" data-math="...">
  service.addRule('mathBlock', {
    filter: (node) => {
      return node.nodeName === 'DIV' && node.classList.contains('math-block');
    },
    replacement: (_content, node) => {
      const math = (node as HTMLElement).getAttribute('data-math') || '';
      return `\n\n$$\n${math}\n$$\n\n`;
    },
  });

  // Footnote ref: <sup class="footnote-ref"><a ...>[n]</a></sup>
  service.addRule('footnoteRef', {
    filter: (node) => {
      return node.nodeName === 'SUP' && node.classList.contains('footnote-ref');
    },
    replacement: (_content, node) => {
      const link = (node as HTMLElement).querySelector('a');
      const text = link?.textContent || '';
      // Extract ID from [n] format
      const id = text.replace(/[\[\]]/g, '');
      return `[^${id}]`;
    },
  });

  // Footnote section
  service.addRule('footnoteSection', {
    filter: (node) => {
      return node.nodeName === 'SECTION' && node.classList.contains('footnotes');
    },
    replacement: (_content, node) => {
      const items = (node as HTMLElement).querySelectorAll('li');
      let result = '\n';
      items.forEach((li) => {
        const id = li.id.replace('fn-', '');
        // Get text content without the backref link
        const p = li.querySelector('p');
        if (p) {
          const backref = p.querySelector('.footnote-backref');
          if (backref) backref.remove();
          result += `[^${id}]: ${p.textContent?.trim() || ''}\n`;
        }
      });
      return result;
    },
  });

  turndownInstance = service;
  return service;
}

export function htmlToMarkdown(html: string, docDir = ''): string {
  if (!html || html === '<p></p>') return '';

  const service = getTurndownService();
  service.addRule('documentImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const image = node as HTMLElement;
      const src = image.getAttribute('data-md-src') ?? toDocumentRelativeSrc(image.getAttribute('src') || '', docDir);
      const alt = (image.getAttribute('alt') || '').replace(/[\[\]\\]/g, '\\$&');
      const title = image.getAttribute('title');
      const destination = /[\s()]/.test(src) ? `<${src}>` : src;
      return `![${alt}](${destination}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    },
  });
  return service.turndown(html);
}

let markedConfigured = false;

function ensureMarkedConfigured(): void {
  if (markedConfigured) return;

  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  marked.use(markedMathExtension());
  marked.use(markedFootnoteExtension());
  marked.use(markedTaskListExtension());

  markedConfigured = true;
}

export function markdownToHtml(md: string): string {
  if (!md) return '';

  ensureMarkedConfigured();
  const result = marked.parse(md, { async: false });

  return result;
}

// =============================================
// Worker-based async API (non-blocking)
// =============================================

let mdWorker: Worker | null = null;
let msgIdCounter = 0;
const pendingCallbacks = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

function getMarkdownWorker(): Worker {
  if (mdWorker) return mdWorker;

  mdWorker = new Worker(
    new URL('../workers/markdown.worker.ts', import.meta.url)
  );

  mdWorker.onmessage = (e: MessageEvent) => {
    const { id, type, result, error } = e.data;
    const cb = pendingCallbacks.get(id);
    if (!cb) return;
    pendingCallbacks.delete(id);

    if (type === 'error') {
      cb.reject(new Error(error));
    } else {
      cb.resolve(result);
    }
  };

  mdWorker.onerror = (event) => {
    const error = new Error(event.message || '마크다운 변환 워커를 시작할 수 없습니다.');
    for (const callback of pendingCallbacks.values()) callback.reject(error);
    pendingCallbacks.clear();
    mdWorker?.terminate();
    mdWorker = null;
  };

  return mdWorker;
}

/** Non-blocking markdown → HTML conversion via Web Worker */
export function markdownToHtmlAsync(md: string): Promise<string> {
  if (!md) return Promise.resolve('');

  return new Promise((resolve, reject) => {
    // Constructor errors must reject without leaving an orphaned callback.
    const worker = getMarkdownWorker();
    const id = ++msgIdCounter;
    pendingCallbacks.set(id, { resolve, reject });
    worker.postMessage({ type: 'toHtml', id, markdown: md });
  });
}

/**
 * HTML → markdown runs on main thread (Turndown requires DOM).
 * Wrapped as async for API consistency.
 */
export function htmlToMarkdownAsync(html: string): Promise<string> {
  return Promise.resolve(htmlToMarkdown(html));
}

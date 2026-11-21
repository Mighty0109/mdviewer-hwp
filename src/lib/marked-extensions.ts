/**
 * marked extensions for math (KaTeX) and footnotes
 */
import { Renderer, type MarkedExtension, type Tokens } from 'marked';
import katex from 'katex';

function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    });
  } catch {
    return `<code>${latex}</code>`;
  }
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shared by the main thread and worker: preserve editor metadata on import. */
export function markedTaskListExtension(): MarkedExtension {
  return {
    renderer: {
      image(token) {
        // Marked percent-encodes src. Keep its rendering but retain the original
        // Markdown destination (including Hangul/escapes) for saving.
        return Renderer.prototype.image.call(this, token).replace(/^<img /, `<img data-md-src="${escapeAttr(token.href)}" `);
      },
      list(token) {
        if (!token.items.some((item) => item.task)) return false;
        let html = '';
        let offset = 0;
        while (offset < token.items.length) {
          const task = token.items[offset].task;
          let end = offset + 1;
          while (end < token.items.length && token.items[end].task === task) end++;
          const tag = !task && token.ordered ? 'ol' : 'ul';
          const attrs = task ? ' data-type="taskList"' :
            token.ordered ? ` start="${Number(token.start) + offset}"` : '';
          html += `<${tag}${attrs}>\n`;
          for (const item of token.items.slice(offset, end)) html += this.listitem(item);
          html += `</${tag}>\n`;
          offset = end;
        }
        return html;
      },
      listitem(item) {
        if (!item.task) return false;
        const checked = Boolean(item.checked);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox" disabled${checked ? ' checked' : ''}><span></span></label><div>${this.parser.parse(item.tokens)}</div></li>\n`;
      },
      // The checkbox belongs in the label above, never in the task paragraph.
      checkbox() { return ''; },
    },
  };
}

// ============================================
// Math Extension (inline $...$ and block $$...$$)
// ============================================

export function markedMathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src: string) {
          return src.indexOf('$$');
        },
        tokenizer(src: string) {
          const match = src.match(/^\$\$([\s\S]+?)\$\$/);
          if (match) {
            return {
              type: 'mathBlock',
              raw: match[0],
              text: match[1].trim(),
            };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          const rendered = renderKatex(token.text, true);
          return `<div class="math-block" data-math="${escapeAttr(token.text)}">${rendered}</div>\n`;
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src: string) {
          return src.indexOf('$');
        },
        tokenizer(src: string) {
          const match = src.match(/^\$([^\$\n]+?)\$/);
          if (match) {
            return {
              type: 'mathInline',
              raw: match[0],
              text: match[1].trim(),
            };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          const rendered = renderKatex(token.text, false);
          return `<span class="math-inline" data-math="${escapeAttr(token.text)}">${rendered}</span>`;
        },
      },
    ],
  };
}

// ============================================
// Footnote Extension
// ============================================

export function markedFootnoteExtension(): MarkedExtension {
  const footnoteDefinitions = new Map<string, string>();

  return {
    extensions: [
      {
        name: 'footnoteDef',
        level: 'block',
        start(src: string) {
          return src.match(/^\[\^/)?.index;
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\^([^\]]+)\]:\s+([\s\S]+?)(?=\n\[\^|\n\n|\n$|$)/);
          if (match) {
            footnoteDefinitions.set(match[1], match[2].trim());
            return {
              type: 'footnoteDef',
              raw: match[0],
              id: match[1],
              text: match[2].trim(),
            };
          }
          return undefined;
        },
        renderer() {
          return '';
        },
      },
      {
        name: 'footnoteRef',
        level: 'inline',
        start(src: string) {
          return src.match(/\[\^/)?.index;
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\^([^\]]+)\]/);
          if (match) {
            const afterMatch = src.slice(match[0].length);
            if (afterMatch.startsWith(':')) return undefined;
            return {
              type: 'footnoteRef',
              raw: match[0],
              id: match[1],
            };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          return `<sup class="footnote-ref"><a href="#fn-${token.id}" id="fnref-${token.id}">[${token.id}]</a></sup>`;
        },
      },
    ],
    hooks: {
      postprocess(html: string) {
        if (footnoteDefinitions.size === 0) return html;

        let footnotesHtml = '<section class="footnotes"><hr><ol>';
        footnoteDefinitions.forEach((text, id) => {
          footnotesHtml += `<li id="fn-${id}"><p>${text} <a href="#fnref-${id}" class="footnote-backref">↩</a></p></li>`;
        });
        footnotesHtml += '</ol></section>';

        footnoteDefinitions.clear();

        return html + footnotesHtml;
      },
    },
  };
}

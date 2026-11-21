import { Image } from '@tiptap/extension-image';

/** Keep the Markdown destination separate from the resolved display URL. */
export const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mdSrc: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-md-src') ?? element.getAttribute('src'),
        renderHTML: (attrs: Record<string, unknown>) => attrs.mdSrc == null ? {} : { 'data-md-src': attrs.mdSrc },
      },
    };
  },
}).configure({ allowBase64: true });

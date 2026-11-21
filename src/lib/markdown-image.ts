import { Image } from '@tiptap/extension-image';

/** Use in the rich editor so asset URL resolution never replaces a Markdown destination. */
export const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mdSrc: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-md-src'),
        renderHTML: (attributes: Record<string, unknown>) => attributes.mdSrc == null ? {} : { 'data-md-src': attributes.mdSrc },
      },
    };
  },
});

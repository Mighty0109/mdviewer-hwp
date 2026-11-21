import { Extension } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findSearchMatches, type SearchMatch } from '@/domain/search';

export function documentSearchMatches(doc: Node, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    // Marks (bold, links, etc.) do not interrupt a phrase. Inline atoms occupy
    // one UTF-16 offset, exactly as they do in ProseMirror positions.
    const text = node.textBetween(0, node.content.size, '', '\ufffc');
    for (const match of findSearchMatches(text, query)) {
      matches.push({ from: pos + 1 + match.from, to: pos + 1 + match.to });
    }
    return false;
  });
  return matches;
}

interface SearchDecorationState { query: string; active: number; decorations: DecorationSet }
export const docSearchKey = new PluginKey<SearchDecorationState>('docSearch');

export function createDocSearchPlugin() {
  return new Plugin<SearchDecorationState>({
    key: docSearchKey,
    state: {
      init: () => ({ query: '', active: 0, decorations: DecorationSet.empty }),
      apply(transaction, previous) {
        const meta = transaction.getMeta(docSearchKey) as { query: string; active: number } | undefined;
        if (!meta && !transaction.docChanged) return previous;
        const { query, active } = meta || previous;
        const matches = documentSearchMatches(transaction.doc, query);
        return { query, active, decorations: DecorationSet.create(transaction.doc,
          matches.map(({ from, to }, index) => Decoration.inline(from, to, {
            class: index === active ? 'doc-search-match doc-search-active' : 'doc-search-match',
            'data-search-match': String(index),
          }))),
        };
      },
    },
    props: { decorations: (state) => docSearchKey.getState(state)?.decorations },
  });
}

/** Decorations do not create highlight marks, edits, or undo history entries. */
export const DocSearch = Extension.create({
  name: 'docSearch',
  addProseMirrorPlugins: () => [createDocSearchPlugin()],
});

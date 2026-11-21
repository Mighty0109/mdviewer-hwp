import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { SlashCommandItem } from '@/types/editor';
import { SLASH_COMMANDS } from '@/lib/constants';

type Range = { from: number; to: number };
export interface SlashCommandStorage {
  query: string;
  active: boolean;
  range: Range | null;
  imageRange: Range | null;
  decorationPosition: { top: number; left: number } | null;
  filteredItems: SlashCommandItem[];
  selectedIndex: number;
}
declare module '@tiptap/core' {
  interface Storage { slashCommand: SlashCommandStorage }
}

interface SlashMeta { index?: number; dismiss?: boolean; image?: Range | null }
export const slashCommandKey = new PluginKey('slashCommand');

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const lower = query.toLowerCase();
  // Math needs the lossless source editor; never synthesize it through this schema.
  return SLASH_COMMANDS.filter((item) => item.command !== 'math' &&
    [item.label, item.command, item.description, ...(item.aliases || [])].some((value) => value.toLowerCase().includes(lower)));
}

export function executeSlashCommand(editor: Editor, command: string, range: Range) {
  if (command === 'image') {
    editor.view.dispatch(editor.state.tr.setMeta(slashCommandKey, { dismiss: true, image: range }));
    return;
  }
  const chain = editor.chain().focus().deleteRange(range);
  switch (command) {
    case 'heading1': return chain.setNode('heading', { level: 1 }).run();
    case 'heading2': return chain.setNode('heading', { level: 2 }).run();
    case 'heading3': return chain.setNode('heading', { level: 3 }).run();
    case 'bulletList': return chain.toggleBulletList().run();
    case 'orderedList': return chain.toggleOrderedList().run();
    case 'taskList': return chain.toggleTaskList().run();
    case 'blockquote': return chain.toggleBlockquote().run();
    case 'horizontalRule': return chain.setHorizontalRule().run();
    case 'codeBlock': return chain.setCodeBlock().run();
    case 'table': return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case 'mermaid': return chain.setCodeBlock({ language: 'mermaid' }).run();
    default: return false;
  }
}

function matchSlash(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') return null;
  // Only a command at the start of a paragraph; URLs and ordinary prose stay text.
  const match = $from.parent.textBetween(0, $from.parentOffset).match(/^\/([^\s/]*)$/);
  return match ? { query: match[1], from: $from.pos - match[0].length, to: $from.pos } : null;
}

export const SlashCommand = Extension.create<object, SlashCommandStorage>({
  name: 'slashCommand',
  addStorage: () => ({ query: '', active: false, range: null, imageRange: null,
    decorationPosition: null, filteredItems: filterSlashCommands(''), selectedIndex: 0 }),
  addProseMirrorPlugins() {
    const storage = this.storage;
    let signature = '';
    let dismissed = '';
    return [new Plugin({
      key: slashCommandKey,
      state: {
        init: () => null,
        apply: (tr, value, _old, state) => {
          const meta = tr.getMeta(slashCommandKey) as SlashMeta | undefined;
          const match = matchSlash(state);
          const next = match ? `${match.from}:${match.to}:${match.query}` : '';
          if (next !== signature) { storage.selectedIndex = 0; dismissed = ''; }
          signature = next;
          if (storage.imageRange && tr.docChanged) {
            storage.imageRange = { from: tr.mapping.map(storage.imageRange.from), to: tr.mapping.map(storage.imageRange.to) };
          }
          if (meta?.dismiss) dismissed = next;
          if (meta && 'image' in meta) storage.imageRange = meta.image ?? null;
          storage.query = match?.query || '';
          storage.range = match ? { from: match.from, to: match.to } : null;
          storage.filteredItems = filterSlashCommands(storage.query);
          storage.active = !!match && next !== dismissed && !storage.imageRange;
          storage.selectedIndex = Math.max(0, Math.min(meta?.index ?? storage.selectedIndex, storage.filteredItems.length - 1));
          return value;
        },
      },
      props: {
        handleKeyDown: (view, event) => {
          if (!storage.active || event.isComposing || view.composing || event.keyCode === 229) return false;
          if (event.key === 'Escape') {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(slashCommandKey, { dismiss: true }));
            return true;
          }
          if (!storage.filteredItems.length) return false;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(slashCommandKey, { index: storage.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) }));
            return true;
          }
          if (event.key === 'Enter' && storage.range) {
            event.preventDefault();
            executeSlashCommand(this.editor, storage.filteredItems[storage.selectedIndex].command, storage.range);
            return true;
          }
          return false;
        },
      },
      view: () => ({
        update(view) {
          if (!storage.active || !storage.range) { storage.decorationPosition = null; return; }
          try {
            const coords = view.coordsAtPos(storage.range.from);
            const rect = (view.dom.closest('.editor-wrapper') || view.dom).getBoundingClientRect();
            storage.decorationPosition = { top: coords.bottom - rect.top + 4, left: Math.max(0, coords.left - rect.left) };
          } catch {
            // A DOM without layout (unit tests) has no caret rectangles.
            storage.decorationPosition = { top: 0, left: 0 };
          }
        },
      }),
    })];
  },
});

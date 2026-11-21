import { Fragment } from '@tiptap/pm/model';
import { Selection, type EditorState, type Transaction } from '@tiptap/pm/state';

/**
 * Move one top-level node to a boundary in the ORIGINAL document (0..childCount).
 * Boundaries immediately before/after the source are no-ops. Nothing is mutated
 * or dispatched; the caller may dispatch the returned single undoable transaction.
 */
export function moveBlock(state: EditorState, fromIndex: number, dropIndex: number): Transaction | null {
  const { doc, selection } = state;
  if (!Number.isInteger(fromIndex) || !Number.isInteger(dropIndex)
    || fromIndex < 0 || fromIndex >= doc.childCount
    || dropIndex < 0 || dropIndex > doc.childCount
    || dropIndex === fromIndex || dropIndex === fromIndex + 1) return null;

  const nodes = Array.from({ length: doc.childCount }, (_, i) => doc.child(i));
  const block = nodes[fromIndex];
  const from = nodes.slice(0, fromIndex).reduce((pos, node) => pos + node.nodeSize, 0);
  const boundary = nodes.slice(0, dropIndex).reduce((pos, node) => pos + node.nodeSize, 0);
  const insertAt = boundary > from ? boundary - block.nodeSize : boundary;
  nodes.splice(fromIndex, 1);
  nodes.splice(dropIndex > fromIndex ? dropIndex - 1 : dropIndex, 0, block);
  const expected = Fragment.fromArray(nodes);
  if (!doc.type.validContent(expected)) return null;

  const tr = state.tr.delete(from, from + block.nodeSize).insert(insertAt, block);
  // A constrained schema can insert filler nodes during deletion. Never accept
  // an unexpected document, even when the final intended order was valid.
  if (!tr.doc.content.eq(expected)) return null;

  if (selection.from >= from && selection.to <= from + block.nodeSize) {
    // Preserve text, node, and registered custom selections (e.g. table cells)
    // inside the moved block rather than letting deletion collapse the cursor.
    const json = selection.toJSON();
    if (typeof json.anchor === 'number') {
      const offset = insertAt - from;
      tr.setSelection(Selection.fromJSON(tr.doc, {
        ...json, anchor: json.anchor + offset,
        ...(typeof json.head === 'number' ? { head: json.head + offset } : {}),
      }));
    }
  }
  return tr;
}

/** Return an insertion boundary (0..rects.length), using viewport/client Y. */
export function dropIndexFromY(y: number, rects: readonly { top: number; bottom: number }[]): number {
  const index = rects.findIndex(({ top, bottom }) => y < top + (bottom - top) / 2);
  return index === -1 ? rects.length : index;
}

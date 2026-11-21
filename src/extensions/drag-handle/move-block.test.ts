import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { dropIndexFromY, moveBlock } from './move-block';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: null } } },
    bulletList: { group: 'block', content: 'listItem+' },
    taskList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*', attrs: { checked: { default: false } } },
    blockquote: { group: 'block', content: 'block+' },
    codeBlock: { group: 'block', content: 'text*', code: true, attrs: { language: { default: null } } },
    table: { group: 'block', content: 'row+' },
    row: { content: 'cell+' },
    cell: { content: 'block+' },
    image: { group: 'block', atom: true, attrs: { src: {}, mdSrc: {}, alt: { default: null } } },
  },
  marks: { bold: {} },
});
const paragraph = (text: string) => schema.node('paragraph', null, schema.text(text));
const doc = () => schema.node('doc', null, [paragraph('하나'), paragraph('둘'), paragraph('셋')]);
const state = () => EditorState.create({ doc: doc(), plugins: [history()] });

describe('moveBlock', () => {
  it('moves to original-document boundaries in both directions, including first/last', () => {
    const original = state();
    expect(moveBlock(original, 0, 3)!.doc.textContent).toBe('둘셋하나');
    expect(moveBlock(original, 2, 0)!.doc.textContent).toBe('셋하나둘');
    expect(moveBlock(original, 0, 2)!.doc.textContent).toBe('둘하나셋');
    expect(moveBlock(original, 2, 1)!.doc.textContent).toBe('하나셋둘');
    expect(original.doc.eq(doc())).toBe(true);
  });

  it.each([[0, 0], [0, 1], [2, 2], [2, 3], [-1, 0], [3, 0], [0, -1], [0, 4], [0.5, 2], [0, NaN]])(
    'rejects no-op or invalid indices (%s, %s)', (from, to) => {
      expect(moveBlock(state(), from, to)).toBeNull();
    },
  );

  it('keeps an empty document and a single block unchanged', () => {
    const original = EditorState.create({ schema });
    expect(moveBlock(original, 0, 1)).toBeNull();
  });

  const richBlocks = [
    schema.node('heading', { level: 2, id: '한글-제목' }, schema.text('진한 제목', [schema.mark('bold')])),
    schema.node('bulletList', null, schema.node('listItem', null, [paragraph('목록'), schema.node('bulletList', null,
      schema.node('listItem', null, paragraph('중첩')))])),
    schema.node('taskList', null, schema.node('listItem', { checked: true }, paragraph('완료'))),
    schema.node('codeBlock', { language: 'rust' }, schema.text('fn main() {\n  println!("한글");\n}\n')),
    schema.node('table', null, schema.node('row', null, schema.node('cell', null, paragraph('표 내용')))),
    schema.node('blockquote', null, paragraph('인용 내용')),
    schema.node('image', { src: 'asset://localhost/tmp/img.png', mdSrc: './img/한글.png', alt: '그림' }),
  ];
  it.each(richBlocks.map((block) => [block.type.name, block] as const))(
    'moves a complete %s without changing nested content, marks, or attributes', (_, block) => {
      const original = EditorState.create({ doc: schema.node('doc', null, [paragraph('앞'), block, paragraph('뒤')]) });
      const tr = moveBlock(original, 1, 3)!;
      expect(tr.doc.lastChild!.toJSON()).toEqual(block.toJSON());
      expect(tr.doc.childCount).toBe(3);
    },
  );

  it('preserves the direction and offsets of a text selection within a moved block', () => {
    const original = EditorState.create({ doc: doc(), selection: TextSelection.create(doc(), 3, 1) });
    const tr = moveBlock(original, 0, 3)!;
    expect(tr.selection.anchor).toBe(9);
    expect(tr.selection.head).toBe(7);
    expect(tr.doc.textBetween(tr.selection.from, tr.selection.to)).toBe('하나');
  });

  it('preserves a selected nested list item and an image node selection', () => {
    const listDoc = schema.node('doc', null, [richBlocks[1], paragraph('뒤')]);
    const selected = NodeSelection.create(listDoc, 1);
    const tr = moveBlock(EditorState.create({ doc: listDoc, selection: selected }), 0, 2)!;
    expect(tr.selection).toBeInstanceOf(NodeSelection);
    expect((tr.selection as NodeSelection).node.toJSON()).toEqual(selected.node.toJSON());
    const imageDoc = schema.node('doc', null, [richBlocks[6], paragraph('뒤')]);
    const imageTr = moveBlock(EditorState.create({ doc: imageDoc, selection: NodeSelection.create(imageDoc, 0) }), 0, 2)!;
    expect((imageTr.selection as NodeSelection).node.eq(richBlocks[6])).toBe(true);
    expect(imageTr.selection.from).toBe(paragraph('뒤').nodeSize);
  });

  it('keeps a cursor in an untouched block with the same text offset', () => {
    const original = EditorState.create({ doc: doc(), selection: TextSelection.create(doc(), 5) });
    const tr = moveBlock(original, 0, 3)!;
    expect(tr.selection.$from.parent.textContent).toBe('둘');
    expect(tr.selection.$from.parentOffset).toBe(0);
  });

  it('undoes the entire move in one history operation', () => {
    const original = state();
    let moved = original.apply(moveBlock(original, 0, 3)!);
    expect(undo(moved, (tr) => { moved = moved.apply(tr); })).toBe(true);
    expect(moved.doc.eq(original.doc)).toBe(true);
    expect(moved.selection.eq(original.selection)).toBe(true);
  });

  it('rejects a reorder that violates the document schema', () => {
    const constrained = new Schema({ nodes: {
      doc: { content: 'heading paragraph+' },
      heading: { content: 'text*' }, paragraph: { content: 'text*' }, text: {},
    } });
    const original = EditorState.create({ doc: constrained.node('doc', null, [constrained.node('heading'), constrained.node('paragraph')]) });
    expect(moveBlock(original, 0, 2)).toBeNull();
  });
});

describe('dropIndexFromY', () => {
  const rects = [{ top: 10, bottom: 30 }, { top: 50, bottom: 150 }, { top: 170, bottom: 190 }];
  it.each([[-100, 0], [19, 0], [20, 1], [40, 1], [99, 1], [100, 2], [160, 2], [180, 3], [900, 3]])(
    'maps client Y %s to boundary %s using block midpoints', (y, index) => {
      expect(dropIndexFromY(y, rects)).toBe(index);
    },
  );
  it('handles no blocks without inventing a document index', () => {
    expect(dropIndexFromY(30, [])).toBe(0);
  });
});

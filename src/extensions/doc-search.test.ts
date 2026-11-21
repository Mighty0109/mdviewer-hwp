import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { createDocSearchPlugin, docSearchKey, documentSearchMatches } from './doc-search';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' }, paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }, image: { inline: true, group: 'inline' },
  },
  marks: { bold: {} },
});

describe('TipTap search decorations', () => {
  it('finds a phrase across marks and keeps original document positions', () => {
    const nfd = '한글'.normalize('NFD');
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('읽는 '), schema.text(nfd, [schema.mark('bold')]), schema.text(' 문서')]),
      schema.node('paragraph', null, schema.text('한글 문서')),
    ]);
    const matches = documentSearchMatches(doc, '한글 문서');
    expect(matches).toHaveLength(2);
    expect(matches.map(({ from, to }) => doc.textBetween(from, to))).toEqual([`${nfd} 문서`, '한글 문서']);
  });
  it('accounts for inline atoms and does not join separate paragraphs', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('앞'), schema.node('image'), schema.text('뒤')]),
      schema.node('paragraph', null, schema.text('다음')),
    ]);
    expect(documentSearchMatches(doc, '뒤')).toEqual([{ from: 3, to: 4 }]);
    expect(documentSearchMatches(doc, '뒤다음')).toEqual([]);
  });
  it('adds active/all decorations without changing document content and refreshes after reload', () => {
    let state = EditorState.create({
      schema, doc: schema.node('doc', null, schema.node('paragraph', null, schema.text('한글 한글'))),
      plugins: [createDocSearchPlugin()],
    });
    const original = state.doc.toJSON();
    state = state.apply(state.tr.setMeta(docSearchKey, { query: '한글', active: 1 }));
    const decorations = docSearchKey.getState(state)!.decorations.find();
    expect(decorations).toHaveLength(2);
    expect(state.doc.toJSON()).toEqual(original);
    state = state.apply(state.tr.insertText(' 문서', 6));
    expect(docSearchKey.getState(state)!.decorations.find()).toHaveLength(2);
    state = state.apply(state.tr.setMeta(docSearchKey, { query: '', active: 0 }));
    expect(docSearchKey.getState(state)!.decorations.find()).toEqual([]);
  });
});

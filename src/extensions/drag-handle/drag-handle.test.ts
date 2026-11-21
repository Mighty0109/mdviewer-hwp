// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragHandle } from './index';

describe('DragHandle integration', () => {
  let editor: Editor;
  let element: HTMLDivElement;
  beforeEach(() => {
    element = document.createElement('div');
    document.body.append(element);
    // jsdom has no text layout; suppress scrolling while retaining real DOM
    // events, ProseMirror transactions, keyboard routing, and undo history.
    editor = new Editor({
      element, extensions: [StarterKit, DragHandle], content: '<p>하나</p><p>둘</p><p>셋</p>',
      editorProps: { handleScrollToSelection: () => true },
    });
    setRects();
  });
  afterEach(() => {
    editor.destroy();
    element.remove();
    vi.restoreAllMocks();
  });

  function setRects() {
    [...editor.view.dom.children].forEach((node, index) => {
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
        top: 100 + index * 100, bottom: 150 + index * 100,
        left: 100, right: 600, width: 500, height: 50, x: 100, y: 100 + index * 100,
        toJSON: () => ({}),
      });
    });
  }
  function mouse(target: EventTarget, type: string, y: number, x = 110) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y }));
  }
  function button() { return document.querySelector<HTMLButtonElement>('.md-block-handle')!; }
  function hoverFirst() { mouse(editor.view.dom.firstElementChild!, 'mousemove', 110); }
  function startDrag() {
    hoverFirst();
    mouse(button(), 'mousedown', 110, 80);
    mouse(document, 'mousemove', 400, 110);
  }
  function shortcut(key: string) {
    return editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: key, altKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
  }

  it('exposes an accessible hover widget without putting UI in serialized content', () => {
    expect(button().hidden).toBe(true);
    hoverFirst();
    expect(button().hidden).toBe(false);
    expect(button().getAttribute('aria-label')).toBe('블록 이동');
    expect(button().style.left).toBe('72px');
    expect(button().style.top).toBe('100px');
    expect(editor.getHTML()).toBe('<p>하나</p><p>둘</p><p>셋</p>');
    expect(editor.view.dom.querySelector('button')).toBeNull();
    mouse(document, 'mousemove', 110, 90);
    expect(button().hidden).toBe(false);
    mouse(document, 'mousemove', 20, 10);
    expect(button().hidden).toBe(true);
  });

  it('moves only on mouse release and supports undo', () => {
    const original = editor.getJSON();
    const updated = vi.fn();
    editor.on('update', updated);
    startDrag();
    expect(editor.getJSON()).toEqual(original);
    expect(updated).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLDivElement>('.md-block-drop-indicator')!.hidden).toBe(false);
    mouse(document, 'mouseup', 400);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(editor.state.doc.textContent).toBe('둘셋하나');
    expect(document.querySelector<HTMLDivElement>('.md-block-drop-indicator')!.hidden).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
  });

  it('does not treat a simple handle click as a move', () => {
    hoverFirst();
    mouse(button(), 'mousedown', 110, 80);
    mouse(document, 'mouseup', 400);
    expect(editor.state.doc.textContent).toBe('하나둘셋');
  });

  it('cancels when released outside the editor horizontally or when mouse release was lost', () => {
    startDrag();
    mouse(document, 'mouseup', 400, 900);
    expect(editor.state.doc.textContent).toBe('하나둘셋');
    startDrag();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 110, clientY: 400, buttons: 0 }));
    mouse(document, 'mouseup', 400);
    expect(editor.state.doc.textContent).toBe('하나둘셋');
  });

  it.each(['escape', 'blur', 'scroll', 'document edit', 'read only'])('cancels a drag after %s', (reason) => {
    startDrag();
    if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    if (reason === 'scroll') document.dispatchEvent(new Event('scroll'));
    if (reason === 'document edit') editor.commands.insertContent('수정');
    if (reason === 'read only') editor.setEditable(false);
    const before = editor.getJSON();
    mouse(document, 'mouseup', 400);
    expect(editor.getJSON()).toEqual(before);
    expect(document.querySelector<HTMLDivElement>('.md-block-drop-indicator')!.hidden).toBe(true);
  });

  it('moves the selected top-level block with Alt+Shift+arrows and preserves the cursor', () => {
    editor.commands.setTextSelection(2);
    expect(shortcut('ArrowDown')).toBe(false);
    expect(editor.state.doc.textContent).toBe('둘하나셋');
    expect(editor.state.selection.$from.parent.textContent).toBe('하나');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
    expect(shortcut('ArrowUp')).toBe(false);
    expect(editor.state.doc.textContent).toBe('하나둘셋');
  });

  it('provides keyboard movement directly on the handle', () => {
    hoverFirst();
    button().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, shiftKey: true, bubbles: true }));
    expect(editor.state.doc.textContent).toBe('둘하나셋');
    expect(button().hidden).toBe(false);
  });

  it('moves the whole enclosing list from a nested text cursor', () => {
    editor.commands.setContent('<ul><li><p>상위</p><ul><li><p>하위</p></li></ul></li></ul><p>뒤</p>');
    let cursor = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '하위') cursor = pos + 1;
    });
    editor.commands.setTextSelection(cursor);
    const list = editor.state.doc.firstChild!.toJSON();
    shortcut('ArrowDown');
    expect(editor.state.doc.firstChild!.textContent).toBe('뒤');
    // StarterKit may append a trailing empty paragraph after a terminal list.
    expect(editor.state.doc.child(1).toJSON()).toEqual(list);
    expect(editor.state.selection.$from.parent.textContent).toBe('하위');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });

  it('does not move a selection spanning blocks, or a read-only document', () => {
    editor.commands.setTextSelection({ from: 1, to: 6 });
    shortcut('ArrowDown');
    expect(editor.state.doc.textContent).toBe('하나둘셋');
    editor.commands.setTextSelection(1);
    editor.setEditable(false);
    shortcut('ArrowDown');
    hoverFirst();
    expect(button().hidden).toBe(true);
    expect(editor.state.doc.textContent).toBe('하나둘셋');
  });

  it('cleans widgets and document listeners up when the editor is destroyed', () => {
    startDrag();
    editor.destroy();
    mouse(document, 'mousemove', 400);
    mouse(document, 'mouseup', 400);
    expect(document.querySelector('.md-block-handle')).toBeNull();
    expect(document.querySelector('.md-block-drop-indicator')).toBeNull();
  });
});

import { Extension } from '@tiptap/core';
import { AllSelection, NodeSelection, Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { dropIndexFromY, moveBlock } from './move-block';
import './drag-handle.css';

export { dropIndexFromY, moveBlock } from './move-block';

function moveSelectedBlock(view: EditorView, direction: -1 | 1): boolean {
  if (!view.editable || view.composing || view.state.selection instanceof AllSelection) return false;
  const { selection } = view.state;
  const index = selection.$from.index(0);
  // A selection spanning multiple top-level blocks has no unambiguous handle.
  if (!(selection instanceof NodeSelection) && selection.$to.index(0) !== index) return false;
  const tr = moveBlock(view.state, index, direction < 0 ? index - 1 : index + 2);
  if (!tr) return false;
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Mouse-based dragging works in WKWebView without HTML5 DataTransfer support. */
export const DragHandle = Extension.create({
  name: 'dragHandle',

  addKeyboardShortcuts() {
    return {
      'Alt-Shift-ArrowUp': () => moveSelectedBlock(this.editor.view, -1),
      'Alt-Shift-ArrowDown': () => moveSelectedBlock(this.editor.view, 1),
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({ view: (view) => new BlockHandleView(view) })];
  },
});

class BlockHandleView {
  private readonly doc: Document;
  private readonly button: HTMLButtonElement;
  private readonly indicator: HTMLDivElement;
  private index: number | null = null;
  private drag: { index: number; x: number; y: number; active: boolean; doc: EditorView['state']['doc'] } | null = null;

  constructor(private readonly view: EditorView) {
    this.doc = view.dom.ownerDocument;
    this.button = this.doc.createElement('button');
    this.button.type = 'button';
    this.button.className = 'md-block-handle';
    this.button.textContent = '⠿';
    this.button.setAttribute('aria-label', '블록 이동');
    this.button.title = '끌어서 블록 이동 · Alt+Shift+↑/↓';
    this.button.setAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowUp Alt+Shift+ArrowDown');
    this.button.hidden = true;
    this.button.draggable = false;
    this.indicator = this.doc.createElement('div');
    this.indicator.className = 'md-block-drop-indicator';
    this.indicator.hidden = true;
    this.indicator.setAttribute('aria-hidden', 'true');
    // UI lives outside the content DOM: getHTML(), Markdown, and node views
    // never see or serialize a handle. Each editor owns its own two widgets.
    this.doc.body.append(this.button, this.indicator);
    this.doc.addEventListener('mousemove', this.onMove);
    this.doc.addEventListener('mouseup', this.onUp);
    this.doc.addEventListener('keydown', this.onKeyDown, true);
    this.doc.addEventListener('scroll', this.onScroll, true);
    this.doc.defaultView?.addEventListener('blur', this.cancel);
    this.doc.defaultView?.addEventListener('resize', this.onScroll);
    this.button.addEventListener('mousedown', this.onDown);
    this.button.addEventListener('keydown', this.onButtonKeyDown);
  }

  private blocks() {
    const blocks: { element: Element; pos: number; index: number }[] = [];
    this.view.state.doc.forEach((_, pos, index) => {
      const dom = this.view.nodeDOM(pos);
      if (dom?.nodeType === 1) blocks.push({ element: dom as Element, pos, index });
    });
    return blocks;
  }

  private show(index: number) {
    const block = this.blocks().find((item) => item.index === index);
    if (!block) return this.hide();
    const rect = block.element.getBoundingClientRect();
    this.index = index;
    this.button.style.left = `${Math.max(0, rect.left - 28)}px`;
    this.button.style.top = `${rect.top}px`;
    this.button.hidden = false;
  }

  private hide() {
    this.button.hidden = true;
    this.index = null;
  }

  private onMove = (event: MouseEvent) => {
    if (!this.view.editable || this.view.composing) return this.cancel();
    if (this.drag) {
      if (this.drag.doc !== this.view.state.doc || !(event.buttons & 1)) return this.cancel();
      if (!this.drag.active && Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) < 4) return;
      this.drag.active = true;
      event.preventDefault();
      this.button.classList.add('md-block-handle-dragging');
      this.paintDrop(event.clientY);
      return;
    }
    const target = event.target as Node | null;
    if (!target || this.button.contains(target)) return;
    const blocks = this.blocks();
    const block = this.view.dom.contains(target) ? blocks.find(({ element }) => element.contains(target)) : undefined;
    if (block) return this.show(block.index);
    // Keep the button reachable while the pointer crosses the small gutter.
    const current = blocks.find(({ index }) => index === this.index);
    const rect = current?.element.getBoundingClientRect();
    if (rect && event.clientX >= Math.max(0, rect.left - 32) && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
    this.hide();
  };

  private onDown = (event: MouseEvent) => {
    if (event.button !== 0 || this.index === null || !this.view.editable || this.view.composing) return;
    event.preventDefault();
    this.drag = { index: this.index, x: event.clientX, y: event.clientY, active: false, doc: this.view.state.doc };
  };

  private drop(y: number) {
    const blocks = this.blocks();
    // A node view must supply an element for every block. Otherwise DOM and
    // document indices would disagree; abort instead of moving the wrong block.
    if (blocks.length !== this.view.state.doc.childCount) return null;
    const rects = blocks.map(({ element }) => element.getBoundingClientRect());
    return { rects, index: dropIndexFromY(y, rects) };
  }

  private paintDrop(y: number) {
    const drop = this.drop(y);
    if (!drop || !drop.rects.length) return;
    const { rects, index } = drop;
    const rect = rects[Math.min(index, rects.length - 1)];
    this.indicator.style.left = `${rect.left}px`;
    this.indicator.style.top = `${index === rects.length ? rect.bottom : rect.top}px`;
    this.indicator.style.width = `${rect.width}px`;
    this.indicator.hidden = false;
  }

  private onUp = (event: MouseEvent) => {
    if (!this.drag || event.button !== 0) return;
    const drag = this.drag;
    const drop = this.drop(event.clientY);
    this.cancel();
    if (!drag.active || !drop || !this.view.editable || this.view.composing || drag.doc !== this.view.state.doc) return;
    if (!drop.rects.some((rect) => event.clientX >= rect.left - 32 && event.clientX <= rect.right + 32)) return;
    const tr = moveBlock(this.view.state, drag.index, drop.index);
    if (!tr) return;
    this.view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView());
    this.view.focus();
  };

  private onButtonKeyDown = (event: KeyboardEvent) => {
    if (this.index === null || !this.view.editable) return;
    const block = this.blocks().find(({ index }) => index === this.index);
    if (!block) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, block.pos)));
      this.view.focus();
    }
    if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const up = event.key === 'ArrowUp';
      const tr = moveBlock(this.view.state, this.index, up ? this.index - 1 : this.index + 2);
      if (!tr) return;
      const index = this.index + (up ? -1 : 1);
      this.view.dispatch(tr.scrollIntoView());
      this.show(index);
    }
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && (this.drag || this.doc.activeElement === this.button)) {
      event.preventDefault();
      this.cancel();
      this.view.focus();
    }
  };

  private onScroll = () => {
    if (this.drag?.active) this.cancel();
    else this.hide();
  };

  private cancel = () => {
    this.drag = null;
    this.indicator.hidden = true;
    this.button.classList.remove('md-block-handle-dragging');
    this.hide();
  };

  update(view: EditorView, previous: EditorView['state']) {
    if (!view.editable || view.state.doc !== previous.doc) this.cancel();
  }

  destroy() {
    this.cancel();
    this.doc.removeEventListener('mousemove', this.onMove);
    this.doc.removeEventListener('mouseup', this.onUp);
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    this.doc.removeEventListener('scroll', this.onScroll, true);
    this.doc.defaultView?.removeEventListener('blur', this.cancel);
    this.doc.defaultView?.removeEventListener('resize', this.onScroll);
    this.button.removeEventListener('mousedown', this.onDown);
    this.button.removeEventListener('keydown', this.onButtonKeyDown);
    this.button.remove();
    this.indicator.remove();
  }
}

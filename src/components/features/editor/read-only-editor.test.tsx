// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markdownToHtml } from '@/lib/markdown';
import { ReadOnlyEditor } from './read-only-editor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ReadOnlyEditor task-list rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: Editor | null;
  const onEditorReady = (value: Editor | null) => { editor = value; };

  beforeEach(() => {
    editor = null;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  async function render(markdown: string) {
    await act(async () => {
      root.render(<ReadOnlyEditor content={markdownToHtml(markdown)} onEditorReady={onEditorReady} />);
    });
  }

  it('renders checked and unchecked task nodes in the live DOM, including after reload', async () => {
    await render('# 한글 문서\n\n- [ ] 대기\n- [x] 완료');
    expect(editor?.isEditable).toBe(false);
    let tasks = container.querySelectorAll<HTMLLIElement>('li[data-type="taskItem"]');
    expect(tasks).toHaveLength(2);
    expect([...tasks].map((task) => task.dataset.checked)).toEqual(['false', 'true']);
    expect([...tasks].map((task) => task.querySelector('input')?.checked)).toEqual([false, true]);
    expect(tasks[0].textContent).toContain('대기');
    expect(tasks[1].textContent).toContain('완료');

    await render('# 수정된 문서\n\n- [x] 외부에서 완료\n  - [ ] 하위 작업\n- [ ] 새 작업');
    tasks = container.querySelectorAll<HTMLLIElement>('li[data-type="taskItem"]');
    expect(tasks).toHaveLength(3);
    expect([...tasks].map((task) => task.dataset.checked)).toEqual(['true', 'false', 'false']);
    expect([...tasks].map((task) => task.querySelector('input')?.checked)).toEqual([true, false, false]);
    expect(container.querySelector('h1')?.textContent).toBe('수정된 문서');
  });

  it('keeps checkbox interactions read-only', async () => {
    await render('- [ ] 대기');
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); });
    expect(checkbox.checked).toBe(false);
    expect(container.querySelector('li')?.dataset.checked).toBe('false');
    const task = editor?.state.doc.firstChild?.firstChild;
    expect(task?.type.name).toBe('taskItem');
    expect(task?.attrs?.checked).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { SlashCommand, filterSlashCommands, slashCommandKey, type SlashCommandStorage } from './slash-command';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup(text = '/') {
  editor = new Editor({ extensions: [StarterKit.configure({ trailingNode: false }), SlashCommand], content: `<p>${text}</p>` });
  editor.commands.setTextSelection(text.length + 1);
  return editor.storage.slashCommand as SlashCommandStorage;
}
function key(value: string, composing = false) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, isComposing: composing });
  const plugin = editor.state.plugins.find((plugin) => plugin.spec.key === slashCommandKey)!;
  plugin.props.handleKeyDown!.call(plugin, editor.view, event);
  return event;
}

describe('mounted slash commands', () => {
  it('filters Korean labels and aliases and excludes unsupported math insertion', () => {
    expect(filterSlashCommands('제목').map((item) => item.command)).toEqual(['heading1', 'heading2', 'heading3']);
    expect(filterSlashCommands('todo')[0].command).toBe('taskList');
    expect(filterSlashCommands('').some((item) => item.command === 'math')).toBe(false);
  });
  it('keeps arrow selection through transactions and executes the selected heading', () => {
    const storage = setup();
    expect(storage.active).toBe(true);
    key('ArrowDown');
    expect(storage.selectedIndex).toBe(1);
    key('Enter');
    expect(editor.state.doc.firstChild?.type.name).toBe('heading');
    expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
    expect(editor.getText()).toBe('');
  });
  it('Escape dismisses until the query changes; IME Enter does not execute', () => {
    const storage = setup();
    key('Escape');
    editor.view.dispatch(editor.state.tr.setMeta('search', true));
    expect(storage.active).toBe(false);
    editor.commands.insertContent('h');
    expect(storage.active).toBe(true);
    key('Enter', true);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
  });
  it('does not activate inside prose, URLs or code blocks', () => {
    expect(setup('https://host/').active).toBe(false);
    editor.commands.setContent('<pre><code>/</code></pre>');
    editor.commands.setTextSelection(2);
    expect(editor.storage.slashCommand.active).toBe(false);
  });
  it('opens image input without deleting text and cancellation preserves the slash', () => {
    const storage = setup('/img');
    key('Enter');
    expect(storage.imageRange).toEqual({ from: 1, to: 5 });
    expect(editor.getText()).toBe('/img');
    editor.view.dispatch(editor.state.tr.setMeta(slashCommandKey, { dismiss: true, image: null }));
    expect(storage.imageRange).toBe(null);
    expect(storage.active).toBe(false);
    expect(editor.getText()).toBe('/img');
  });
  it('leaves Enter to the editor when no commands match', () => {
    const storage = setup('/zzzz');
    expect(storage.filteredItems).toHaveLength(0);
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(storage.selectedIndex).toBe(0);
  });
});

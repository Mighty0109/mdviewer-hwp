'use client';

import { useEffect, useRef } from 'react';
import { useEditor, EditorContent, type Editor as TipTapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { Superscript } from '@tiptap/extension-superscript';
import { Subscript } from '@tiptap/extension-subscript';
import { htmlToMarkdown } from '@/lib/markdown';
import { UniqueID } from '@/extensions/unique-id';
import { DocSearch } from '@/extensions/doc-search';
import { DragHandle } from '@/extensions/drag-handle';
import { SlashCommand } from '@/extensions/slash-command';
import { MarkdownImage } from '@/extensions/markdown-image';
import { EditorBubbleMenu } from './bubble-menu';
import { SlashCommandMenu } from './slash-command';

interface EditorProps {
  content: string;
  onChange?: (markdown: string, html: string) => void;
  onDocumentChange?: (html: string) => void;
  editable?: boolean;
  preserveScroll?: boolean;
  revision?: number;
  documentPath?: string;
  onEditorReady?: (editor: TipTapEditor | null) => void;
}

export function Editor({ content, onChange, onDocumentChange, editable = true, preserveScroll, revision, documentPath = '', onEditorReady }: EditorProps) {
  const callbacks = useRef({ onChange, onDocumentChange });
  callbacks.current = { onChange, onDocumentChange };
  const currentHTML = useRef(content);
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }),
      Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
      MarkdownImage, TaskList,
      TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }),
      Placeholder.configure({ placeholder: '내용을 입력하거나 /로 블록 추가' }),
      TextStyle, Color, Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }), Superscript, Subscript,
      UniqueID, DocSearch, DragHandle, SlashCommand,
    ],
    content: content || '<p></p>',
    editorProps: {
      attributes: { 'aria-label': '마크다운 블록 편집기' },
      // Do not embed dropped/pasted files as base64 in a Markdown document.
      handleDrop: (_view, event) => {
        if (!event.dataTransfer?.files.length && !hasEmbeddedImage(event.dataTransfer?.getData('text/html') || '')) return false;
        event.preventDefault();
        return true;
      },
      handlePaste: (_view, event) => {
        if (!event.clipboardData?.files.length && !hasEmbeddedImage(event.clipboardData?.getData('text/html') || '')) return false;
        event.preventDefault();
        return true;
      },
    },
    onUpdate: ({ editor: live }) => {
      const html = live.getHTML();
      currentHTML.current = html;
      // Synchronous: an immediate Cmd+S must include the last keystroke.
      callbacks.current.onDocumentChange?.(html);
      if (callbacks.current.onChange) callbacks.current.onChange(htmlToMarkdown(html), html);
    },
  });

  useEffect(() => {
    if (!editor || content === currentHTML.current) return;
    currentHTML.current = content;
    const container = editor.view.dom.closest('.overflow-y-auto');
    const top = preserveScroll ? container?.scrollTop ?? 0 : 0;
    editor.chain().setContent(content || '<p></p>', { emitUpdate: false }).setMeta('addToHistory', false).run();
    if (container) container.scrollTop = top;
  }, [editor, content, preserveScroll, revision]);
  useEffect(() => { editor?.setEditable(editable, false); }, [editor, editable]);
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return <div className="editor-wrapper relative w-full min-w-0 flex-1">
    {editor && editable && <><EditorBubbleMenu editor={editor} /><SlashCommandMenu editor={editor} documentPath={documentPath} /></>}
    <EditorContent editor={editor} />
  </div>;
}

function hasEmbeddedImage(html: string) {
  if (!html) return false;
  const document = new DOMParser().parseFromString(html, 'text/html');
  return [...document.querySelectorAll('img')].some((image) => /^data:/i.test(image.getAttribute('src') || ''));
}

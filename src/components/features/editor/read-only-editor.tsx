'use client';

import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Image } from '@tiptap/extension-image';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { Superscript } from '@tiptap/extension-superscript';
import { Subscript } from '@tiptap/extension-subscript';
import { UniqueID } from '@/extensions/unique-id';
import { DocSearch } from '@/extensions/doc-search';

interface ReadOnlyEditorProps {
  /** HTML converted from Markdown; image resolution belongs to the ViewModel. */
  content: string;
  preserveScroll?: boolean;
  revision?: number;
  onEditorReady?: (editor: Editor | null) => void;
}

/** Shares MDView's document schema without loading edit, drop or storage UI. */
export function ReadOnlyEditor({ content, preserveScroll, revision, onEditorReady }: ReadOnlyEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      Image.configure({ allowBase64: true }),
      TaskList,
      TaskItem.configure({
        nested: true,
        // TipTap's live node view needs the same marker as its serialized HTML.
        HTMLAttributes: { 'data-type': 'taskItem' },
      }),
      TextStyle, Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Superscript, Subscript, UniqueID, DocSearch,
    ],
    content,
    editorProps: { attributes: { 'aria-label': '읽기 전용 문서' } },
  });

  useEffect(() => {
    if (editor && editor.getHTML() !== content) {
      const container = editor.view.dom.closest('.overflow-y-auto');
      const scrollTop = preserveScroll ? container?.scrollTop ?? 0 : 0;
      // Disk reloads must never enter the future save path.
      editor.commands.setContent(content || '<p></p>', { emitUpdate: false });
      if (container) container.scrollTop = scrollTop;
    }
  }, [editor, content, preserveScroll, revision]);

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return <div className="editor-wrapper"><EditorContent editor={editor} /></div>;
}

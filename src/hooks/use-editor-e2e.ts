'use client';

import { useEffect, useRef, useState } from 'react';
import type { useOpenFile } from './use-open-file';
import type { useDocumentEditor } from './use-document-editor';

/** Inert unless Rust supplies MDVIEWER_E2E_EDIT; uses the normal edit/save path. */
export function useEditorE2e(reader: ReturnType<typeof useOpenFile>, draft: ReturnType<typeof useDocumentEditor>) {
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(new Set<string>());
  const importedSaved = useRef(new Set<string>());
  const latest = useRef({ reader, draft });
  latest.current = { reader, draft };
  useEffect(() => {
    const destination = reader.e2e?.importSaveAs;
    if (!destination || !reader.importResult?.done || !reader.untitled || reader.isLoading
      || importedSaved.current.has(destination)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const saveWhenReady = async () => {
      try {
        if (!await latest.current.reader.e2eGateOpen()) {
          if (!cancelled) timer = setTimeout(() => { void saveWhenReady(); }, 100);
          return;
        }
        if (cancelled || importedSaved.current.has(destination)) return;
        importedSaved.current.add(destination);
        // Rust substitutes this launch-time destination for the native Save As panel.
        await latest.current.reader.saveAs();
      } catch (cause) { if (!cancelled) setError(String(cause)); }
    };
    void saveWhenReady();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [reader.e2e, reader.importResult, reader.untitled, reader.isLoading, reader.saveAs]);
  const path = reader.file?.path;
  const edit = reader.e2e?.edit;
  useEffect(() => {
    if (!edit || !path || reader.isLoading || edited.current.has(path)) return;
    if (draft.mode === 'wysiwyg' && (!reader.editor || reader.editor.isDestroyed)) return;
    edited.current.add(path);
    if (draft.mode === 'wysiwyg') {
      reader.editor!.commands.insertContentAt(reader.editor!.state.doc.content.size,
        { type: 'paragraph', content: [{ type: 'text', text: edit }] });
    } else {
      draft.onSourceChange(`${draft.getContent().replace(/\s*$/, '')}\n\n${edit}\n`);
    }
    setApplied(true);
  }, [edit, path, reader.isLoading, reader.editor, draft.mode, draft.getContent, draft.onSourceChange]);

  useEffect(() => {
    if (!applied || !edit || !path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const saveWhenReady = async () => {
      try {
        if (!await latest.current.reader.e2eGateOpen()) {
          if (!cancelled) timer = setTimeout(() => { void saveWhenReady(); }, 100);
          return;
        }
        if (!cancelled && latest.current.reader.file?.path === path) await latest.current.reader.saveFile();
      } catch (cause) { if (!cancelled) setError(String(cause)); }
    };
    void saveWhenReady();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [applied, edit, path]);
  return { applied, error };
}

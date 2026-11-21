'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { htmlToMarkdown } from '@/lib/markdown';
import { applyEnvelope } from '@/domain/document-envelope';
import { detectUnsupportedSyntax } from '@/domain/unsupported-syntax';
import { useUIStore } from '@/stores/ui-store';
import type { ViewMode } from '@/types/editor';
import { type useOpenFile } from './use-open-file';

type Reader = ReturnType<typeof useOpenFile>;

/** Owns the current draft. Saving always reads this synchronous, lossless getter. */
export function useDocumentEditor(reader: Reader) {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.actions.setViewMode);
  const [draftRevision, setDraftRevision] = useState(reader.revision);
  const [source, setSource] = useState('');
  const [html, setHtml] = useState('');
  const [rendering, setRendering] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sourceRef = useRef('');
  const request = useRef(0);
  const readerRef = useRef(reader);
  readerRef.current = reader;

  useLayoutEffect(() => {
    ++request.current;
    setDraftRevision(reader.revision);
    sourceRef.current = reader.file?.content ?? '';
    setSource(sourceRef.current);
    setHtml(reader.html);
    setRendering(false);
    setPreviewError(null);
  }, [reader.revision]); // A save without a reload must not replace an in-flight draft.

  const getContent = useCallback(() => sourceRef.current, []);
  useLayoutEffect(() => {
    reader.setContentGetter(getContent);
    return () => reader.setContentGetter(null);
  }, [reader.setContentGetter, getContent]);
  useEffect(() => () => { ++request.current; }, []);

  const onSourceChange = useCallback((value: string) => {
    sourceRef.current = value;
    setSource(value);
    readerRef.current.markDirty();
    const id = ++request.current;
    setRendering(true);
    setPreviewError(null);
    const file = readerRef.current.file;
    if (!file) return;
    void readerRef.current.renderFile({ ...file, content: value }).then((preview) => {
      if (id !== request.current) return;
      setHtml(preview); setRendering(false);
    }).catch((error: unknown) => {
      if (id !== request.current) return;
      setRendering(false); setPreviewError(String(error));
    });
  }, []);

  const onRichChange = useCallback((value: string) => {
    const current = readerRef.current;
    const path = current.file?.path ?? '';
    const markdown = applyEnvelope(htmlToMarkdown(value, path.slice(0, path.lastIndexOf('/'))), current.envelope);
    sourceRef.current = markdown;
    setSource(markdown);
    setHtml(value);
    current.markDirty();
  }, []);

  // A replacement editor must mount with the new document, never a stale draft.
  const currentSource = draftRevision === reader.revision ? source : reader.file?.content ?? '';
  const currentHTML = draftRevision === reader.revision ? html : reader.html;
  const unsupported = [...new Set([...reader.unsupported, ...detectUnsupportedSyntax(currentSource)])];
  const sourceOnly = unsupported.length > 0;
  const mode: ViewMode = viewMode === 'wysiwyg' && (sourceOnly || rendering || previewError) ? 'source' : viewMode;
  const changeMode = useCallback((next: ViewMode) => { setViewMode(next); }, [setViewMode]);
  return { source: currentSource, html: currentHTML, mode, sourceOnly, unsupported, changeMode, onSourceChange, onRichChange,
    rendering, previewError, getContent };
}

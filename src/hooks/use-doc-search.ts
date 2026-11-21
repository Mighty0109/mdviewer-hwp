'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { findSearchMatches } from '@/domain/search';
import { docSearchKey, documentSearchMatches } from '@/extensions/doc-search';

export function useDocSearch(editor: Editor | null, initialQuery = '', source?: string) {
  const [isOpen, setOpen] = useState(false);
  const [query, updateQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigateRequested = useRef(false);

  useEffect(() => {
    if (initialQuery) { updateQuery(initialQuery); setOpen(true); }
  }, [initialQuery]);

  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) setRevision((value) => value + 1);
    };
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); };
  }, [editor]);

  const matches = useMemo(() => {
    // revision changes for setContent(..., { emitUpdate: false }) as well.
    void revision;
    return source !== undefined ? findSearchMatches(source.replace(/\r\n|\r/g, '\n'), query) : editor && query ? documentSearchMatches(editor.state.doc, query) : [];
  }, [editor, query, revision, source]);
  const active = matches.length ? Math.min(activeIndex, matches.length - 1) : 0;

  useEffect(() => {
    if (source !== undefined) {
      if (navigateRequested.current && isOpen && matches[active]) {
        navigateRequested.current = false;
        selectSourceMatch(matches[active]);
      }
      return;
    }
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(docSearchKey, {
      query: isOpen ? query : '', active,
    }).setMeta('addToHistory', false));
    // Reloading a file recalculates matches without moving the reading position.
    if (navigateRequested.current && isOpen && matches[active]) {
      navigateRequested.current = false;
      editor.view.dom.querySelector(`[data-search-match="${active}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [editor, isOpen, query, active, matches, source]);

  const open = useCallback(() => {
    setOpen(true);
    // Cmd+F also selects an existing query when the bar is already open.
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  }, []);
  const close = useCallback(() => { setOpen(false); }, []);
  const setQuery = useCallback((value: string) => {
    updateQuery(value);
    setActiveIndex(0);
    navigateRequested.current = true;
  }, []);
  const move = useCallback((direction: number) => {
    if (!matches.length) return;
    navigateRequested.current = true;
    setActiveIndex((value) => (Math.min(value, matches.length - 1) + direction + matches.length) % matches.length);
    // A single result still needs to scroll when Next is pressed again.
    if (matches.length === 1 && source !== undefined) selectSourceMatch(matches[0]);
    if (matches.length === 1 && source === undefined) editor?.view.dom.querySelector('[data-search-match="0"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [editor, matches, source]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        open();
      } else if (event.key === 'Escape' && isOpen) {
        event.preventDefault(); close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close, isOpen]);

  return { isOpen, query, setQuery, matches: matches.length, active: matches.length ? active + 1 : 0,
    open, close, next: () => move(1), previous: () => move(-1), inputRef };
}

export type DocSearchModel = ReturnType<typeof useDocSearch>;

function selectSourceMatch(match: { from: number; to: number }) {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="마크다운 소스"]');
  if (!textarea) return;
  textarea.setSelectionRange(match.from, match.to);
  const line = textarea.value.slice(0, match.from).split('\n').length - 1;
  const height = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 24;
  textarea.scrollTop = Math.max(0, line * height - textarea.clientHeight / 2);
}

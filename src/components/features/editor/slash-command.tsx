'use client';

import type { Editor } from '@tiptap/react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { executeSlashCommand, slashCommandKey, type SlashCommandStorage } from '@/extensions/slash-command';
import { editorImageAttributes } from '@/hooks/use-editor-image';

export function SlashCommandMenu({ editor, documentPath = '' }: { editor: Editor; documentPath?: string }) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [imageSource, setImageSource] = useState('');
  const [error, setError] = useState('');
  const selectedRef = useRef<HTMLButtonElement>(null);
  const storage = editor.storage.slashCommand as SlashCommandStorage;
  useEffect(() => {
    editor.on('transaction', refresh);
    return () => { editor.off('transaction', refresh); };
  }, [editor]);
  useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [storage.selectedIndex, storage.active]);

  const dismissImage = () => {
    editor.view.dispatch(editor.state.tr.setMeta(slashCommandKey, { dismiss: true, image: null }));
    setImageSource(''); setError('');
    editor.commands.focus();
  };
  if (storage.imageRange) return <form
    aria-label="이미지 삽입"
    className="mb-3 flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    onSubmit={(event) => {
      event.preventDefault();
      const attrs = editorImageAttributes(imageSource, documentPath);
      if (!attrs) { setError('문서 기준 상대 경로나 http(s) 이미지 주소를 입력하세요.'); return; }
      const range = storage.imageRange!;
      editor.chain().focus().deleteRange(range).insertContent({ type: 'image', attrs }).run();
      dismissImage();
    }}
  >
    <label className="text-sm" htmlFor="slash-image-src">이미지 경로</label>
    <input id="slash-image-src" autoFocus value={imageSource} onChange={(event) => setImageSource(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); dismissImage(); } }}
      placeholder="./img/사진.png 또는 https://…" className="min-w-48 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm" />
    <button type="submit" className="text-sm text-[var(--color-accent)]">삽입</button>
    <button type="button" onClick={dismissImage} className="text-sm">취소</button>
    {error && <p role="alert" className="w-full text-xs text-[var(--color-danger)]">{error}</p>}
  </form>;

  if (!storage.active || !storage.decorationPosition) return null;
  return <div role="listbox" aria-label="블록 명령" className="absolute z-50 max-h-80 w-72 max-w-full overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-1 shadow-lg"
    style={storage.decorationPosition}>
    {!storage.filteredItems.length && <p className="p-3 text-sm">일치하는 블록이 없습니다.</p>}
    {storage.filteredItems.map((item, index) => <button key={item.command} type="button" role="option"
      aria-selected={index === storage.selectedIndex} ref={index === storage.selectedIndex ? selectedRef : null}
      className={`block w-full rounded px-3 py-2 text-left text-sm ${index === storage.selectedIndex ? 'bg-[var(--color-surface)]' : ''}`}
      onMouseEnter={() => editor.view.dispatch(editor.state.tr.setMeta(slashCommandKey, { index }))}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { if (storage.range) executeSlashCommand(editor, item.command, storage.range); }}>
      {item.label}<span className="ml-2 text-xs text-[var(--color-text-secondary)]">{item.description}</span>
    </button>)}
  </div>;
}

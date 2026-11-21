'use client';

import { useEffect, useRef } from 'react';

interface SourceEditorProps {
  content: string;
  onChange?: (markdown: string, html: string) => void;
  onSourceChange?: (markdown: string) => void;
}

/** Source is authoritative: never parse and serialize it on the save path. */
export function SourceEditor({ content, onChange, onSourceChange }: SourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (textareaRef.current && textareaRef.current.value !== content) textareaRef.current.value = content;
  }, [content]);
  const changed = (value: string) => {
    onSourceChange?.(value);
    onChange?.(value, '');
  };
  return <div className="flex h-full min-h-64 flex-col">
    <div className="flex h-8 shrink-0 items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-xs text-[var(--color-text-secondary)]">Markdown 소스</div>
    <textarea ref={textareaRef} defaultValue={content} aria-label="마크다운 소스" spellCheck={false}
      onChange={(event) => changed(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const input = event.currentTarget;
        const { selectionStart: start, selectionEnd: end, value } = input;
        if (event.shiftKey) {
          const line = value.lastIndexOf('\n', start - 1) + 1;
          const selected = value.slice(line, end);
          const outdented = selected.replace(/^  /gm, '');
          input.value = value.slice(0, line) + outdented + value.slice(end);
          input.selectionStart = Math.max(line, start - (value.slice(line, start).startsWith('  ') ? 2 : 0));
          input.selectionEnd = end - (selected.length - outdented.length);
        } else {
          input.setRangeText('  ', start, end, 'end');
        }
        changed(input.value);
      }}
      className="min-h-0 w-full flex-1 resize-none bg-[var(--color-bg)] px-6 py-5 font-mono text-sm leading-relaxed text-[var(--color-text)] outline-none"
      placeholder="마크다운을 입력하세요…" />
  </div>;
}

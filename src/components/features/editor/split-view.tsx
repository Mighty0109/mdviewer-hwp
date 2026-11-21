'use client';

import type { Editor as TipTapEditor } from '@tiptap/react';
import type { OriginalViewState } from '@/hooks/use-original-view';
import { ORIGINAL_VIEW_LABELS } from '@/domain/original-view';
import { SourceEditor } from './source-editor';
import { ReadOnlyEditor } from './read-only-editor';
import { OriginalView } from './original-view';

interface SplitViewProps {
  content: string;
  htmlContent: string;
  onChange?: (markdown: string, html: string) => void;
  onSourceChange?: (markdown: string) => void;
  onEditorReady?: (editor: TipTapEditor | null) => void;
  preserveScroll?: boolean;
  revision?: number;
  original?: OriginalViewState;
}

/** Only the source pane edits: unsupported syntax never round-trips through TipTap. */
export function SplitView({ content, htmlContent, onChange, onSourceChange, onEditorReady, preserveScroll, revision, original }: SplitViewProps) {
  return <div className="grid h-full min-h-0 grid-cols-2 divide-x divide-[var(--color-border)]">
    <SourceEditor content={content} onChange={onChange} onSourceChange={onSourceChange} />
    <section aria-label="읽기 전용 미리보기" className={original?.available ? 'overflow-y-auto scroll-pt-8' : 'overflow-y-auto'}>
      {original?.available ? <div role="group" aria-label="미리보기 보기" className="sticky top-0 z-10 flex min-h-8 flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2">
        {(['markdown', 'original'] as const).map(mode => <button key={mode} type="button"
          aria-pressed={original.mode === mode} onClick={() => original.setMode(mode)}
          className="rounded px-2 py-1 text-xs aria-pressed:bg-[var(--color-accent-light)] aria-pressed:text-[var(--color-accent)]">{ORIGINAL_VIEW_LABELS[mode]}</button>)}
      </div> : <div className="flex h-8 items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-xs text-[var(--color-text-secondary)]">미리보기 · 읽기 전용</div>}
      {original?.available && original.mode === 'original' ? <OriginalView original={original} />
        : <article className="px-8 py-5"><ReadOnlyEditor content={htmlContent} onEditorReady={onEditorReady} preserveScroll={preserveScroll} revision={revision} /></article>}
    </section>
  </div>;
}

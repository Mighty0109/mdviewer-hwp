'use client';

import type { OriginalViewState } from '@/hooks/use-original-view';
import { ORIGINAL_VIEW_LABELS } from '@/domain/original-view';

/** Shows one page of the read-only import snapshot using an inert image URL. */
export function OriginalView({ original }: { original: OriginalViewState }) {
  const url = original.pageUrls[original.currentPage];
  return <div data-original-view aria-busy={original.status === 'loading' || original.status === 'idle'} className="p-4">
    <p className="mb-3 text-xs text-[var(--color-text-secondary)]">{ORIGINAL_VIEW_LABELS.snapshot} · 읽기 전용</p>
    {original.pages > 0 && <nav aria-label="원본 쪽 이동" className="sticky top-8 z-10 -mx-4 mb-3 flex items-center justify-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs">
      <button type="button" disabled={original.currentPage === 0 || original.status === 'error'}
        onClick={() => original.setCurrentPage(original.currentPage - 1)}
        className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-40">이전</button>
      <span aria-live="polite">{original.currentPage + 1} / {original.pages}</span>
      <button type="button" disabled={original.currentPage >= original.pages - 1 || original.status === 'error'}
        onClick={() => original.setCurrentPage(original.currentPage + 1)}
        className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-40">다음</button>
    </nav>}
    {original.status === 'error' ? <p role="alert" className="py-4 text-sm">{ORIGINAL_VIEW_LABELS.error} {original.errorMessage}</p>
      : url ? <img key={original.currentPage} src={url} alt={`원본 ${original.currentPage + 1}쪽`} className="mx-auto block h-auto w-full bg-white shadow-sm" />
        : <p role="status" className="py-4 text-sm">{ORIGINAL_VIEW_LABELS.loading}</p>}
  </div>;
}

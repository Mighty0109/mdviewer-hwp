'use client';

import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import type { DocSearchModel } from '@/hooks/use-doc-search';

export function DocSearchBar({ search }: { search: DocSearchModel }) {
  if (!search.isOpen) return null;
  return (
    <div role="search" aria-label="문서 안 검색" className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
      <Search size={16} aria-hidden="true" />
      <input
        ref={search.inputRef}
        aria-label="문서 안 검색어"
        placeholder="문서 안 검색"
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) search.previous(); else search.next();
          }
        }}
        className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm outline-[var(--color-accent)]"
      />
      <span role="status" aria-live="polite" className="min-w-20 text-center text-xs text-[var(--color-text-secondary)]">
        {search.query && !search.matches ? '일치 없음' : `${search.active} / ${search.matches}`}
      </span>
      <button onClick={search.previous} disabled={!search.matches} aria-label="이전 일치 (Shift+Enter)" className="rounded p-1 disabled:opacity-30"><ArrowUp size={16} /></button>
      <button onClick={search.next} disabled={!search.matches} aria-label="다음 일치 (Enter)" className="rounded p-1 disabled:opacity-30"><ArrowDown size={16} /></button>
      <button onClick={search.close} aria-label="검색 닫기 (Esc)" className="rounded p-1"><X size={16} /></button>
    </div>
  );
}

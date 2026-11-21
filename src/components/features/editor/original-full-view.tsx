'use client';

import { useEffect } from 'react';
import type { OriginalViewState } from '@/hooks/use-original-view';
import { OriginalView } from './original-view';

export function OriginalFullView({ original, onExit }: { original: OriginalViewState; onExit: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="menu"],[role="dialog"],[role="alertdialog"],input[aria-label="문서 안 검색어"]')) return;
      onExit();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onExit]);
  return <section aria-label="원본 모양 전체 보기" className="h-full overflow-y-auto scroll-pt-8 [&_nav_button]:min-h-8">
    <div className="sticky top-0 z-10 flex h-8 items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-xs">원본 모양 · 읽기 전용 — 고치려면 소스·분할 (Esc)</div>
    <OriginalView original={original} />
  </section>;
}

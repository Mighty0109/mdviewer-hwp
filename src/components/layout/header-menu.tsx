'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type HeaderMenuEntry = { label: string; action: () => void; shortcut?: string; detail?: string; disabled?: boolean; reason?: string } | { heading: string } | { separator: true };

export function HeaderMenu({ label, icon, entries, className = '' }: { label: string; icon: ReactNode; entries: HeaderMenuEntry[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', keys);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', keys); };
  }, [open]);
  return <div ref={container} className={`relative shrink-0 ${className}`}>
    <button ref={trigger} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-8 min-w-8 items-center justify-center gap-1 rounded px-2 text-xs hover:bg-[var(--color-surface-hover)]">{icon}</button>
    {open && <div role="menu" className="absolute right-0 top-full z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-1 text-xs shadow-lg">
      {entries.map((entry, index) => 'separator' in entry ? <hr key={index} className="my-1 border-[var(--color-border)]" /> : 'heading' in entry ? <div key={index} className="px-3 py-1 text-[var(--color-text-muted)]">{entry.heading}</div> :
        <button key={index} role="menuitem" type="button" aria-disabled={entry.disabled || undefined} title={entry.reason} onClick={() => { if (!entry.disabled) { setOpen(false); entry.action(); } }} className="flex min-h-8 w-full items-center gap-2 rounded px-3 py-1 text-left hover:bg-[var(--color-surface-hover)] aria-disabled:opacity-50">
          <span className="min-w-0 flex-1">{entry.label}{entry.reason && <span className="block text-[10px] text-[var(--color-text-secondary)]">{entry.reason}</span>}</span><span className="shrink-0 text-[var(--color-text-muted)]">{entry.shortcut || entry.detail}</span>
        </button>)}
    </div>}
  </div>;
}

'use client';

import { ChevronDown, FilePlus, FileText, FolderOpen, ListTree, MoreHorizontal, Save, Search, Upload } from 'lucide-react';
import { viewButtons, type DisplayMode } from '@/domain/document-view';
import { HeaderMenu, type HeaderMenuEntry } from './header-menu';

export interface AppHeaderProps {
  title: string; path?: string; dirty: boolean; hasFile: boolean; mode: DisplayMode; sourceOnly: boolean; rendering: boolean; previewError: boolean; sourceReason: string;
  saving: boolean; busy: boolean; hasOriginal: boolean; tocOpen: boolean;
  onMode: (mode: DisplayMode) => void; onNew: () => void; onOpen: () => void; onSave: () => void; onSaveAs: () => void; onClose: () => void;
  onExportHwpx: () => void; onExportMarkdownWord: () => void; onSearch: () => void; onToc: () => void;
}
const iconClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-[var(--color-surface-hover)] disabled:opacity-40';
export function AppHeader(p: AppHeaderProps) {
  const file: HeaderMenuEntry[] = [
    { label: '새 문서', shortcut: '⌘N', action: p.onNew }, { label: '열기…', shortcut: '⌘O', action: p.onOpen },
    ...(p.hasFile ? [{ separator: true } as const, { label: '저장', shortcut: '⌘S', action: p.onSave, disabled: p.saving },
      { label: '다른 이름으로 저장…', action: p.onSaveAs, disabled: p.saving }, { separator: true } as const, { label: '문서 닫기', action: p.onClose }] : []),
  ];
  const exports: HeaderMenuEntry[] = [
    { heading: '한글(HWPX)' }, { label: 'HWPX로 내보내기', action: p.onExportHwpx, disabled: p.busy }, { separator: true },
    { heading: 'Word (.docx)' }, { label: 'Word로 저장', action: p.onExportMarkdownWord, disabled: p.busy },
  ];
  return <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 border-b border-[var(--color-border)] px-3 py-1">
    <FileText size={18} className="order-1 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
    <h1 title={p.path} className="order-2 min-w-0 flex-1 truncate text-sm font-medium">{p.dirty ? '● ' : ''}{p.title || 'MDViewer'}</h1>
    {p.hasFile && <div role="group" aria-label="편집 보기" className="order-6 flex gap-1 max-[639px]:basis-auto min-[640px]:order-3">
      {viewButtons(p.hasOriginal).map(({ mode, label }) => <button key={mode} title={mode === 'wysiwyg' && p.sourceOnly ? `${p.sourceReason}: 무손실 소스 전용` : label} disabled={mode === 'wysiwyg' && (p.sourceOnly || p.rendering || p.previewError)} aria-pressed={p.mode === mode} onClick={() => p.onMode(mode)} className="min-h-8 rounded px-2 text-xs aria-pressed:bg-[var(--color-accent-light)] aria-pressed:text-[var(--color-accent)] disabled:opacity-40">{label}</button>)}
    </div>}
    <span className="order-4 hidden h-5 w-px bg-[var(--color-border)] min-[640px]:block" />
    <button onClick={p.onNew} title="새 문서 (⌘N)" aria-label="새 문서 (⌘N)" className={`order-4 hidden min-[1000px]:flex ${iconClass}`}><FilePlus size={18} /></button>
    <button onClick={p.onOpen} title="파일 열기 (⌘O)" aria-label="파일 열기 (⌘O)" className={`order-4 hidden min-[1000px]:flex ${iconClass}`}><FolderOpen size={18} /></button>
    {p.hasFile && <button disabled={p.saving} onClick={p.onSave} title="저장 (⌘S)" aria-label="저장 (⌘S)" className={`order-3 min-[640px]:order-4 ${iconClass}`}><Save size={18} /></button>}
    <HeaderMenu label="파일" icon={<>파일<ChevronDown size={14} /></>} entries={file} className="order-4 hidden min-[640px]:block" />
    {p.hasFile && <HeaderMenu label="내보내기" icon={<><Upload size={16} />내보내기<ChevronDown size={14} /></>} entries={exports} className="order-4 hidden min-[640px]:block" />}
    <HeaderMenu label="더 보기" icon={<MoreHorizontal size={18} />} entries={p.hasFile ? [...file, { separator: true }, ...exports] : file} className="order-4 min-[640px]:hidden" />
    <span className="order-5 hidden h-5 w-px bg-[var(--color-border)] min-[640px]:block" />
    <span className="order-5 basis-full min-[640px]:hidden" />
    <span className="order-7 flex-1 min-[640px]:hidden" />
    <button onClick={p.onSearch} title="문서 안 검색 (⌘F)" aria-label="문서 안 검색 (⌘F)" className={`order-8 ${iconClass}`}><Search size={18} /></button>
    <button onClick={p.onToc} title="목차 표시 전환" aria-label="목차 표시 전환" aria-pressed={p.tocOpen} className={`order-9 ${iconClass}`}><ListTree size={18} /></button>
  </header>;
}

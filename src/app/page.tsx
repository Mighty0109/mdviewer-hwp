'use client';

import { FileText } from 'lucide-react';
import { AppHeader } from '@/components/layout/app-header';
import { Editor } from '@/components/features/editor/editor';
import { SourceEditor } from '@/components/features/editor/source-editor';
import { OriginalFullView } from '@/components/features/editor/original-full-view';
import { SplitView } from '@/components/features/editor/split-view';
import { FileNotices } from '@/components/features/editor/file-notices';
import { TocPanel } from '@/components/features/editor/toc-panel';
import { DocSearchBar } from '@/components/features/editor/doc-search-bar';
import { HwpImport } from '@/components/features/import-export/hwp-import';
import { HwpExport } from '@/components/features/import-export/hwp-export';
import { useClosePrompt } from '@/hooks/use-close-prompt';
import { useOpenFile } from '@/hooks/use-open-file';
import { useDocumentEditor } from '@/hooks/use-document-editor';
import { useEditorE2e } from '@/hooks/use-editor-e2e';
import { useDocSearch } from '@/hooks/use-doc-search';
import { ORIGINAL_VIEW_E2E_QUERY, useReaderReport } from '@/hooks/use-reader-report';
import { useDocumentView, useOriginalDisplaySync } from '@/hooks/use-document-view';
import { useOriginalView } from '@/hooks/use-original-view';
import { useUIStore } from '@/stores/ui-store';
import type { UnsupportedKind } from '@/domain/unsupported-syntax';

const reasons: Record<UnsupportedKind, string> = { frontmatter: '프런트매터', html: '원시 HTML', footnote: '각주', math: '수식', 'too-large': '300KB 초과' };
const saveLabels = { idle: '저장되지 않은 변경', saving: '저장 중…', saved: '저장됨', conflict: '저장 충돌', error: '저장 실패' };

export default function Home() {
  const reader = useOpenFile();
  useClosePrompt(reader);
  const draft = useDocumentEditor(reader);
  const original = useOriginalView(reader.original);
  const view = useDocumentView(reader.original, draft, original.status, original.errorMessage);
  const e2e = useEditorE2e(reader, draft);
  const { file, title, isLoading, error, editor, setEditor, pickFile, closeFile } = reader;
  const initialQuery = reader.e2e?.query === ORIGINAL_VIEW_E2E_QUERY ? '' : reader.e2e?.query;
  const search = useDocSearch(editor, initialQuery, view.mode === 'source' && file ? draft.source : undefined);
  const setOriginalMode = useReaderReport(reader, editor, search.query, search.matches,
    { applied: e2e.applied, mode: view.mode === 'wysiwyg' ? 'rich' : 'source' }, original, view.changeMode);
  useOriginalDisplaySync(view.mode, original, setOriginalMode);
  const tocOpen = useUIStore((s) => s.tocOpen);
  const toggleToc = useUIStore((s) => s.actions.toggleToc);
  const sourceReason = draft.unsupported.map((kind) => reasons[kind]).join(' · ');

  return <div className="flex h-dvh flex-col overflow-hidden">
    <AppHeader title={title} path={file?.path} dirty={reader.dirty} hasFile={!!file} mode={view.mode}
      sourceOnly={draft.sourceOnly} rendering={draft.rendering} previewError={!!draft.previewError} sourceReason={sourceReason}
      saving={reader.saveStatus === 'saving'}
      busy={reader.exportStatus === 'exporting' || reader.wordStatus === 'converting' || isLoading} hasOriginal={!!reader.original} tocOpen={tocOpen}
      onMode={view.changeMode} onNew={reader.newDocument} onOpen={pickFile} onSave={reader.saveFile}
      onSaveAs={reader.saveAs} onClose={closeFile} onExportHwpx={reader.exportDocument}
      onExportMarkdownWord={reader.exportMarkdownWord} onSearch={search.open} onToc={toggleToc} />
    <DocSearchBar search={search} />
    <FileNotices reader={reader} />
    <HwpImport reader={reader} />
    <HwpExport reader={reader} />
    {reader.dropNotice && <p role="status" className="px-4 py-2 text-xs">{reader.dropNotice}</p>}
    {file && draft.sourceOnly && <p className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs" role="status">{sourceReason} 문서는 원문 보존을 위해 소스로 편집합니다. 분할 보기에서 미리보기를 확인할 수 있습니다.</p>}
    {file && view.originalNotice && <p role="alert" className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs">{view.originalNotice}</p>}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <main className={`min-w-0 flex-1 ${view.mode === 'wysiwyg' ? 'overflow-y-auto' : 'overflow-hidden'}`} aria-label="마크다운 문서" aria-busy={isLoading}>
        {file ? view.mode === 'original' ? <OriginalFullView original={{ ...original, setMode: setOriginalMode }} onExit={view.exitOriginal} /> : view.mode === 'wysiwyg' ? <article className="mx-auto max-w-4xl px-8 py-10">
          <Editor key={reader.revision} content={draft.html} onDocumentChange={draft.onRichChange} documentPath={file.path} preserveScroll={reader.preserveScroll} revision={reader.revision} onEditorReady={setEditor} />
        </article> : view.mode === 'split' ? <SplitView content={draft.source} htmlContent={draft.html} onSourceChange={draft.onSourceChange} onEditorReady={setEditor} preserveScroll={reader.preserveScroll} revision={reader.revision} original={{ ...original, setMode: setOriginalMode }} />
          : <SourceEditor content={draft.source} onSourceChange={draft.onSourceChange} />
          : <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            <FileText size={40} className="text-[var(--color-text-muted)]" aria-hidden="true" />
            <h2 className="text-xl font-semibold">마크다운 문서 열기</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">.md 파일을 더블클릭하거나 ⌘O로 열어보세요. 한글(.hwp/.hwpx)도 ⌘O나 끌어다 놓기로 엽니다. ⌘N으로 새 문서를 만듭니다.</p>
            <button className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white disabled:opacity-50" onClick={pickFile} disabled={isLoading}>{isLoading ? '불러오는 중…' : '파일 열기 (⌘O)'}</button>
          </div>}
      </main>
      <TocPanel editor={editor} />
    </div>
    <footer className="flex min-h-8 shrink-0 items-center border-t border-[var(--color-border)] px-4 text-xs text-[var(--color-text-secondary)]" data-statusbar>
      {error || reader.transferError || draft.previewError || e2e.error ? <span role="alert">{error || reader.transferError || draft.previewError || e2e.error}</span> : <span aria-live="polite">{isLoading ? '문서 불러오는 중…' : !file ? 'Markdown' : `${reader.dirty || reader.saveStatus !== 'idle' ? saveLabels[reader.saveStatus] : '저장됨'} · ${view.mode === 'original' ? '원본 모양 · 읽기 전용' : view.mode === 'wysiwyg' ? '블록 편집 · / 명령 · Alt+Shift+↑/↓ 블록 이동' : '소스 편집'} · ⌘S 저장`}</span>}
    </footer>
  </div>;
}

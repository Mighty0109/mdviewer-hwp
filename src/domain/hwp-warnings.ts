import type { ImportAsset } from './hwp-assets';

export type ImportWarningCode = 'table-raw-html' | 'table-nested-flattened' | 'table-cell-flattened' | 'image-skipped'
  | 'footnote-skipped' | 'masterpage-skipped' | 'textbox-text-only' | 'equation-skipped'
  | 'shape-skipped' | 'object-skipped' | 'change-tracking-ignored';
export interface ImportWarning { code: ImportWarningCode; count: number; detail?: string }
export type ExportWarningCode = 'image-missing' | 'image-remote' | 'image-format' | 'inline-format-simplified';
export interface ExportWarning { code: ExportWarningCode; count: number; detail?: string }
export type HwpImportErrorCode = 'encrypted' | 'drm-distribution' | 'corrupt' | 'too-large'
  | 'unpacked-too-large' | 'unsupported-format';
export class HwpImportError extends Error {
  constructor(public readonly code: HwpImportErrorCode, message: string) {
    super(message); this.name = 'HwpImportError';
  }
}
export interface ImportStats {
  headings: number; paragraphs: number; tables: number; images: number;
  imageReferences: number; imageMappings: number; skippedImages: number;
}
export interface HwpImportResult {
  markdown: string; warnings: ImportWarning[]; assets: ImportAsset[]; stats: ImportStats;
}
export type HwpProgress = (percent: number, message: string) => void;
export const MAX_HWP_BYTES = 20 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2000;
// Nine local samples: max 109ms, tripled and rounded up to a whole second.
// This is the parser computation budget; UI responsiveness needs a separate app check.
export const PARSE_TIME_BUDGET_MS = 1_000;

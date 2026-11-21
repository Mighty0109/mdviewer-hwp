import type { HwpImportResult } from '@/domain/hwp-warnings';
import type { GenerateResult, ResolvedImage } from '@/lib/hwp/generate';

export type HwpFormat = 'hwp' | 'hwpx';
export type HwpWorkerRequest =
  | { type: 'parse'; id: number; bytes: Uint8Array; format?: HwpFormat }
  | { type: 'generate'; id: number; markdown: string }
  | { type: 'image-result'; id: number; requestId: number; image: ResolvedImage | null };
export type HwpWorkerResponse =
  | { type: 'progress'; id: number; percent: number; message: string }
  | { type: 'parse-result'; id: number; result: HwpImportResult }
  | { type: 'generate-result'; id: number; result: GenerateResult }
  | { type: 'error'; id: number; message: string; code?: string }
  | { type: 'image-request'; id: number; requestId: number; source: string };
export interface ImportReport {
  done: boolean; kind: HwpFormat; untitled: boolean; dirty: boolean;
  markdownLength: number; warningCodes: string[]; assetCount: number;
}
export interface ExportReport { done: boolean; path: string }

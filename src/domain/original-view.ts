/** In-memory import snapshot. The owner drops it when the document is closed. */
export interface OriginalDocument {
  readonly bytes: Uint8Array;
  readonly kind: 'hwp' | 'hwpx';
}

export type OriginalViewMode = 'markdown' | 'original';
export type OriginalViewErrorCode = 'wasm-load' | 'unsupported' | 'corrupt' | 'render';

export class OriginalViewError extends Error {
  constructor(public readonly code: OriginalViewErrorCode, public readonly reason: string) {
    super(reason);
    this.name = 'OriginalViewError';
  }
}

/** One read-only renderer handle per import snapshot; never stores a file path. */
export interface OriginalViewDocument {
  readonly pageCount: number;
  /** Zero-based index. Only this page is rendered. The caller owns any blob URL. */
  renderPage(pageIndex: number): Promise<Blob>;
  /** Idempotent. Releases the native document; subsequent rendering rejects. */
  dispose(): void;
}

export interface OriginalViewAdapter {
  /** Does not render pages or take ownership of the caller's byte buffer. */
  open(original: OriginalDocument): Promise<OriginalViewDocument>;
}

export const ORIGINAL_VIEW_LABELS = {
  markdown: '마크다운 미리보기',
  original: '원본 모양',
  snapshot: '원본(가져온 시점)',
  loading: '원본 모양을 불러오는 중…',
  error: '원본 모양을 표시하지 못했습니다.',
} as const;

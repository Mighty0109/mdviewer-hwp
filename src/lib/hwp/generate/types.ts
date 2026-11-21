/** Pure generator contract. The caller supplies local images; no I/O happens here. */
export interface ResolvedImage {
  bytes: Uint8Array;
  mimeType?: string;
  width?: number;
  height?: number;
}

export type ResolveImage = (source: string) =>
  | Promise<ResolvedImage | Uint8Array | null | undefined>
  | ResolvedImage | Uint8Array | null | undefined;

export interface ExportWarning {
  code: 'image-missing' | 'image-remote' | 'image-format' | 'image-limit'
    | 'inline-format-simplified' | 'unsupported-markdown' | 'xml-character-replaced'
    | 'list-level-simplified';
  count: number;
  detail?: string;
}

export interface GenerateResult {
  bytes: Uint8Array;
  warnings: ExportWarning[];
}

export type Inline = { kind: 'text'; text: string } | { kind: 'image'; image: EmbeddedImage };
export interface Paragraph {
  kind: 'paragraph';
  content: Inline[];
  heading?: number;
  code?: boolean;
  quote?: number;
  list?: { ordered: boolean; level: number; numbering: number };
}
export interface Table { kind: 'table'; rows: Inline[][][] }
export type Block = Paragraph | Table;

export interface EmbeddedImage {
  id: string;
  path: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  alt: string;
}

export interface ExportDocument {
  blocks: Block[];
  images: EmbeddedImage[];
  numberings: number[];
  warnings: ExportWarning[];
}

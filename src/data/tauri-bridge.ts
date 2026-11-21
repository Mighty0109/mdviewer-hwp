import { message } from '@tauri-apps/plugin-dialog';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ImportAsset } from '@/domain/hwp-assets';

export interface MarkdownFile {
  path: string;
  content: string;
  hash: string;
  mtimeMs: number;
}

export interface FileChanged {
  path: string;
  hash: string;
  source: 'external' | 'self';
}

export interface E2eConfig {
  statePath: string; query: string; edit?: string; saveGate?: string;
  importPath?: string | null; importSaveAs?: string | null; exportPath?: string | null;
}
export interface SavedMarkdown { path: string; hash: string; mtimeMs: number }
export interface SavedImportedMarkdown extends SavedMarkdown { assetsDir: string }

/** RFC 3986 segment encoding also escapes Markdown's parentheses. Mirrors Rust. */
export const importedAssetPrefix = (directory: string) => encodeURIComponent(directory)
  .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) + '/';

/** Binary IPC contract: u32 LE metadata byte length, UTF-8 JSON
 * {content,suggestedName,assets:[{name,mimeType,byteLength}]}, then each asset's
 * raw bytes in descriptor order. One Uint8Array body; no base64/JSON byte arrays.
 */
function importPacket(content: string, suggestedName: string, assets: ImportAsset[]): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({ content, suggestedName,
    assets: assets.map(({ name, mimeType, bytes }) => ({ name, mimeType, byteLength: bytes.byteLength })) }));
  const packet = new Uint8Array(4 + metadata.byteLength + assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0));
  new DataView(packet.buffer).setUint32(0, metadata.byteLength, true);
  packet.set(metadata, 4);
  let offset = 4 + metadata.byteLength;
  for (const asset of assets) { packet.set(asset.bytes, offset); offset += asset.bytes.byteLength; }
  return packet;
}

export interface FileBridge {
  available(): boolean;
  onOpened(handler: (event: { path: string }) => void): Promise<() => void>;
  onChanged(handler: (event: FileChanged) => void): Promise<() => void>;
  takePending(): Promise<string[]>;
  read(path: string): Promise<MarkdownFile>;
  watch(path: string): Promise<void>;
  unwatch(): Promise<void>;
  pick(): Promise<string | null>;
  e2eConfig(): Promise<E2eConfig | null>;
  e2eGateOpen(): Promise<boolean>;
  writeMarkdown(path: string, content: string, expectedHash: string): Promise<SavedMarkdown>;
  saveMarkdownAs(content: string, suggestedName: string, previousPath: string | null): Promise<SavedMarkdown | null>;
  setDocumentDirty(dirty: boolean): Promise<void>;
  confirmClose(): Promise<void>;
  onCloseBlocked(handler: () => void): Promise<() => void>;
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel';
export interface ClosePromptBridge { askUnsavedChanges(): Promise<UnsavedChoice> }

export interface HwpFileBridge extends FileBridge {
  saveDocxAs(bytes: Uint8Array, suggestedName: string): Promise<{ path: string } | null>;
  saveImportedMarkdownAs(content: string, suggestedName: string, assets: ImportAsset[]): Promise<SavedImportedMarkdown | null>;
  pickHwp(): Promise<string | null>;
  readHwpBytes(path: string): Promise<Uint8Array>;
  readDocumentImage(docPath: string, relPath: string): Promise<Uint8Array>;
  saveHwpxAs(bytes: Uint8Array, suggestedName: string): Promise<{ path: string } | null>;
  onFilesDropped(handler: (event: { paths: string[] }) => void): Promise<() => void>;
}

/** Raw IPC responses can be ArrayBuffers or arrays (platform transport fallback). */
function rawBytes(value: ArrayBuffer | number[]): Uint8Array { return new Uint8Array(value); }

/** The Rust command/event contract is centralized here; views use ViewModels. */
export const fileBridge: HwpFileBridge & ClosePromptBridge = {
  saveDocxAs: (bytes, suggestedName) => invoke<{ path: string } | null>('save_docx_as', { bytes: Array.from(bytes), suggestedName }),
  askUnsavedChanges: async () => {
    const result = await message('저장하지 않은 변경이 있습니다.', { title: 'MDViewer', kind: 'warning', buttons: { yes: '저장 후 닫기', no: '버리고 닫기', cancel: '취소' } });
    return result === '저장 후 닫기' ? 'save' : result === '버리고 닫기' ? 'discard' : 'cancel';
  },
  available: isTauri,
  saveImportedMarkdownAs: (content, suggestedName, assets) => invoke<SavedImportedMarkdown | null>(
    'save_imported_markdown_as', importPacket(content, suggestedName, assets)),
  pickHwp: () => invoke<string | null>('pick_hwp_file'),
  readHwpBytes: async (path) => rawBytes(await invoke<ArrayBuffer | number[]>('read_hwp_bytes', { path })),
  readDocumentImage: async (docPath, relPath) => rawBytes(await invoke<ArrayBuffer | number[]>('read_document_image', { docPath, relPath })),
  saveHwpxAs: (bytes, suggestedName) => invoke<{ path: string } | null>('save_hwpx_as', { bytes: Array.from(bytes), suggestedName }),
  onFilesDropped: (handler) => listen<{ paths: string[] }>('files-dropped', ({ payload }) => handler(payload)),
  onOpened: (handler) => listen<{ path: string }>('file-opened', ({ payload }) => handler(payload)),
  onChanged: (handler) => listen<FileChanged>('file-changed', ({ payload }) => handler(payload)),
  takePending: () => invoke<string[]>('take_pending_files'),
  read: (path) => invoke<MarkdownFile>('read_markdown', { path }),
  watch: (path) => invoke<void>('watch_file', { path }),
  unwatch: () => invoke<void>('unwatch_file'),
  pick: () => invoke<string | null>('pick_markdown_file'),
  e2eConfig: () => invoke<E2eConfig | null>('e2e_config'),
  e2eGateOpen: () => invoke<boolean>('e2e_gate_open'),
  writeMarkdown: (path, content, expectedHash) => invoke<SavedMarkdown>('write_markdown', { path, content, expectedHash }),
  saveMarkdownAs: (content, suggestedName, previousPath) => invoke<SavedMarkdown | null>('save_markdown_as', { content, suggestedName, previousPath }),
  setDocumentDirty: (dirty) => invoke<void>('set_document_dirty', { dirty }),
  confirmClose: () => invoke<void>('confirm_close'),
  onCloseBlocked: (handler) => listen('close-blocked', () => handler()),
};

export const localImageUrl = (path: string) => convertFileSrc(path);
export const reportE2eState = (state: unknown) => invoke<void>('report_e2e_state', { json: JSON.stringify(state) });

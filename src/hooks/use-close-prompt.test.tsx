// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useClosePrompt } from './use-close-prompt';
import type { ClosePromptBridge, UnsavedChoice } from '@/data/tauri-bridge';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let host: HTMLDivElement; let blocked: boolean;
let reader: { closeBlocked: boolean; confirmClose: ReturnType<typeof vi.fn<(save: boolean) => Promise<void>>>; cancelClose: ReturnType<typeof vi.fn<() => void>> };
let bridge: ClosePromptBridge;
function Harness() { useClosePrompt({ ...reader, closeBlocked: blocked }, bridge); return null; }
const render = async () => { await act(async () => root.render(<Harness />)); };
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); blocked = true; reader = { closeBlocked: true, confirmClose: vi.fn<(save: boolean) => Promise<void>>().mockResolvedValue(undefined), cancelClose: vi.fn<() => void>() }; bridge = { askUnsavedChanges: vi.fn().mockResolvedValue('cancel') }; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it('does not ask without a blocked close', async () => { blocked = false; await render(); expect(bridge.askUnsavedChanges).not.toHaveBeenCalled(); });
it('saves then clears the prompt', async () => { vi.mocked(bridge.askUnsavedChanges).mockResolvedValue('save'); await render(); expect(reader.confirmClose).toHaveBeenCalledWith(true); expect(reader.cancelClose).toHaveBeenCalledOnce(); expect(reader.confirmClose.mock.invocationCallOrder[0]).toBeLessThan(reader.cancelClose.mock.invocationCallOrder[0]); });
it('discards and closes', async () => { vi.mocked(bridge.askUnsavedChanges).mockResolvedValue('discard'); await render(); expect(reader.confirmClose).toHaveBeenCalledWith(false); expect(reader.cancelClose).not.toHaveBeenCalled(); });
it('cancels without closing', async () => { await render(); expect(reader.cancelClose).toHaveBeenCalledOnce(); expect(reader.confirmClose).not.toHaveBeenCalled(); });
it('cancels after dialog failure', async () => { vi.mocked(bridge.askUnsavedChanges).mockRejectedValue(Error('dialog')); await render(); expect(reader.cancelClose).toHaveBeenCalledOnce(); });
it('does not open another dialog while one is pending', async () => { let resolve!: (v: UnsavedChoice) => void; vi.mocked(bridge.askUnsavedChanges).mockImplementation(() => new Promise(r => { resolve = r; })); await render(); await render(); expect(bridge.askUnsavedChanges).toHaveBeenCalledOnce(); await act(async () => resolve('cancel')); });
it('opens again after a new blocked request', async () => { await render(); blocked = false; await render(); blocked = true; await render(); expect(bridge.askUnsavedChanges).toHaveBeenCalledTimes(2); });
it('clears the prompt if saving throws', async () => { vi.mocked(bridge.askUnsavedChanges).mockResolvedValue('save'); reader.confirmClose.mockRejectedValue(Error('save')); await render(); expect(reader.cancelClose).toHaveBeenCalledOnce(); });

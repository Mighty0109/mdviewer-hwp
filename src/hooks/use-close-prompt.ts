'use client';
import { useEffect, useRef } from 'react';
import { fileBridge, type ClosePromptBridge } from '@/data/tauri-bridge';
import type { useOpenFile } from './use-open-file';
type Reader = Pick<ReturnType<typeof useOpenFile>, 'closeBlocked' | 'confirmClose' | 'cancelClose'>;
export function useClosePrompt(reader: Reader, bridge: ClosePromptBridge = fileBridge) {
  const current = useRef(reader); const open = useRef(false);
  useEffect(() => { current.current = reader; });
  useEffect(() => {
    if (!reader.closeBlocked || open.current) return;
    open.current = true;
    void (async () => {
      try {
        const choice = await bridge.askUnsavedChanges();
        if (choice === 'save') { await current.current.confirmClose(true); current.current.cancelClose(); }
        else if (choice === 'discard') await current.current.confirmClose(false);
        else current.current.cancelClose();
      } catch { current.current.cancelClose(); }
      finally { open.current = false; }
    })();
  }, [reader.closeBlocked, bridge]);
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OriginalDocument, OriginalViewMode } from '@/domain/original-view';
import type { OriginalViewState } from './use-original-view';

interface Timings {
  parseMs: number | null;
  firstPageMs: number | null;
  maxFrameGapMs: number | null;
}
const unmeasured: Timings = { parseMs: null, firstPageMs: null, maxFrameGapMs: null };
interface Measurement {
  source: OriginalDocument;
  start: number;
  lastFrame: number;
  maxGap: number;
  frame: number | null;
  finishing: boolean;
  timings: Timings;
}

/** E2E-only clock starts before setMode, including work before the first frame. */
export function useReaderReportOriginalTiming(enabled: boolean, source: OriginalDocument | null, original?: OriginalViewState) {
  const measurement = useRef<Measurement | null>(null);
  const [timings, setTimings] = useState(unmeasured);
  const stop = useCallback(() => {
    if (measurement.current?.frame != null) cancelAnimationFrame(measurement.current.frame);
    measurement.current = null;
  }, []);
  useEffect(() => {
    stop(); setTimings(unmeasured);
    return stop;
  }, [enabled, source, stop]);

  const setMode = useCallback((mode: OriginalViewMode) => {
    if (enabled && source && original?.available && mode === 'original' && original.mode !== 'original') {
      stop();
      const start = performance.now();
      const current: Measurement = { source, start, lastFrame: start, maxGap: 0, frame: null, finishing: false,
        timings: { ...unmeasured } };
      measurement.current = current;
      setTimings({ ...current.timings });
      const frame = () => {
        if (measurement.current !== current) return;
        const now = performance.now();
        current.maxGap = Math.max(current.maxGap, Math.round(now - current.lastFrame));
        current.lastFrame = now;
        // Wait for the first frame after completion: cancelling in the ready effect
        // would hide a synchronous WASM stall that ends before this callback runs.
        if (current.finishing) {
          current.frame = null;
          current.timings.maxFrameGapMs = current.maxGap;
          setTimings({ ...current.timings });
        } else current.frame = requestAnimationFrame(frame);
      };
      current.frame = requestAnimationFrame(frame);
    } else if (mode === 'markdown') {
      stop(); setTimings(unmeasured);
    }
    original?.setMode(mode);
  }, [enabled, source, original?.available, original?.mode, original?.setMode, stop]);

  useEffect(() => {
    const current = measurement.current;
    if (!enabled || !current || current.source !== source || original?.mode !== 'original') return;
    const elapsed = Math.round(performance.now() - current.start);
    let changed = false;
    if (original.status === 'ready' && current.timings.parseMs === null) {
      current.timings.parseMs = elapsed; changed = true;
    }
    if (current.timings.firstPageMs === null && Object.values(original.pageUrls).some(url => url.startsWith('blob:'))) {
      current.timings.firstPageMs = elapsed; changed = true;
    }
    if (current.timings.firstPageMs !== null || original.status === 'error') current.finishing = true;
    if (changed) setTimings({ ...current.timings });
  }, [enabled, source, original?.mode, original?.status, original?.pageUrls]);

  return { setMode, timings: enabled ? timings : unmeasured };
}

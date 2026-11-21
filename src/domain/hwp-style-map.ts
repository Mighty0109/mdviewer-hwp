export function headingLevelForStyle(name: string): number {
  const match = /^(?:개요|제목)\s*([1-9]\d*)$/.exec(name.trim());
  return match ? Math.min(Number(match[1]), 6) : 0;
}
export interface HwpParagraphStyle { heading: number; list?: 'ordered' | 'bullet'; level: number }
export function paragraphStyleFromFlags(flags: number): HwpParagraphStyle {
  const kind = (flags >>> 23) & 3;
  return { heading: 0, list: kind === 2 ? 'ordered' : kind === 3 ? 'bullet' : undefined, level: (flags >>> 25) & 7 };
}

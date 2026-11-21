import { maskMarkdownCode } from './markdown-code';

function normalize(path: string): string[] {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts;
}

function relative(path: string, directory: string): string {
  const destination = normalize(path);
  const origin = normalize(directory);
  while (destination.length && origin.length && destination[0] === origin[0]) { destination.shift(); origin.shift(); }
  return [...origin.map(() => '..'), ...destination].join('/') || '.';
}

/** Reverse Tauri asset URLs. Ordinary Markdown sources retain their exact spelling. */
export function toDocumentRelativeSrc(src: string, docDir: string): string {
  let path: string;
  if (/^asset:\/\//i.test(src)) path = src.replace(/^asset:\/\/(?:localhost)?/i, '');
  else if (/^https?:\/\/asset\.localhost\//i.test(src)) path = src.replace(/^https?:\/\/asset\.localhost/i, '');
  else return src;
  const suffix = path.match(/[?#].*$/)?.[0] || '';
  path = path.slice(0, path.length - suffix.length);
  try { path = decodeURIComponent(path); } catch { /* Literal percent filenames. */ }
  if (!docDir.startsWith('/') || !path.startsWith('/')) return src;
  return relative(path, docDir).split('/').map((part) => encodeURIComponent(part)).join('/') + suffix;
}

/** Rebase inline and reference image destinations, preserving code and all other text. */
export function rebaseRelativeImages(md: string, fromDir: string, toDir: string): string {
  if (fromDir === toDir || !fromDir.startsWith('/') || !toDir.startsWith('/')) return md;
  const masked = maskMarkdownCode(md);
  const edits: { start: number; end: number; value: string }[] = [];
  const imageRefs = new Set<string>();
  const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const add = (start: number, raw: string) => {
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(raw)) return;
    const suffix = raw.match(/[?#].*$/)?.[0] || '';
    const path = raw.slice(0, raw.length - suffix.length);
    // Keep existing URL escapes; normalize only path segments and encode spaces.
    const value = relative(`${fromDir}/${path}`, toDir).replace(/ /g, '%20') + suffix;
    if (value !== raw) edits.push({ start, end: start + raw.length, value });
  };
  // Balanced parentheses are allowed in an unbracketed Markdown destination.
  const image = /!\[((?:\\.|[^\]\\])*)\](?:\(\s*(<[^>\r\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))*)|\[([^\]\r\n]*)\])?/g;
  for (const match of masked.matchAll(image)) {
    if (match.index > 0 && md[match.index - 1] === '\\') continue;
    if (match[2] !== undefined) {
      const raw = match[2];
      const offset = match.index + match[0].lastIndexOf(raw);
      add(offset + (raw.startsWith('<') ? 1 : 0), raw.startsWith('<') ? raw.slice(1, -1) : raw);
    } else imageRefs.add(key(match[3] || match[1]));
  }
  for (const match of masked.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(<[^>\r\n]+>|\S+)/gm)) {
    if (!imageRefs.has(key(match[1]))) continue;
    const raw = match[2];
    add(match.index + match[0].lastIndexOf(raw) + (raw.startsWith('<') ? 1 : 0), raw.startsWith('<') ? raw.slice(1, -1) : raw);
  }
  let result = md;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

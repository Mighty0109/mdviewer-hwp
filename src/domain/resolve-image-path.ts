/** Resolve a Markdown image against a macOS document path, without filesystem IO. */
export function resolveImagePath(source: string, documentPath: string): string | null {
  if (/^(https?:|data:)/i.test(source)) return source;
  // Never turn unsupported URL schemes or protocol-relative URLs into local paths.
  if (!source || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) return null;
  if (!documentPath.startsWith('/')) return null;

  // Markdown URLs may encode spaces/Hangul; literal filenames can also contain '%'.
  let local = source.split(/[?#]/, 1)[0];
  try { local = decodeURIComponent(local); } catch { /* Keep literal percent signs. */ }
  if (!local || local.includes('\0')) return null;
  const path = local.startsWith('/') ? local : `${documentPath.slice(0, documentPath.lastIndexOf('/'))}/${local}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

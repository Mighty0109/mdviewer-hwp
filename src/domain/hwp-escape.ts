/** Literal document text must not become Markdown syntax or unsupported HTML/math. */
export function escapeHwpMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\])<>#+.!|$~\-])/g, '\\$1');
}
export const escapeMarkdown = escapeHwpMarkdown;
export function escapeHwpHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

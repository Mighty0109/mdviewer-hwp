// All dynamic XML text and attribute values pass through these helpers.
export function cleanXml(value: string): string {
  // XML 1.0 excludes controls, unpaired UTF-16 surrogates and U+FFFE/U+FFFF.
  return Array.from(value, char => {
    const n = char.codePointAt(0)!;
    return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff)
      || (n >= 0xe000 && n <= 0xfffd) || n >= 0x10000 ? char : '\ufffd';
  }).join('');
}

export function escapeXml(value: string | number | boolean): string {
  return cleanXml(String(value)).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[ch]!);
}

export function element(name: string, attrs: Record<string, string | number | boolean> = {}, content?: string): string {
  const attributes = Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  return content === undefined ? `<${name}${attributes}/>` : `<${name}${attributes}>${content}</${name}>`;
}

export const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const NS = {
  hh: 'http://www.hancom.co.kr/hwpml/2011/head',
  hp: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  hs: 'http://www.hancom.co.kr/hwpml/2011/section',
  hc: 'http://www.hancom.co.kr/hwpml/2011/core',
};
export const namespaces = Object.fromEntries(Object.entries(NS).map(([key, value]) => [`xmlns:${key}`, value]));

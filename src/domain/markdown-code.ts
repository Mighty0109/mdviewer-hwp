/** Mask code without moving offsets, so syntax checks/URL edits never touch examples. */
export function maskMarkdownCode(markdown: string): string {
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  let fence: { marker: string; length: number } | null = null;
  const blocks = markdown.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/g, (line) => {
    const body = line.replace(/^(?: {0,3}>[ \t]?)+/, '').replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/, '');
    const match = body.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return blank(line);
    }
    if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      fence = { marker: match[1][0], length: match[1].length };
      return blank(line);
    }
    return line;
  });
  const runs = [...blocks.matchAll(/`+/g)].filter((run) => {
    const prefix = blocks.slice(blocks.lastIndexOf('\n', run.index - 1) + 1, run.index);
    return !/^(?: {4,}|\t)[ \t]*$/.test(prefix);
  });
  const nextSame: (number | undefined)[] = [];
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    nextSame[index] = nextByLength.get(runs[index][0].length);
    nextByLength.set(runs[index][0].length, index);
  }
  let result = '';
  let offset = 0;
  for (let index = 0; index < runs.length; index++) {
    const opening = runs[index];
    let slashes = 0;
    for (let cursor = opening.index - 1; cursor >= 0 && blocks[cursor] === '\\'; cursor--) slashes++;
    if (slashes % 2) continue;
    const closingIndex = nextSame[index];
    if (closingIndex === undefined) continue;
    const end = runs[closingIndex].index + runs[closingIndex][0].length;
    result += blocks.slice(offset, opening.index) + blank(blocks.slice(opening.index, end));
    offset = end;
    index = closingIndex;
  }
  return result + blocks.slice(offset);
}

export interface DocumentEnvelope {
  eol: '\n' | '\r\n' | '\r';
  trailingNewline: boolean;
  trailingNewlines: number;
  bom: boolean;
}

export function detectEnvelope(original: string): DocumentEnvelope {
  const eol = original.match(/\r\n|\n|\r/)?.[0] as DocumentEnvelope['eol'] | undefined;
  const suffix = original.match(/(?:\r\n|\n|\r)+$/)?.[0] || '';
  const trailingNewlines = suffix.match(/\r\n|\n|\r/g)?.length || 0;
  return { eol: eol || '\n', trailingNewline: trailingNewlines > 0, trailingNewlines, bom: original.startsWith('\uFEFF') };
}

/** Rich serialization only. Source edits must be written as their exact string. */
export function applyEnvelope(serialized: string, envelope: DocumentEnvelope): string {
  const body = serialized.replace(/^\uFEFF/, '').replace(/(?:\r\n|\n|\r)+$/, '').replace(/\r\n|\n|\r/g, envelope.eol);
  return (envelope.bom ? '\uFEFF' : '') + body + envelope.eol.repeat(envelope.trailingNewlines);
}

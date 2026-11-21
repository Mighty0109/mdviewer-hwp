import { describe, expect, it } from 'vitest';
import { applyEnvelope, detectEnvelope } from './document-envelope';

describe('document envelope', () => {
  it.each(['한글\r\n본문\r\n', '한글\n본문', '한글\r본문\r\r', '\uFEFF한글\r\n본문\r\n\r\n', ''])('restores EOL, BOM and EOF for %j', (original) => {
    const serialized = original.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').trimEnd();
    const envelope = detectEnvelope(original);
    expect(applyEnvelope(serialized, envelope)).toBe(original);
    expect(applyEnvelope(applyEnvelope(serialized, envelope), envelope)).toBe(original);
  });
  it('does not alter whitespace inside code lines', () => {
    expect(applyEnvelope('```\na  \n```', detectEnvelope('original\r\n'))).toBe('```\r\na  \r\n```\r\n');
  });
});

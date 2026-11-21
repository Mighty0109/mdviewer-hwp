import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseHwp } from './index';

// Captured before attempt 4 production edits: both source bytes and full import output.
// 3.1 updates only the header/footer lines and removed exclusion warning; fixture bytes stay fixed.
it.each(['hwp', 'hwpx'])('keeps the existing %s fixture bytes and import output unchanged', async kind => {
  const bytes = new Uint8Array(await readFile(new URL(`../../../../fixtures/hwp/synthetic.${kind}`, import.meta.url)));
  const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  const result = await parseHwp(bytes);
  expect({ sourceSha256: sha(bytes), ...result,
    assets: result.assets.map(({ bytes, ...asset }) => ({ ...asset, sha256: sha(bytes) })),
  }).toMatchSnapshot();
});

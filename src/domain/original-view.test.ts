import { describe, expect, it } from 'vitest';
import { OriginalViewError, ORIGINAL_VIEW_LABELS, type OriginalViewErrorCode } from './original-view';

describe('original view contract', () => {
  it.each<OriginalViewErrorCode>(['wasm-load', 'unsupported', 'corrupt', 'render'])(
    'keeps the %s error code and readable reason available to the ViewModel', code => {
      const error = new OriginalViewError(code, '구체적인 실패 이유');
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: 'OriginalViewError', code, reason: '구체적인 실패 이유', message: '구체적인 실패 이유' });
    },
  );

  it('names the preview choices and distinguishes the import snapshot', () => {
    expect(ORIGINAL_VIEW_LABELS).toMatchObject({
      markdown: '마크다운 미리보기', original: '원본 모양', snapshot: '원본(가져온 시점)',
    });
  });
});

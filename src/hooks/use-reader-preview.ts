'use client';

import { useCallback, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { markdownToHtmlAsync } from '@/lib/markdown';

const SAMPLE = `# MDViewer에 오신 것을 환영합니다

한글 마크다운 문서를 편안하게 읽어보세요.

## 표와 코드

| 기능 | 상태 |
| --- | --- |
| 한글 문서 | 읽기 전용 |
| 목차 | 제목으로 이동 |

\`\`\`rust
fn main() {
    println!("안녕하세요, MDViewer!");
}
\`\`\`

### 체크리스트

- [x] 한글 제목과 본문
- [ ] 다음 문서 읽기

## 이미지

![MDView 로고](/logo.png)
`;

/** Preview ViewModel; the next stage connects file loading to this shell. */
export function useReaderPreview() {
  const [html, setHtml] = useState('');
  const [title, setTitle] = useState('');
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const request = useRef(0);

  const showSample = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const content = await markdownToHtmlAsync(SAMPLE);
      if (id !== request.current) return;
      setHtml(content);
      setTitle('샘플 문서.md');
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  const closeSample = useCallback(() => {
    ++request.current;
    setHtml('');
    setTitle('');
    setEditor(null);
    setError(null);
    setLoading(false);
  }, []);

  return { html, title, isLoading, error, editor, setEditor, showSample, closeSample };
}

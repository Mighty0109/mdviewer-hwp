'use client';

import type { useOpenFile } from '@/hooks/use-open-file';

type Reader = ReturnType<typeof useOpenFile>;
export function FileNotices({ reader }: { reader: Reader }) {
  const busy = reader.saveStatus === 'saving';
  return <>
    {(reader.externalPending || reader.saveStatus === 'conflict') && <div role="alert" className="document-notice">
      <p>파일이 외부에서 변경되었습니다. 편집 내용은 유지했습니다. 다시 불러오면 현재 편집 내용이 사라집니다.</p>
      <button disabled={busy} onClick={reader.reloadFromDisk}>다시 불러오기 (내 변경 버림)</button>
      <button disabled={busy} onClick={reader.saveAs}>다른 이름으로 저장</button>
    </div>}
  </>;
}

import { Modal } from '@/components/ui/modal';

const labels: Record<string, string> = {
  'table-raw-html': '병합 표를 HTML로 보존했습니다. 소스 모드로 편집합니다.',
  'table-nested-flattened': '중첩 표를 바깥 셀의 텍스트로 펼쳤습니다.',
  'table-cell-flattened': '표 셀 안의 여러 문단·줄바꿈·제목·목록을 한 칸 텍스트로 펼쳤습니다.',
  'image-skipped': '그림을 제외하고 본문에 자리 표시를 남겼습니다.',
  'footnote-skipped': '각주·미주를 본문에서 제외했습니다.',
  'textbox-text-only': '글상자는 텍스트만 가져왔습니다.',
  'equation-skipped': '수식을 제외했습니다.', 'shape-skipped': '도형을 제외했습니다.',
  'object-skipped': '지원하지 않는 개체를 제외했습니다.',
  'change-tracking-ignored': '변경 추적 기록을 제외하고 최종 텍스트를 가져왔습니다.',
  'image-missing': '그림 파일을 읽지 못해 제외했습니다.',
  'image-remote': '외부 네트워크 그림을 제외했습니다.', 'image-format': '지원하지 않는 그림 형식을 제외했습니다.',
  'image-limit': '그림 개수 또는 크기 상한을 넘어 제외했습니다.',
  'inline-format-simplified': '인라인 서식·링크를 문단 단위로 단순화했습니다.',
  'unsupported-markdown': '일부 마크다운 요소를 텍스트로 변환했습니다.',
  'xml-character-replaced': 'XML에서 허용하지 않는 문자를 치환했습니다.',
  'list-level-simplified': '목록 들여쓰기를 단순화했습니다.',
};
const objectDetails: Record<string, string> = {
  'caption-layout': '캡션의 텍스트를 가져오고 배치를 단순화했습니다.',
  'field-metadata': '필드의 표시 글을 가져오고 하이퍼링크 대상 등 부가 정보를 제외했습니다.',
};
const imageDetails: Record<string, string> = {
  format: '지원하지 않는 그림 형식',
  size: '그림 크기 상한 초과',
  count: '그림 개수 상한 초과',
  missing: '그림 파일을 찾지 못함',
};
export function HwpWarnings({ open, onClose, title, warnings }: {
  open: boolean; onClose(): void; title: string;
  warnings: { code: string; count: number; detail?: string }[];
}) {
  return <Modal open={open} onClose={onClose} title={title}>
    <p className="mb-3 text-sm">변환 중 다음 항목이 제외되거나 단순화되었습니다.</p>
    <ul className="max-h-80 list-disc space-y-2 overflow-y-auto pl-5 text-sm">
      {warnings.map((warning, index) => {
        const detailLabel = warning.code === 'object-skipped' ? objectDetails[warning.detail ?? ''] : undefined;
        return <li key={index} data-warning-code={warning.code}>
          {detailLabel ?? labels[warning.code] ?? warning.code} ({warning.count}건)
          {warning.detail && !detailLabel && <p className="break-words text-xs text-[var(--color-text-secondary)]">{warning.code === 'image-skipped' && Object.hasOwn(imageDetails, warning.detail) ? imageDetails[warning.detail] : warning.detail}</p>}
        </li>;
      })}
    </ul>
    <button className="mt-4 rounded bg-[var(--color-accent)] px-4 py-2 text-sm text-white" onClick={onClose}>확인</button>
  </Modal>;
}
export function HwpProgress({ percent, message, onCancel }: { percent: number; message: string; onCancel(): void }) {
  return <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-2 text-xs" role="status" aria-live="polite">
    <span>{message}</span><progress aria-label={message} max={100} value={percent} className="min-w-20 flex-1" />
    <span>{percent}%</span><button onClick={onCancel}>변환 취소</button>
  </div>;
}

#!/bin/bash
# Run from any directory; select one scenario and optionally an already built .app.
# Build the app before running this check.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
APP="$ROOT/src-tauri/target/release/bundle/macos/MDViewer.app"
SCENARIO=all
QUERY='자동 새로고침'
MDVIEWER_E2E_ORIGINAL='@original-view'

usage() {
  echo '사용법: bash scripts/e2e.sh [시나리오] [MDViewer.app 경로]'
  echo '시나리오: all (기본), reader, save, conflict, import-hwp, import-hwpx, import-captions-fields, original-sample, original-big'
  echo '앱 경로만 주는 기존 호출도 지원합니다. 인자 없으면 기존 전체와 원본 시나리오 둘 다 실행합니다.'
  echo '환경 변수: HWP_SAMPLE=정확히 2쪽인 HWP 파일 경로 (original-sample 필수, 예: HWP_SAMPLE=/path/to/sample.hwp bash scripts/e2e.sh original-sample)'
  echo '종료 코드: 0=단언 완료, 1=검사 실패(샘플 없음 포함), 2=사용법/환경으로 검증 미완료, 3=큰 문서 예산 초과(사용자 판단 필요)'
}
if [[ $# -gt 2 ]]; then usage >&2; exit 2; fi
case ${1:-all} in
  -h|--help) usage; exit 0 ;;
  all|reader|save|conflict|import-hwp|import-hwpx|import-captions-fields|original-sample|original-big)
    SCENARIO=${1:-all}
    APP=${2:-"$APP"}
    ;;
  *.app)
    if [[ $# -ne 1 ]]; then usage >&2; exit 2; fi
    APP=$1
    ;;
  *) usage >&2; exit 2 ;;
esac
selected() { [[ "$SCENARIO" == all || "$SCENARIO" == "$1" ]]; }

if [[ $(uname -s) != Darwin ]]; then
  echo '검증 미완료: macOS GUI 세션과 open 명령이 필요합니다.' >&2
  exit 2
fi
if [[ ! -d "$APP" ]]; then
  echo "검증 미완료: 앱 번들이 없습니다: $APP (먼저 npx tauri build --bundles app 실행)" >&2
  exit 2
fi
command -v node >/dev/null || { echo '검증 미완료: node가 필요합니다.' >&2; exit 2; }
APP=$(cd "$APP" && pwd -P)
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
APP_BINARY="$APP/Contents/MacOS/$EXECUTABLE"
[[ -x "$APP_BINARY" ]] || { echo "앱 실행 파일이 없습니다: $APP_BINARY" >&2; exit 2; }
if ! /bin/ps -p "$$" -o pid= >/dev/null 2>&1; then
  echo '검증 미완료: 샌드박스가 프로세스 조회를 차단해 테스트 앱 인스턴스를 안전하게 추적·종료할 수 없습니다.' >&2
  exit 2
fi

# Match literal executable paths, not a name/regex that could stop unrelated apps.
app_pids() {
  /bin/ps -axo pid=,comm= | while read -r pid executable; do
    if [[ "$executable" == "$APP_BINARY" ]]; then printf '%s\n' "$pid"; fi
  done
}
EXISTING_PIDS=" $(app_pids | tr '\n' ' ') "
# Scratch files stay within the worker's owned tree, including the image copy.
WORK=$(mktemp -d "$ROOT/scripts/.e2e.XXXXXX")
STATE="$WORK/state.json"
ORIGINAL_SOURCE=''
ORIGINAL_HASH=''
stop_test_apps() {
  local pid attempt
  for pid in $(app_pids); do
    case "$EXISTING_PIDS" in *" $pid "*) continue ;; esac
    kill -TERM "$pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 20; attempt++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    # Re-check executable identity before forcing a lingering test instance out.
    if [[ " $(app_pids | tr '\n' ' ') " == *" $pid "* ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
}
verify_original_hash() {
  [[ -n "$ORIGINAL_SOURCE" ]] || return 0
  local after
  if ! after=$(shasum -a 256 "$ORIGINAL_SOURCE" 2>/dev/null | awk '{print $1}'); then
    echo '원본 SHA-256 재검사 실패: 파일을 읽을 수 없습니다.' >&2
    return 1
  fi
  if [[ "$after" != "$ORIGINAL_HASH" ]]; then
    echo '한글 원본의 SHA-256이 바뀌었습니다.' >&2
    return 1
  fi
  echo '원본 SHA-256 전후 동일'
  ORIGINAL_SOURCE=''
}
cleanup() {
  local result=$? log
  trap - EXIT INT TERM
  set +e
  stop_test_apps
  verify_original_hash || result=1
  if [[ $result -ne 0 ]]; then
    echo "e2e 종료 코드: $result — 원본 샘플 상태·앱 로그는 출력하지 않습니다." >&2
    for log in "$WORK"/*.json "$WORK"/*.log; do
      case "$log" in "$WORK"/original-*) continue ;; esac
      if [[ -f "$log" ]]; then
        printf '\n%s\n' "$log" >&2
        tail -c 16000 "$log" >&2
      fi
    done
  fi
  rm -rf "$WORK"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Separate scratch documents and app instances prevent state/loadCount leakage.
prepare_document() {
  local scenario=$1
  mkdir -p "$WORK/$scenario/한글 문서/img"
  DOCUMENT="$WORK/$scenario/한글 문서/sample-ko.md"
  cp "$ROOT/fixtures/sample-ko.md" "$DOCUMENT"
  cp "$ROOT/fixtures/img/sample.png" "$WORK/$scenario/한글 문서/img/sample.png"
  STATE="$WORK/$scenario-state.json"
}
launch_app() {
  local scenario=$1 edit=${2:-} gate=${3:-} import_path=${4:-} save_path=${5:-} export_path=${6:-}
  local query=${7:-"$QUERY"} stdout="$WORK/$1-stdout.log" stderr="$WORK/$1-stderr.log"
  # Private sample content must never leak through native/WASM diagnostics.
  case "$scenario" in original-*) stdout=/dev/null; stderr=/dev/null ;; esac
  # Empty "$@" is safe with nounset in macOS Bash 3.2; an empty array is not.
  if [[ -z "$import_path" ]]; then set -- "$DOCUMENT"; else set --; fi
  # File is an Opened event, deliberately outside --args (double-click route).
  # Explicit empty values also prevent inherited E2E editing in the reader case.
  if ! /usr/bin/open -n -a "$APP" \
    --env "MDVIEWER_E2E_STATE=$STATE" --env "MDVIEWER_E2E_QUERY=$query" \
    --env "MDVIEWER_E2E_EDIT=$edit" --env "MDVIEWER_E2E_SAVE_GATE=$gate" \
    --env "MDVIEWER_E2E_IMPORT=$import_path" --env "MDVIEWER_E2E_IMPORT_SAVE=$save_path" \
    --env "MDVIEWER_E2E_EXPORT=$export_path" \
    --stdout "$stdout" --stderr "$stderr" "$@"; then
    echo '검증 미완료: open -a 실행 실패. macOS GUI 세션을 확인하세요.' >&2
    exit 2
  fi
}
check_state() {
  if ! node "$ROOT/scripts/e2e-state.mjs" "$STATE" "$DOCUMENT" "$QUERY" "$@"; then
    if [[ ! -f "$STATE" ]]; then
      echo '검증 미완료: 앱 상태 JSON이 없습니다. GUI 세션·앱 시작·상태 보고를 확인하세요.' >&2
    fi
    exit 1
  fi
}

if selected reader; then
prepare_document reader
launch_app reader
echo '최초 렌더·상대 경로 이미지·목차·검색 상태 확인'
check_state - "$WORK/initial.json"
# Modify only the scratch document, never the checked-in fixture.
printf '\n외부 수정 감지: 자동 새로고침 확인용 본문을 추가했습니다.\n' >> "$DOCUMENT"
echo '외부 수정 후 loadCount 증가·hash 변경·렌더 유지 확인'
check_state "$WORK/initial.json" "$WORK/reloaded.json"
stop_test_apps
fi

EDIT='E2E 블록 편집: 한글 문장을 추가하고 안전하게 저장합니다.'
if selected save; then
prepare_document save
GATE="$WORK/save.gate"
launch_app save "$EDIT" "$GATE"
echo '블록 편집 후 dirty 표시·저장 전 디스크 무변경 확인'
check_state - "$WORK/save-edited.json" --phase edited --unchanged "$ROOT/fixtures/sample-ko.md"
touch "$GATE"
echo '편집 저장 후 디스크 추가 문장·표·코드·체크리스트·상대 이미지 보존 및 자기 쓰기 무시 확인'
# Observe beyond watcher debounce/polling, not just the first saved report.
check_state "$WORK/save-edited.json" "$WORK/saved.json" --phase saved \
  --edit "$EDIT" --original "$ROOT/fixtures/sample-ko.md" --stable-ms 2000
stop_test_apps
fi

if selected conflict; then
prepare_document conflict
GATE="$WORK/conflict.gate"
launch_app conflict "$EDIT" "$GATE"
check_state - "$WORK/conflict-edited.json" --phase edited --unchanged "$ROOT/fixtures/sample-ko.md"
printf '\n외부 변경 우선: 편집 중인 문서를 덮어쓰면 안 됩니다.\n' >> "$DOCUMENT"
cp "$DOCUMENT" "$WORK/external.md"
# Let the watcher see the external edit while the app is dirty and save is gated.
echo '편집 중 외부 변경이 자동 재읽기를 일으키지 않는지 확인'
check_state "$WORK/conflict-edited.json" "$WORK/conflict-pending.json" --phase edited \
  --unchanged "$WORK/external.md" --stable-ms 1000
touch "$GATE"
echo '게이트 해제 후 conflict 알림·dirty 유지·외부 디스크 바이트 보존 확인'
check_state "$WORK/conflict-edited.json" "$WORK/conflict.json" --phase conflict \
  --unchanged "$WORK/external.md" --stable-ms 2000
stop_test_apps
fi

# This loop copies only public synthetic fixtures. Original scenarios below read
# private samples (HWP_SAMPLE and ~/Downloads) in place without saving or exporting the import.
for fixture in hwp hwpx captions-fields; do
  kind=$fixture
  if [[ "$fixture" == captions-fields ]]; then kind=hwpx; fi
  scenario="import-$fixture"
  if ! selected "$scenario"; then continue; fi
  folder="$WORK/$scenario/한글 문서"
  mkdir -p "$folder"
  source="$folder/가져오기 원본.$kind"
  DOCUMENT="$folder/가져온 문서.md"
  export_path="$folder/내보낸 문서.hwpx"
  STATE="$WORK/$scenario-state.json"
  GATE="$WORK/$scenario.gate"
  set --
  if [[ "$fixture" == captions-fields ]]; then
    node "$ROOT/scripts/hwp-e2e-fixture.mjs" "$source"
    set -- --import-expectations "$ROOT/fixtures/hwp/captions-fields.expected.json"
  else
    cp "$ROOT/fixtures/hwp/synthetic.$kind" "$source"
  fi
  before=$(shasum -a 256 "$source" | awk '{print $1}')
  launch_app "$scenario" '' "$GATE" "$source" "$DOCUMENT" "$export_path"
  echo "$kind 가져오기: 이름 없는 dirty 문서·원본 무변경·자동 md 미생성 확인"
  node "$ROOT/scripts/e2e-state.mjs" "$STATE" "$source" "$QUERY" - "$WORK/$scenario-imported.json" \
    --phase imported --kind "$kind" "$@"
  [[ ! -e "$DOCUMENT" && ! -e "${source%.*}.md" ]] || { echo '가져오기만으로 md가 생성됐습니다.' >&2; exit 1; }
  touch "$GATE"
  echo "$kind 첫 저장: md·상대 이미지 자산·해시·HWPX ZIP 구조 확인"
  node "$ROOT/scripts/e2e-state.mjs" "$STATE" "$DOCUMENT" "$QUERY" "$WORK/$scenario-imported.json" "$WORK/$scenario-exported.json" \
    --phase exported --kind "$kind" --export "$export_path" --stable-ms 1500 "$@"
  after=$(shasum -a 256 "$source" | awk '{print $1}')
  [[ "$before" == "$after" ]] || { echo '한글 원본의 SHA-256이 바뀌었습니다.' >&2; exit 1; }
  [[ ! -e "${source%.*}.md" ]] || { echo '원본 옆에 자동 md가 생성됐습니다.' >&2; exit 1; }
  stop_test_apps
done

run_original() {
  local scenario=$1 source='' bytes=0 candidate size result=0
  if [[ "$scenario" == original-sample ]]; then
    source=${HWP_SAMPLE:-}
    [[ -n "$source" ]] || { echo 'original-sample 실패: 환경 변수 HWP_SAMPLE에 정확히 2쪽인 HWP 파일 경로를 지정하세요. 예: HWP_SAMPLE=/path/to/sample.hwp bash scripts/e2e.sh original-sample' >&2; return 1; }
    [[ -f "$source" && -r "$source" ]] || { echo 'original-sample 실패: HWP_SAMPLE 파일이 없거나 읽을 수 없습니다.' >&2; return 1; }
    bytes=$(stat -L -f '%z' "$source" 2>/dev/null)
  else
    for candidate in "$HOME"/Downloads/*.hwp; do
      [[ -f "$candidate" ]] || continue
      size=$(stat -L -f '%z' "$candidate" 2>/dev/null)
      if [[ "$size" -gt "$bytes" ]]; then source=$candidate; bytes=$size; fi
    done
    [[ -n "$source" && "$bytes" -ge 5000000 ]] || { echo 'original-big 실패: 5,000,000바이트 이상의 HWP 샘플이 없습니다.' >&2; return 1; }
    [[ -r "$source" ]] || { echo 'original-big 실패: 가장 큰 HWP 샘플을 읽을 수 없습니다.' >&2; return 1; }
  fi
  ORIGINAL_HASH=$(shasum -a 256 "$source" 2>/dev/null | awk '{print $1}')
  ORIGINAL_SOURCE=$source
  STATE="$WORK/$scenario-state.json"
  printf '%s: sourceBytes=%s\n' "$scenario" "$bytes"
  launch_app "$scenario" '' '' "$source" '' '' "$MDVIEWER_E2E_ORIGINAL"
  node "$ROOT/scripts/e2e-state.mjs" "$STATE" "$source" "$MDVIEWER_E2E_ORIGINAL" - "$WORK/$scenario-stats.json" \
    --phase "$scenario" --timeout-ms 60000 || result=$?
  if [[ ! -f "$STATE" ]]; then
    echo '검증 미완료: 앱 상태 JSON이 없습니다. GUI 세션·앱 시작·상태 보고를 확인하세요.' >&2
    result=2
  fi
  stop_test_apps
  verify_original_hash || return 1
  return "$result"
}
if selected original-sample; then run_original original-sample; fi
if selected original-big; then run_original original-big; fi
echo 'e2e 자동 단언 완료 (한컴 오피스 열기·가져오기 대화상자·끌어다 놓기·큰 파일 화면 응답성·실제 키보드 ⌘S/⇧⌘S/⌘N·블록 끌기·슬래시 메뉴·⌘Q·더블클릭은 별도 실기 확인 항목)'

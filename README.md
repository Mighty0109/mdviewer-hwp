# MDViewer

macOS용 마크다운 뷰어·블록 편집기. 마크다운을 **한글(HWPX)로 내보내고**, 한글(HWP) 문서를 마크다운으로 가져올 수 있다.

[Tauri v2](https://tauri.app)(Rust) + Next.js(TypeScript) 기반. 원본 [revfactory/mdview](https://github.com/revfactory/mdview)(Apache-2.0)를 데스크톱 앱으로 옮기고 HWP 기능을 더했다.

## 기능

- 마크다운 읽기, 블록 단위 편집, 해시 확인 저장(다른 곳에서 바뀐 파일을 덮어쓰지 않음)
- 파일 변경 감시, 문서 내 검색, 빠른 열기, 슬래시 명령
- **마크다운 → HWPX 내보내기**: 제목, 문단, 중첩 목록, 표(셀 안 이미지 포함), 이미지, 코드 블록, 인용문
- **마크다운 → Word(.docx) 저장**
- **HWP → 마크다운 가져오기**

## 설치

### 받아서 쓰기

[Releases](../../releases)에서 `MDViewer.zip`을 받아 풀고 `MDViewer.app`을 `/Applications`에 넣는다.

- Apple Silicon(M1 이상) 맥 전용이다. Intel 맥은 아래 소스 빌드를 쓴다.
- 서명·공증이 없는 앱이라 처음 열 때 맥이 막는다. 앱을 우클릭 → 열기 → 열기를 누르거나, 터미널에서 한 번 실행한다.

  ```sh
  xattr -dr com.apple.quarantine /Applications/MDViewer.app
  ```

### 소스에서 빌드

필요한 것: macOS, [Node.js](https://nodejs.org), [Rust](https://rustup.rs), Xcode Command Line Tools(`xcode-select --install`).

```sh
git clone https://github.com/Mighty0109/mdviewer-hwp.git
cd mdviewer-hwp
npm install
npm run tauri build -- --bundles app
```

결과물은 `src-tauri/target/release/bundle/macos/MDViewer.app`이다. 개발 모드는 `npm run tauri dev`, 테스트는 `npm test`.

## 한계 (솔직하게)

- **한컴에서 열리는지는 문서 2종(글자만 있는 문서, 이미지 포함 문서)으로만 직접 확인했다.** 다른 문서의 열림은 보장하지 못한다. 열리지 않는 문서를 만나면 이슈로 알려 달라.
- HWPX 내보내기에서 굵게·기울임·링크 같은 인라인 서식은 글자만 남고 사라진다(경고가 표시된다).
- 보이는 모양이 앱 미리보기와 다르다: 이미지가 문단 왼쪽에 붙고, 제목은 명조 계열 글꼴, 인용문은 들여쓰기만 된다.
- 원시 HTML은 글자 그대로 남는다.
- macOS 전용이다. 윈도우는 지원하지 않는다.

## 라이선스

Apache License 2.0. 원본 MDView의 고지는 [NOTICE](NOTICE)에 있다.

# Pure HWP / HWPX import

`parseHwp(bytes, onProgress?, expectedFormat?)` from `./index` auto-detects HWP
5.x CFB or HWPX ZIP and returns a promise of `{ markdown, warnings, assets, stats }`.
An optional third argument (`hwp` / `hwpx`) rejects extension/content mismatches.
`parseHwpx(bytes, onProgress?)` requires HWPX. Progress is `(percent, message)`;
the parser has no Worker globals, file APIs, network, or DOM dependency. Input
bytes remain unchanged. Failures throw `HwpImportError` with a domain error code.

Assets are `{ name, mimeType, bytes: Uint8Array }` in first-reference order,
deduplicated by binary reference ID. Markdown references
`mdviewer-import-assets/` + `name`; merged HTML tables use the same prefix in
`<img src>`. Callers keep these bytes in memory until explicit Save As.
`stats.images` counts retained occurrences; `assets.length` counts unique assets.
`imageMappings + skippedImages === imageReferences`. Statistics for paragraphs
include visible exclusion placeholders and cell text; headings are counted
separately. Warning counts aggregate by code and reason.

Supported: paragraph text (including literal Markdown punctuation), tabs, line
breaks, headings from Korean `개요 N` / `제목 N` styles (clamped to 6), numbered
and bulleted paragraphs, GFM tables, merged HTML tables, and PNG/JPEG/GIF/BMP
assets. Large text with a normal style remains a paragraph. Nested tables are
flattened with a warning and visible label. Header/footer and footnote/endnote
text are excluded with warnings and placeholders. Textboxes retain text and
warn. Equations, shapes, OLE, unsupported controls and images leave warnings
and placeholders. HWPX deletion ranges are omitted for final text and warn;
insertions retain text and warn. Unknown XML extensions also warn.

Table and picture captions retain their paragraphs next to the object. HWP table
caption lists before TABLE are parsed separately from cell lists; nested tables
inside those captions cannot supply the parent table's dimensions. HWPX caption
subtrees use the normal paragraph reader, including image, footnote and tracked
deletion policies. Caption placement is flattened with `object-skipped`
(`detail: caption-layout`) and `[캡션 배치 제외: 텍스트만 가져옴]` in the body.
Binary picture caption text continues through the existing text-only gso path,
with its `textbox-text-only` warning and label. HWPX field metadata (including
hyperlink targets) is omitted once per field with `object-skipped`
(`detail: field-metadata`) and `[필드 정보 제외: 표시 글만 가져옴]`; display text
in subsequent runs is retained. No new warning codes or public API are needed.

HWP pictures use record tag 85, BinData reference at byte 71, DocInfo BIN_DATA
storage mapping, hexadecimal BIN names, and per-BinData compression flags.
There is no sequential-image fallback. Image limits are explicit domain
constants: 8 MiB each, 64 MiB total, 500 unique images. Unsupported or excluded
images report `image-skipped` with `format`, `size`, `count`, or `missing`.

The XML tokenizer resolves namespace bindings, attributes, numeric/predefined
entities and CDATA. It rejects DTDs, external entities, malformed trees and
excessive nesting. A tokenizer was chosen because DOMParser is unavailable in
Web Workers, while importing jsdom into the production bundle would introduce
Node APIs. ZIP central-directory checks happen before bounded streaming
inflation (2000 entries, 64 MiB per entry, 200 MiB total); local names, CRCs,
sizes, paths, duplicate entries and encryption are checked. CFB FAT, mini-FAT
and directory graphs are bounded before the cfb reader follows pointers.

## Verification

`UPDATE_FIXTURES=1 npx vitest run src/lib/hwp/parse/parse.test.ts` regenerates
only the two synthetic fixtures in this checkout. Ordinary tests assert exact
fixture bytes and do not write them. Synthetic builders cover protected files,
corrupt records/archives, graph cycles, expansion limits, image mapping,
merged/nested tables, tracking, and exclusion warnings.
`captions-fields.test.ts` reproduces the attempt-1 caption/field data losses and
covers text order, multiple caption paragraphs, empty captions, nested caption
tables/pictures, caption exclusions, field warning counts and input immutability.

There are no real HWPX samples on this Mac. Synthetic tests establish parser
behavior, not Hancom compatibility. Opening exported HWPX in Hancom, visual
image placement, dialog/drop behavior and responsiveness remain manual checks.

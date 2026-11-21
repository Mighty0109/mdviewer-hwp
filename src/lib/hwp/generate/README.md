# HWPX generator

`generateHwpx(markdown, resolveImage?)` returns
`Promise<{ bytes: Uint8Array, warnings: ExportWarning[] }>`. Import it from
`src/lib/hwp/generate/index.ts`; the app node re-exports it from `src/lib/hwp/index.ts`.
The function is independent of `self`, DOM APIs, filesystem APIs and network APIs.
The app's worker wrapper owns progress messages and cancellation.

`resolveImage(source)` receives a Markdown image destination unchanged except for
HTML character reference decoding. It returns `Uint8Array`,
`{ bytes: Uint8Array, mimeType?: string, width?: number, height?: number }`,
or `null`/`undefined`, synchronously or asynchronously. The app supplies relative
document images and pending import assets. The generator handles data URLs itself
and never calls the resolver for HTTP(S) or protocol-relative URLs. The bytes'
signature determines the embedded PNG/JPEG/GIF/BMP type; MIME hints and file
extensions cannot override it. Images are capped at 8 MiB each, 64 MiB combined,
and 500 occurrences. Every excluded image leaves a visible placeholder and warning.

Headings 1–6, paragraphs, nested lists, GFM tables (including cell images), images,
code blocks and quotations produce OWPML elements. Heading style names are `제목 N`.
Number/bullet paragraph properties carry zero-based nesting levels; numbering IDs
and starts belong to separate lists. Code is a fixed-width paragraph and quotations
have paragraph indentation. Inline emphasis/link/code formatting is reduced to
plain text and reports one `inline-format-simplified` warning per document.
Other warnings aggregate by code and detail, with `count` equal to occurrences.
Unsupported raw HTML is preserved literally with `unsupported-markdown`; XML 1.0
illegal characters become U+FFFD with `xml-character-replaced`; list levels beyond
seven are clamped with `list-level-simplified`. Image errors use `image-missing`,
`image-remote`, `image-format` and `image-limit`. The UI should display all returned
warnings, including codes beyond the original four image/inline codes in PLAN.

Package generation follows the [Hancom format overview](https://tech.hancom.com/hwpxformat/)
and element/attribute names were checked against the
[official OWPML model](https://github.com/hancom-io/hwpx-owpml-model).
The generator is newly implemented; the existing upstream worker is left untouched
for the app node to replace. There are no new dependencies.

Tests verify ZIP local headers, mandatory files, XML well-formedness, package and
style references, document structure, text escaping, image embedding and warnings.
Parser round trips are owned by the app node. **These checks do not validate opening
or rendering in Hancom Office; that remains a manual acceptance item.**

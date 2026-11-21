The `captions-fields.section.xml` file is authored synthetic content for the A23
regression. `scripts/hwp-e2e-fixture.mjs` inserts it into the existing synthetic
HWPX package in memory and writes only a new e2e scratch document. The original
`synthetic.hwp` and `synthetic.hwpx` remain the parser builders' fixed fixtures.

`captions-fields.expected.json` records required saved-body occurrence counts,
conversion warning codes and excluded field metadata. The `.app` e2e checks these
in addition to image files, source SHA-256 and the exported ZIP structure. This
detects lost table/picture captions, duplicated text, missing reduction markers
and unreported field reduction after the real import and first-save pipeline.
No Downloads document or extracted private content is used here.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { documentProblems, importContentProblems, stateProblems } from './e2e-state.mjs';
import { buildCaptionFixture } from './hwp-e2e-fixture.mjs';

const expected = { path: '/문서/sample-ko.md', hash: 'current-content-hash', query: '자동 새로고침' };
const rendered = () => ({
  path: expected.path, hash: expected.hash, loadCount: 1,
  render: { headings: 5, tables: 1, codeBlocks: 1, taskItems: 2, images: 1, imagesLoaded: 1 },
  tocItems: 5, search: { query: expected.query, matches: 4 }, error: null,
  originalView: { available: false },
});

test('accepts a rendered document and a reload only after both count and content change', () => {
  assert.deepEqual(stateProblems(rendered(), expected), []);
  const baseline = rendered();
  const reloaded = { ...rendered(), hash: 'changed-content-hash', loadCount: 2 };
  assert.deepEqual(stateProblems(reloaded, { ...expected, hash: reloaded.hash }, baseline), []);
  assert.match(stateProblems(baseline, expected, baseline).join(';'), /loadCount did not increase/);
  assert.match(stateProblems({ ...baseline, loadCount: 2 }, expected, baseline).join(';'), /hash did not change/);
  assert.match(stateProblems({ ...reloaded, loadCount: 1 }, { ...expected, hash: reloaded.hash }, baseline).join(';'), /loadCount did not increase/);
});

test('rejects stale state from another document, wrong query, and hashes not matching disk', () => {
  for (const field of ['path', 'hash']) {
    assert.notDeepEqual(stateProblems({ ...rendered(), [field]: 'wrong' }, expected), []);
  }
  assert.notDeepEqual(stateProblems({ ...rendered(), search: { query: 'wrong', matches: 1 } }, expected), []);
});

test('rejects missing, broken, and falsely typed render/search counters', () => {
  for (const key of Object.keys(rendered().render)) {
    for (const value of [undefined, 0, -1, '1', null, 1.5]) {
      const state = rendered();
      state.render[key] = value;
      assert.notDeepEqual(stateProblems(state, expected), [], `${key}=${value}`);
    }
  }
  for (const patch of [
    { tocItems: 2 }, { search: { query: expected.query, matches: 0 } },
    { loadCount: 0 }, { error: 'image failed' }, { error: undefined },
    { render: { ...rendered().render, imagesLoaded: 2 } },
  ]) assert.notDeepEqual(stateProblems({ ...rendered(), ...patch }, expected), []);
  assert.notDeepEqual(stateProblems(null, expected), []);
});

test('rejects the A10 task-list regression while images, TOC and search are ready', () => {
  // VERIFY attempt 1: all other counters were ready, but TipTap lost the tasks.
  const missingTasks = rendered();
  missingTasks.render.taskItems = 0;
  assert.deepEqual(stateProblems(missingTasks, expected), ['render.taskItems must be >= 1']);

  const reloaded = { ...missingTasks, loadCount: 2, hash: 'changed-content-hash' };
  assert.deepEqual(
    stateProblems(reloaded, { ...expected, hash: reloaded.hash }, rendered()),
    ['render.taskItems must be >= 1'],
  );
});

test('CLI polls state for the Korean fixture and waits for a matching external reload', async () => {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const work = await mkdtemp(path.join(scripts, '.e2e-state-test-'));
  try {
    const folder = path.join(work, '한글 문서');
    await mkdir(folder);
    const document = path.join(folder, 'sample-ko.md');
    await copyFile(new URL('../fixtures/sample-ko.md', import.meta.url), document);
    const documentPath = await realpath(document);
    const diskHash = async () => createHash('sha256').update(await readFile(document)).digest('hex');
    const statePath = path.join(work, 'state.json');
    const initialPath = path.join(work, 'initial.json');
    const reloadedPath = path.join(work, 'reloaded.json');
    const initial = { ...rendered(), path: documentPath, hash: await diskHash() };
    await writeFile(statePath, JSON.stringify(initial));
    const run = (baseline, output) => promisify(execFile)(process.execPath, [
      path.join(scripts, 'e2e-state.mjs'), statePath, document, expected.query, baseline, output,
    ], { timeout: 5000 });

    await run('-', initialPath);
    assert.deepEqual(JSON.parse(await readFile(initialPath, 'utf8')), initial);

    await writeFile(document, '\n외부 수정: 자동 새로고침\n', { flag: 'a' });
    const reloaded = { ...initial, hash: await diskHash(), loadCount: 2 };
    // The previous report remains on disk until the app publishes the reload.
    const polling = run(initialPath, reloadedPath);
    const publication = new Promise((resolve) => setTimeout(resolve, 300))
      .then(() => writeFile(statePath, JSON.stringify(reloaded)));
    await Promise.all([polling, publication]);
    assert.deepEqual(JSON.parse(await readFile(reloadedPath, 'utf8')), reloaded);
    assert.notEqual(reloaded.hash, initial.hash);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

const editText = 'E2E 블록 편집: 한글 문장을 추가하고 안전하게 저장합니다.';
const edited = () => ({ ...rendered(), edit: { applied: true, dirty: true, saveStatus: 'idle', mode: 'rich' } });
const saved = () => ({ ...edited(), edit: { ...edited().edit, dirty: false, saveStatus: 'saved' } });
const conflicted = () => ({ ...edited(), error: 'conflict: disk was changed', edit: { ...edited().edit, saveStatus: 'conflict' } });

test('edit phases require actual rich editing, dirty lifecycle and no document reload', () => {
  assert.deepEqual(stateProblems(edited(), { ...expected, phase: 'edited' }), []);
  const final = { ...saved(), hash: 'saved-hash' };
  const savedExpected = { ...expected, hash: final.hash, phase: 'saved' };
  assert.deepEqual(stateProblems(final, savedExpected, edited()), []);
  assert.match(stateProblems(rendered(), savedExpected, edited()).join(';'), /edit.applied/);
  for (const patch of [
    { applied: false }, { applied: 'true' }, { dirty: true }, { dirty: 'false' },
    { saveStatus: 'saving' }, { saveStatus: 'error' }, { mode: 'source' },
  ]) {
    assert.notDeepEqual(stateProblems({ ...final, edit: { ...final.edit, ...patch } }, savedExpected, edited()), [], JSON.stringify(patch));
  }
  assert.match(stateProblems({ ...final, loadCount: 2 }, savedExpected, edited()).join(';'), /loadCount must stay 1/);
  assert.match(stateProblems(saved(), { ...expected, phase: 'saved' }, edited()).join(';'), /saved hash must differ/);
});

test('conflict retains the old hash and dirty draft while disk has a different hash', () => {
  const external = { ...expected, hash: 'external-hash', phase: 'conflict' };
  assert.deepEqual(stateProblems(conflicted(), external, edited()), []);
  // While the save gate is closed an external change must not replace the draft.
  assert.deepEqual(stateProblems(edited(), { ...external, phase: 'edited' }, edited()), []);
  for (const patch of [
    { hash: external.hash }, { error: null }, { error: 'unrelated error' },
    { edit: { ...conflicted().edit, dirty: false } },
    { edit: { ...conflicted().edit, saveStatus: 'saved' } }, { loadCount: 2 },
  ]) assert.notDeepEqual(stateProblems({ ...conflicted(), ...patch }, external, edited()), [], JSON.stringify(patch));
  assert.match(stateProblems(conflicted(), { ...expected, phase: 'conflict' }, edited()).join(';'), /externally changed/);
  assert.notDeepEqual(stateProblems(conflicted(), external), []);
});

test('disk verification allows documented normalization and rejects lost or altered fixture blocks', async () => {
  const original = await readFile(new URL('../fixtures/sample-ko.md', import.meta.url), 'utf8');
  const content = `${original}\n${editText}\n`;
  const options = { original, edit: editText };
  assert.deepEqual(documentProblems(content, options), []);
  const normalized = content.replace(/\| --- \| --- \|/g, '| :----- | -----: |')
    .replace(/^- \[/gm, '-   [').replace(/```/g, '~~~');
  assert.deepEqual(documentProblems(normalized, options), []);
  assert.deepEqual(documentProblems(normalized.replace(/\n/g, '\r\n'), { ...options, original: original.replace(/\n/g, '\r\n') }), []);
  assert.match(documentProblems(normalized.replace(/\n/g, '\r\n'), options).join(';'), /line endings/);
  assert.match(documentProblems(content.trimEnd(), options).join(';'), /trailing newline presence/);
  for (const [from, to, diagnostic] of [
    ['# 한글 마크다운 읽기 예제', '# 제목 손실', 'headings'],
    ['| 제목 | 한글과 목차 |', '| 제목 | 내용 손실 |', 'tables'],
    ['안녕하세요, MDViewer!', '코드 손실', 'code'],
    ['- [x] 한글 제목과 표, 코드 읽기', '- [ ] 한글 제목과 표, 코드 읽기', 'tasks'],
    ['./img/sample.png', 'asset://localhost/sample.png', 'images'],
    [editText, '', 'appended edit'],
  ]) assert.match(documentProblems(content.replace(from, to), options).join(';'), new RegExp(diagnostic));
  assert.match(documentProblems(`${content}${editText}\n`, options).join(';'), /exactly once/);
  assert.deepEqual(documentProblems(Buffer.from(original), { unchanged: Buffer.from(original) }), []);
  assert.match(documentProblems(content, { unchanged: original }).join(';'), /disk bytes changed/);
  assert.match(documentProblems('본문', { original: '본문' }).join(';'), /original fixture has no/);
});

async function withScenario(runTest) {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const work = await mkdtemp(path.join(scripts, '.e2e-state-test-'));
  try {
    const original = await readFile(new URL('../fixtures/sample-ko.md', import.meta.url), 'utf8');
    const document = path.join(work, '한글 편집.md');
    const originalPath = path.join(work, 'original.md');
    const statePath = path.join(work, 'state.json');
    const baselinePath = path.join(work, 'baseline.json');
    const outputPath = path.join(work, 'output.json');
    await writeFile(document, original);
    await writeFile(originalPath, original);
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const baseline = { ...edited(), path: await realpath(document), hash: hash(original) };
    await writeFile(baselinePath, JSON.stringify(baseline));
    await writeFile(statePath, JSON.stringify(baseline));
    const run = (...options) => promisify(execFile)(process.execPath, [
      path.join(scripts, 'e2e-state.mjs'), statePath, document, expected.query, baselinePath, outputPath,
      '--timeout-ms', '1800', ...options,
    ], { timeout: 4000 });
    await runTest({ document, originalPath, statePath, outputPath, original, baseline, hash, run });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const later = async (action) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return action();
};

test('CLI waits for edit/save to reach disk and observes saved state beyond the first report', async () => {
  await withScenario(async ({ document, originalPath, statePath, outputPath, original, baseline, hash, run }) => {
    await run('--phase', 'edited', '--unchanged', originalPath);
    const content = `${original}\n${editText}\n`;
    const final = { ...baseline, hash: hash(content), edit: saved().edit };
    const polling = run('--phase', 'saved', '--original', originalPath, '--edit', editText, '--stable-ms', '400');
    await Promise.all([polling, later(async () => {
      await writeFile(document, content);
      await writeFile(statePath, JSON.stringify(final));
    })]);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), final);
  });
});

test('CLI validates conflict against an external disk snapshot rather than the stale editor hash', async () => {
  await withScenario(async ({ document, originalPath, statePath, outputPath, original, baseline, run }) => {
    const external = `${original}\n외부에서 먼저 수정했습니다.\n`;
    await writeFile(document, external);
    await writeFile(originalPath, external);
    await run('--phase', 'edited', '--unchanged', originalPath, '--stable-ms', '200');
    const final = { ...baseline, error: conflicted().error, edit: conflicted().edit };
    await writeFile(statePath, JSON.stringify(final));
    await run('--phase', 'conflict', '--unchanged', originalPath, '--stable-ms', '200');
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), final);
    assert.equal(await readFile(document, 'utf8'), external);
  });
});

test('CLI rejects a delayed self-write reload after the first saved report', async () => {
  await withScenario(async ({ document, originalPath, statePath, original, baseline, hash, run }) => {
    const content = `${original}\n${editText}\n`;
    const final = { ...baseline, hash: hash(content), edit: saved().edit };
    await writeFile(document, content);
    await writeFile(statePath, JSON.stringify(final));
    const rejection = assert.rejects(run('--phase', 'saved', '--original', originalPath, '--edit', editText, '--stable-ms', '800'), /loadCount must stay 1/);
    await Promise.all([rejection, later(() => writeFile(statePath, JSON.stringify({ ...final, loadCount: 2 })))]);
  });
});

test('CLI rejects a late overwrite even if conflict status is still reported', async () => {
  await withScenario(async ({ document, originalPath, statePath, original, baseline, run }) => {
    const external = `${original}\n외부 변경 내용\n`;
    await writeFile(document, external);
    await writeFile(originalPath, external);
    await writeFile(statePath, JSON.stringify({ ...baseline, error: conflicted().error, edit: conflicted().edit }));
    const rejection = assert.rejects(run('--phase', 'conflict', '--unchanged', originalPath, '--stable-ms', '800'), /disk bytes changed/);
    await Promise.all([rejection, later(() => writeFile(document, `${original}\n${editText}\n`))]);
  });
});

test('CLI times out instead of accepting an unfinished save and rejects misspelled phases', async () => {
  await withScenario(async ({ originalPath, run }) => {
    await assert.rejects(run('--phase', 'saved', '--original', originalPath, '--edit', editText, '--timeout-ms', '300'), /saveStatus must be saved/);
    await assert.rejects(run('--phase', 'save'), /Unknown e2e phase/);
    await assert.rejects(run('--phase', 'saved'), /requires --edit and --original/);
    await assert.rejects(run('--phase', 'conflict'), /requires --unchanged/);
  });
});

const importReport = { done: true, kind: 'hwp', untitled: true, dirty: true,
  markdownLength: 70, warningCodes: ['shape-skipped'], assetCount: 1 };
const importedState = () => ({ path: '', hash: '', loadCount: 1, error: null, importResult: { ...importReport },
  edit: { dirty: true, saveStatus: 'idle', mode: 'source', applied: false } });

test('A23 expectations reject caption loss, duplicate text, missing markers and absent field warnings', async () => {
  const spec = JSON.parse(await readFile(new URL('../fixtures/hwp/captions-fields.expected.json', import.meta.url)));
  const body = Object.entries(spec.bodyCounts).flatMap(([text, count]) => Array(count).fill(text)).join('\n\n');
  assert.deepEqual(importContentProblems(body, spec), []);
  for (const fragment of Object.keys(spec.bodyCounts)) {
    assert.notDeepEqual(importContentProblems(body.replace(fragment, ''), spec), [], fragment);
    assert.notDeepEqual(importContentProblems(body + '\n' + fragment, spec), [], fragment);
  }
  assert.notDeepEqual(importContentProblems(body + spec.excludedText[0], spec), []);
  const expectedImport = { phase: 'imported', kind: 'hwp', importExpectations: spec };
  assert.match(stateProblems(importedState(), expectedImport).join(';'), /missing import warning: object-skipped/);
  assert.deepEqual(stateProblems({ ...importedState(), importResult: { ...importReport, warningCodes: spec.warningCodes } }, expectedImport), []);
});

test('caption fixture assembly is deterministic and preserves the original synthetic package and image', async () => {
  const JSZip = (await import('jszip')).default;
  const templatePath = new URL('../fixtures/hwp/synthetic.hwpx', import.meta.url);
  const original = await readFile(templatePath);
  const bytes = await buildCaptionFixture();
  assert.deepEqual(bytes, await buildCaptionFixture());
  assert.deepEqual(await readFile(templatePath), original);
  const before = await JSZip.loadAsync(original);
  const after = await JSZip.loadAsync(bytes, { checkCRC32: true });
  assert.equal(await after.file('Contents/section0.xml').async('string'), await readFile(new URL('../fixtures/hwp/captions-fields.section.xml', import.meta.url), 'utf8'));
  for (const entry of Object.values(before.files)) {
    if (!entry.dir && entry.name !== 'Contents/section0.xml') {
      assert.deepEqual(await after.file(entry.name).async('uint8array'), await entry.async('uint8array'), entry.name);
    }
  }
});

test('import phases require a real unnamed dirty result and preserve its metadata after saving', () => {
  const expectedImport = { phase: 'imported', kind: 'hwp' };
  assert.deepEqual(stateProblems(importedState(), expectedImport), []);
  for (const patch of [
    { importResult: null }, { importResult: { ...importReport, done: false } },
    { importResult: { ...importReport, kind: 'hwpx' } }, { importResult: { ...importReport, untitled: false } },
    { importResult: { ...importReport, dirty: false } }, { importResult: { ...importReport, assetCount: 0 } },
    { importResult: { ...importReport, assetCount: '1' } }, { importResult: { ...importReport, warningCodes: null } },
    { importResult: { ...importReport, markdownLength: 0 } }, { path: '/tmp/source.hwp' }, { hash: 'source-hash' },
    { edit: { dirty: false, saveStatus: 'saved' } }, { error: 'worker failed' },
  ]) assert.notDeepEqual(stateProblems({ ...importedState(), ...patch }, expectedImport), []);
  const final = { ...importedState(), path: '/tmp/saved.md', hash: 'disk', edit: { dirty: false, saveStatus: 'saved' } };
  const expectedSave = { phase: 'import-saved', kind: 'hwp', path: final.path, hash: final.hash };
  assert.deepEqual(stateProblems(final, expectedSave, importedState()), []);
  assert.notDeepEqual(stateProblems({ ...final, loadCount: 2 }, expectedSave, importedState()), []);
  assert.notDeepEqual(stateProblems({ ...final, hash: 'stale' }, expectedSave, importedState()), []);
  const expectedExport = { ...expectedSave, phase: 'exported', exportPath: '/tmp/export.hwpx' };
  assert.notDeepEqual(stateProblems(final, expectedExport, importedState()), []);
  assert.deepEqual(stateProblems({ ...final, exportResult: { done: true, path: expectedExport.exportPath } }, expectedExport, importedState()), []);
});

async function syntheticExport({ mimetype = 'application/hwp+zip', first = 'mimetype', compression = 'STORE', missing, images = 1 } = {}) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  if (first !== 'mimetype') zip.file(first, 'wrong first');
  zip.file('mimetype', mimetype, { compression });
  for (const name of ['version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/content.hpf', 'Contents/header.xml', 'Contents/section0.xml']) {
    if (name !== missing) zip.file(name, '<synthetic/>');
  }
  for (let i = 0; i < images; i++) zip.file(`BinData/img-${i}.png`, Uint8Array.of(137, 80, 0, 255));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

test('export checker rejects malformed ZIPs, wrong first/mimetype/compression, missing XML and image loss', async () => {
  const { exportPackageProblems } = await import('./e2e-state.mjs');
  assert.deepEqual(await exportPackageProblems(await syntheticExport(), 1), []);
  for (const options of [
    { first: 'wrong' }, { compression: 'DEFLATE' }, { mimetype: 'application/zip' },
    { missing: 'Contents/header.xml' }, { missing: 'META-INF/manifest.xml' }, { images: 0 }, { images: 2 },
  ]) assert.notDeepEqual(await exportPackageProblems(await syntheticExport(options), 1), [], JSON.stringify(options));
  assert.notDeepEqual(await exportPackageProblems(Buffer.from('not a zip'), 1), []);
  const corrupt = await syntheticExport();
  // Damage stored payload; CRC32 must catch it even when the directory survives.
  corrupt[38] ^= 1;
  assert.notDeepEqual(await exportPackageProblems(corrupt, 1), []);
});

test('asset checker resolves encoded Korean image links and rejects missing, extra and escaping targets', async () => {
  const { importAssetsProblems } = await import('./e2e-state.mjs');
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const work = await mkdtemp(path.join(scripts, '.e2e-state-test-'));
  try {
    const document = path.join(work, '한글 문서.md');
    const folder = path.join(work, '한글 문서.assets');
    await mkdir(folder);
    const image = path.join(folder, 'img-001.png');
    await writeFile(image, Uint8Array.of(137, 80, 0, 255));
    const content = `![그림](${encodeURIComponent('한글 문서.assets')}/img-001.png)`;
    assert.deepEqual(await importAssetsProblems(document, content, 1), []);
    for (const text of [content.replace('img-001', 'missing'), content.replace(encodeURIComponent('한글 문서.assets'), '..'),
      content.replace(encodeURIComponent('한글 문서.assets'), 'mdviewer-import-assets'), '본문만 남음']) {
      assert.notDeepEqual(await importAssetsProblems(document, text, 1), []);
    }
    await writeFile(path.join(folder, 'extra.png'), 'extra');
    assert.notDeepEqual(await importAssetsProblems(document, content, 1), []);
    await rm(path.join(folder, 'extra.png'));
    await writeFile(image, '');
    assert.notDeepEqual(await importAssetsProblems(document, content, 1), []);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('CLI observes unnamed import before a first save, then waits for assets and a validated export on disk', async () => {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const work = await mkdtemp(path.join(scripts, '.e2e-state-test-'));
  try {
    const statePath = path.join(work, 'state.json');
    const baselinePath = path.join(work, 'imported.json');
    const outputPath = path.join(work, 'exported.json');
    const source = path.join(work, 'synthetic.hwp');
    const document = path.join(work, '한글 문서.md');
    const exported = path.join(work, '결과.hwpx');
    const expectations = path.join(work, 'expectations.json');
    await writeFile(expectations, JSON.stringify({ warningCodes: ['shape-skipped'], bodyCounts: { '# 제목': 1 }, excludedText: ['비공개 필드 메타데이터'] }));
    await writeFile(source, 'synthetic source');
    await writeFile(statePath, JSON.stringify(importedState()));
    const run = (file, baseline, output, ...options) => promisify(execFile)(process.execPath, [
      path.join(scripts, 'e2e-state.mjs'), statePath, file, 'query', baseline, output,
      '--kind', 'hwp', '--timeout-ms', '2500', '--import-expectations', expectations, ...options,
    ], { timeout: 5000 });
    await run(source, '-', baselinePath, '--phase', 'imported');
    const polling = run(document, baselinePath, outputPath, '--phase', 'exported', '--export', exported, '--stable-ms', '200');
    const content = `# 제목\n\n![그림](${encodeURIComponent('한글 문서.assets')}/img-001.png)\n`;
    await Promise.all([polling, later(async () => {
      const folder = path.join(work, '한글 문서.assets');
      await mkdir(folder); await writeFile(path.join(folder, 'img-001.png'), Uint8Array.of(137, 80, 0, 255));
      await writeFile(document, content); await writeFile(exported, await syntheticExport());
      await writeFile(statePath, JSON.stringify({ ...importedState(), path: await realpath(document),
        hash: createHash('sha256').update(content).digest('hex'), edit: { dirty: false, saveStatus: 'saved' },
        exportResult: { done: true, path: exported } }));
    })]);
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).exportResult.path, exported);
    assert.equal(await readFile(source, 'utf8'), 'synthetic source');
    // Simulate silent loss with a matching disk hash: counters/hash alone pass.
    const missingText = content.replace('# 제목', '# 사라짐');
    await writeFile(document, missingText);
    const final = JSON.parse(await readFile(statePath, 'utf8'));
    await writeFile(statePath, JSON.stringify({ ...final, hash: createHash('sha256').update(missingText).digest('hex') }));
    await assert.rejects(run(document, baselinePath, outputPath, '--phase', 'import-saved', '--timeout-ms', '250'), /imported body must contain/);
    await writeFile(expectations, JSON.stringify({ warningCodes: [], bodyCounts: {}, excludedText: [] }));
    await assert.rejects(run(document, baselinePath, outputPath, '--phase', 'import-saved'), /Invalid import expectations/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

const originalState = () => ({ ...importedState(), originalView: {
  available: true, mode: 'original', pages: 2, imgBlobCount: 1, svgInDom: 0,
  errorMessage: null, parseMs: 120, firstPageMs: 160, maxFrameGapMs: 40,
} });

test('original-sample requires two pages, one visible blob image and no inline SVG or error', () => {
  const expectation = { phase: 'original-sample' };
  assert.deepEqual(stateProblems(originalState(), expectation), []);
  for (const [key, values] of Object.entries({
    available: [false, null, 'true'], mode: ['markdown', null], pages: [0, 1, 3, '2', null],
    imgBlobCount: [0, 2, '1', null], svgInDom: [1, '0', null], errorMessage: ['render failed', '', undefined],
  })) {
    for (const value of values) {
      const state = originalState();
      state.originalView[key] = value;
      assert.match(stateProblems(state, expectation).join(';'), new RegExp(`originalView\\.${key}`));
    }
  }
  assert.notDeepEqual(stateProblems({ ...originalState(), originalView: null }, expectation), []);
});

test('original timing fields reject null, unfinished, nonnumeric and nonfinite measurements', () => {
  for (const phase of ['original-sample', 'original-big']) {
    for (const key of ['parseMs', 'firstPageMs', 'maxFrameGapMs']) {
      for (const value of [null, undefined, '0', -1, NaN, Infinity]) {
        const state = originalState();
        state.originalView[key] = value;
        assert.match(stateProblems(state, { phase }).join(';'), new RegExp(`originalView\\.${key}`));
      }
    }
  }
});

test('original-big accepts all pages with one image and flags only exceeded timing budgets', () => {
  const expectation = { phase: 'original-big' };
  const state = originalState();
  Object.assign(state.originalView, { pages: 37, parseMs: 7900, firstPageMs: 8000, maxFrameGapMs: 1500 });
  assert.deepEqual(stateProblems(state, expectation), []);
  for (const [key, value] of [['firstPageMs', 8001], ['maxFrameGapMs', 1501]]) {
    const over = { ...state, originalView: { ...state.originalView, [key]: value } };
    assert.match(stateProblems(over, expectation).join(';'), /예산 초과/);
    assert.match(stateProblems(over, expectation).join(';'), new RegExp(`originalView\\.${key}`));
    assert.deepEqual(stateProblems({ ...over, originalView: { ...over.originalView, pages: 2 } }, { phase: 'original-sample' }), []);
  }
  for (const pages of [0, -1, null, '2', 1.5]) {
    assert.match(stateProblems({ ...state, originalView: { ...state.originalView, pages } }, expectation).join(';'), /originalView.pages/);
  }
});

test('Markdown reader, reload, edit, save and conflict require originalView.available false', () => {
  const cases = [
    [rendered(), expected],
    [{ ...rendered(), loadCount: 2, hash: 'reloaded' }, { ...expected, hash: 'reloaded' }, rendered()],
    [edited(), { ...expected, phase: 'edited' }],
    [{ ...saved(), hash: 'saved' }, { ...expected, phase: 'saved', hash: 'saved' }, edited()],
    [conflicted(), { ...expected, phase: 'conflict', hash: 'external' }, edited()],
  ];
  for (const [state, expectation, baseline] of cases) {
    assert.deepEqual(stateProblems(state, expectation, baseline), []);
    for (const available of [true, undefined, null, 'false']) {
      assert.match(stateProblems({ ...state, originalView: { available } }, expectation, baseline).join(';'), /originalView.available must be false/);
    }
    assert.match(stateProblems({ ...state, originalView: undefined }, expectation, baseline).join(';'), /originalView.available must be false/);
  }
});

async function withOriginalScenario(runTest) {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const work = await mkdtemp(path.join(scripts, '.e2e-state-test-'));
  try {
    const source = path.join(work, 'synthetic.hwp');
    const statePath = path.join(work, 'state.json');
    const outputPath = path.join(work, 'output.json');
    const privateText = 'PRIVATE-SAMPLE-CONTENT-MUST-NOT-BE-LOGGED';
    await writeFile(source, privateText);
    const publish = (state) => writeFile(statePath, JSON.stringify({ ...state, privateText }));
    const run = (phase, ...options) => promisify(execFile)(process.execPath, [
      path.join(scripts, 'e2e-state.mjs'), statePath, source, '@original-view', '-', outputPath,
      '--phase', phase, '--timeout-ms', '1200', ...options,
    ], { timeout: 3000 });
    await publish(originalState());
    await runTest({ source, outputPath, privateText, publish, run });
    assert.equal(await readFile(source, 'utf8'), privateText);
  } finally { await rm(work, { recursive: true, force: true }); }
}

test('original CLI waits for measured completion and emits only statistics', async () => {
  await withOriginalScenario(async ({ outputPath, privateText, publish, run }) => {
    const unfinished = originalState();
    unfinished.originalView.maxFrameGapMs = null;
    await publish(unfinished);
    const [result] = await Promise.all([
      run('original-sample'), later(() => publish(originalState())),
    ]);
    assert.match(result.stdout, /"parseMs":\s*120/);
    assert.match(result.stdout, /"firstPageMs":\s*160/);
    assert.match(result.stdout, /"maxFrameGapMs":\s*40/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(privateText));
    const output = await readFile(outputPath, 'utf8');
    assert.doesNotMatch(output, /privateText|importResult|synthetic.hwp/);
    assert.equal(JSON.parse(output).originalView.imgBlobCount, 1);
  });
});

test('original CLI exits 3 for budget excess and always prints measured values', async () => {
  await withOriginalScenario(async ({ publish, run }) => {
    for (const [key, value] of [['firstPageMs', 8001], ['maxFrameGapMs', 1501]]) {
      const state = originalState();
      Object.assign(state.originalView, { pages: 37, [key]: value });
      await publish(state);
      await assert.rejects(run('original-big'), (error) => {
        assert.equal(error.code, 3);
        assert.match(error.stderr, /예산 초과/);
        assert.match(error.stdout, new RegExp(`"${key}":\\s*${value}`));
        assert.match(error.stdout, /"parseMs":\s*120/);
        return true;
      });
    }
    const state = originalState();
    Object.assign(state.originalView, { pages: 37, firstPageMs: 8000, maxFrameGapMs: 1500 });
    await publish(state);
    await run('original-big');
  });
});

test('original CLI rejects incomplete timings and suppresses private error and report text', async () => {
  await withOriginalScenario(async ({ privateText, publish, run }) => {
    for (const patch of [{ parseMs: null }, { firstPageMs: null }, { maxFrameGapMs: null }, { errorMessage: privateText }]) {
      await publish({ ...originalState(), originalView: { ...originalState().originalView, ...patch } });
      await assert.rejects(run('original-sample', '--timeout-ms', '250'), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /originalView/);
        assert.match(error.stdout, /"firstPageMs":/);
        assert.doesNotMatch(error.stdout + error.stderr, new RegExp(privateText));
        return true;
      });
    }
  });
});

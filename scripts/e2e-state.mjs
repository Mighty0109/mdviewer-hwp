import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { pathToFileURL } from 'node:url';

// Every phase keeps the original reader assertions, including after a save conflict.
export function stateProblems(state, expected, baseline) {
  if (['original-sample', 'original-big'].includes(expected.phase)) return originalStateProblems(state, expected.phase);
  if (['imported', 'import-saved', 'exported'].includes(expected.phase)) return importStateProblems(state, expected, baseline);
  const problems = [];
  if (!state || typeof state !== 'object') return ['state must be an object'];
  if (state.originalView?.available !== false) problems.push('originalView.available must be false for Markdown documents');
  const phase = expected.phase ?? 'reader';
  const hash = phase === 'conflict' || (phase === 'edited' && baseline) ? baseline?.hash : expected.hash;
  if (state.path !== expected.path) problems.push('document path does not match');
  if (typeof state.hash !== 'string' || !state.hash || state.hash !== hash) {
    problems.push(phase === 'conflict' || (phase === 'edited' && baseline) ? 'unsaved edits must retain the opened document hash' : 'hash does not match the current document bytes');
  }
  if (!Number.isSafeInteger(state.loadCount) || state.loadCount < 1) problems.push('loadCount must be >= 1');
  if (phase === 'conflict') {
    if (typeof state.error !== 'string' || !state.error.startsWith('conflict:')) problems.push('conflict error must start with conflict:');
    if (!baseline?.hash || expected.hash === baseline.hash) problems.push('conflict requires externally changed disk bytes');
  } else if (state.error !== null && state.error !== '') problems.push(`error: ${JSON.stringify(state.error)}`);
  for (const key of ['headings', 'tables', 'codeBlocks', 'taskItems', 'images', 'imagesLoaded']) {
    if (!Number.isSafeInteger(state.render?.[key]) || state.render[key] < 1) problems.push(`render.${key} must be >= 1`);
  }
  if (state.render?.imagesLoaded > state.render?.images) problems.push('imagesLoaded exceeds images');
  if (!Number.isSafeInteger(state.tocItems) || state.tocItems < 3) problems.push('tocItems must be >= 3');
  if (state.search?.query !== expected.query) problems.push('search.query does not match');
  if (!Number.isSafeInteger(state.search?.matches) || state.search.matches < 1) problems.push('search.matches must be >= 1');
  if (phase === 'reader' && baseline) {
    if (state.loadCount <= baseline.loadCount) problems.push('loadCount did not increase after external edit');
    if (state.hash === baseline.hash) problems.push('hash did not change after external edit');
  }
  if (phase !== 'reader') {
    if (state.edit?.applied !== true) problems.push('edit.applied must be true');
    if (state.edit?.mode !== 'rich') problems.push('edit.mode must be rich for the block editing scenario');
    if (state.edit?.dirty !== (phase !== 'saved')) problems.push(`edit.dirty must be ${phase !== 'saved'}`);
    const status = { edited: 'idle', saved: 'saved', conflict: 'conflict' }[phase];
    if (!status || state.edit?.saveStatus !== status) problems.push(`edit.saveStatus must be ${status ?? 'a known phase'}`);
    if (state.loadCount !== 1) problems.push('loadCount must stay 1 after editing and saving (no self-write reload)');
    if (baseline && baseline.loadCount !== state.loadCount) problems.push('editing must not reload the document');
    if (phase === 'saved' && (!baseline?.hash || state.hash === baseline.hash)) problems.push('saved hash must differ from the pre-save hash');
  }
  return problems;
}

function originalStateProblems(state, phase) {
  if (!state || typeof state !== 'object') return ['state must be an object'];
  const problems = [];
  const view = state.originalView;
  // Private sample diagnostics describe fields, never echo app error/document text.
  if (state.error !== null && state.error !== '') problems.push('original import reported an error');
  if (view?.available !== true) problems.push('originalView.available must be true');
  if (view?.mode !== 'original') problems.push('originalView.mode must be original');
  if (phase === 'original-sample') {
    if (view?.pages !== 2) problems.push('originalView.pages must be 2 for the original-sample HWP');
  } else if (!Number.isSafeInteger(view?.pages) || view.pages < 1) problems.push('originalView.pages must be a positive integer');
  if (view?.imgBlobCount !== 1) problems.push('originalView.imgBlobCount must be 1 (current page only)');
  if (view?.svgInDom !== 0) problems.push('originalView.svgInDom must be 0');
  if (view?.errorMessage !== null) problems.push('originalView.errorMessage must be null');
  for (const key of ['parseMs', 'firstPageMs', 'maxFrameGapMs']) {
    if (!Number.isFinite(view?.[key]) || view[key] < 0) problems.push(`originalView.${key} must be a finite nonnegative number (measurement incomplete)`);
  }
  if (phase === 'original-big') {
    for (const [key, limit] of [['firstPageMs', 8000], ['maxFrameGapMs', 1500]]) {
      if (Number.isFinite(view?.[key]) && view[key] > limit) problems.push(`예산 초과: originalView.${key}=${view[key]}ms > ${limit}ms — 사용자 판단 필요`);
    }
  }
  return problems;
}

// Import fixtures deliberately include unsupported constructs, so rich-reader
// counters from sample-ko.md must not mask a valid source-only import.
export function importStateProblems(state, expected, baseline) {
  if (!state || typeof state !== 'object') return ['state must be an object'];
  const problems = [];
  const report = state.importResult;
  if (state.error !== null && state.error !== '') problems.push(`error: ${JSON.stringify(state.error)}`);
  if (report?.done !== true || report?.kind !== expected.kind || report?.untitled !== true || report?.dirty !== true) problems.push('importResult must record a completed dirty untitled import of the requested kind');
  if (!Number.isSafeInteger(report?.markdownLength) || report.markdownLength < 1) problems.push('importResult.markdownLength must be positive');
  if (!Number.isSafeInteger(report?.assetCount) || report.assetCount < 1) problems.push('importResult.assetCount must be positive for the image fixture');
  if (!Array.isArray(report?.warningCodes) || report.warningCodes.some(code => typeof code !== 'string' || !code)) problems.push('importResult.warningCodes must be a string list');
  for (const code of expected.importExpectations?.warningCodes ?? []) {
    if (!Array.isArray(report?.warningCodes) || !report.warningCodes.includes(code)) problems.push(`missing import warning: ${code}`);
  }
  if (!Number.isSafeInteger(state.loadCount) || state.loadCount < 1) problems.push('loadCount must be positive');
  if (baseline && (state.loadCount !== baseline.loadCount || JSON.stringify(report) !== JSON.stringify(baseline.importResult))) problems.push('import metadata/loadCount changed during save');
  if (expected.phase === 'imported') {
    if (state.path !== '' || state.hash !== '') problems.push('import must remain unnamed with no disk hash');
    if (state.edit?.dirty !== true || state.edit?.saveStatus !== 'idle') problems.push('import must remain dirty before first save');
  } else {
    if (state.path !== expected.path || state.hash !== expected.hash) problems.push('saved import path/hash must match disk');
    if (state.edit?.dirty !== false || state.edit?.saveStatus !== 'saved') problems.push('saved import must be clean and saved');
  }
  if (expected.phase === 'exported' && (state.exportResult?.done !== true || state.exportResult?.path !== expected.exportPath)) problems.push('exportResult must confirm the selected HWPX path');
  return problems;
}

// Known synthetic text and reduction markers must survive the real first save.
// Length/image counters alone cannot detect a silently dropped caption or field.
export function importContentProblems(content, expectations) {
  const text = content.toString();
  const problems = [];
  for (const [fragment, count] of Object.entries(expectations.bodyCounts)) {
    if (text.split(fragment).length - 1 !== count) problems.push(`imported body must contain ${JSON.stringify(fragment)} exactly ${count} time(s)`);
  }
  for (const fragment of expectations.excludedText) {
    if (text.includes(fragment)) problems.push(`excluded import metadata remains in body: ${JSON.stringify(fragment)}`);
  }
  return problems;
}

export async function importAssetsProblems(documentPath, content, assetCount) {
  const problems = [];
  const text = content.toString();
  if (text.includes('mdviewer-import-assets/')) problems.push('unresolved in-memory asset prefix remains on disk');
  const parent = await realpath(path.dirname(documentPath));
  const stem = path.basename(documentPath, path.extname(documentPath));
  const folders = (await readdir(parent, { withFileTypes: true })).filter(entry =>
    entry.name === `${stem}.assets` || (entry.name.startsWith(`${stem}.assets-`) && /^[2-9]\d*$|^1\d+$/.test(entry.name.slice(`${stem}.assets-`.length))));
  if (folders.length !== 1 || !folders[0].isDirectory()) return [...problems, 'exactly one real asset directory is required'];
  const folder = path.join(parent, folders[0].name);
  const files = await readdir(folder, { withFileTypes: true });
  if (files.length !== assetCount || files.some(file => !file.isFile())) problems.push('asset directory file count/type does not match importResult.assetCount');
  const referenced = new Set();
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    let target;
    try { target = decodeURIComponent(match[1].replace(/^<|>$/g, '')); } catch { problems.push('invalid image URL encoding'); continue; }
    const resolved = path.resolve(parent, target);
    if (path.dirname(resolved) !== folder) { problems.push('image reference is outside the saved asset folder'); continue; }
    try {
      if (await realpath(resolved) !== resolved || !(await readFile(resolved)).length) problems.push('image target is empty or redirected');
      referenced.add(path.basename(resolved));
    } catch { problems.push('image target is missing'); }
  }
  if (referenced.size !== assetCount) problems.push('Markdown image targets do not match the saved asset count');
  return problems;
}

export async function exportPackageProblems(bytes, assetCount) {
  const problems = [];
  const buffer = Buffer.from(bytes);
  if (buffer.length < 38 || buffer.readUInt32LE(0) !== 0x04034b50 || buffer.readUInt16LE(8) !== 0
    || buffer.readUInt16LE(26) !== 8 || buffer.readUInt16LE(28) !== 0 || buffer.subarray(30, 38).toString() !== 'mimetype') {
    problems.push('HWPX first entry must be stored mimetype without extra data');
  }
  try {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    if (await zip.file('mimetype')?.async('string') !== 'application/hwp+zip') problems.push('invalid HWPX mimetype');
    for (const name of ['version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/content.hpf', 'Contents/header.xml', 'Contents/section0.xml']) {
      if (!zip.file(name)) problems.push(`missing HWPX entry: ${name}`);
    }
    if (Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith('BinData/')).length !== assetCount) problems.push('exported image count differs from the import');
  } catch { problems.push('export is not a valid CRC-checked ZIP'); }
  return problems;
}

// A fixture-scoped structural comparison, not a second Markdown serializer. Ignore
// only the PLAN's allowed table/list/fence whitespace and marker normalization.
function fixtureBlocks(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const code = [];
  const body = text.replace(/^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1\2[\t ]*$/gm,
    (_, indent, fence, language, content) => { code.push([language.trim(), content]); return ''; });
  return {
    headings: [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[0]),
    tables: body.split('\n').filter((line) => /^\s*\|.*\|\s*$/.test(line))
      .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()))
      .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell))),
    code,
    tasks: [...body.matchAll(/^\s*[-+*]\s+\[([ xX])\]\s+(.+)$/gm)].map((match) => [match[1].toLowerCase(), match[2]]),
    images: [...body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((match) => [match[1], match[2]]),
  };
}

export function documentProblems(content, { original, edit, unchanged } = {}) {
  const problems = [];
  if (unchanged !== undefined && !Buffer.from(content).equals(Buffer.from(unchanged))) problems.push('disk bytes changed despite the save gate or conflict');
  if (original !== undefined) {
    const originalText = original.toString();
    const savedText = content.toString();
    const eol = originalText.match(/\r\n|\n|\r/)?.[0] ?? '\n';
    if ([...savedText.matchAll(/\r\n|\n|\r/g)].some((match) => match[0] !== eol)) problems.push('saved document did not preserve line endings');
    if (/(?:\r\n|\n|\r)$/.test(originalText) !== /(?:\r\n|\n|\r)$/.test(savedText)) problems.push('saved document did not preserve trailing newline presence');
    const before = fixtureBlocks(originalText);
    const after = fixtureBlocks(savedText);
    for (const key of Object.keys(before)) {
      if (!before[key].length) problems.push(`original fixture has no ${key} to verify`);
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) problems.push(`saved document did not preserve ${key}`);
    }
  }
  if (edit !== undefined) {
    const count = content.toString().split(/\r?\n/).filter((line) => line === edit).length;
    if (count !== 1) problems.push('saved document must contain the appended edit exactly once');
  }
  return problems;
}

function optionsFrom(args) {
  const options = { phase: 'reader', stableMs: 0, timeoutMs: 30_000 };
  const keys = { '--phase': 'phase', '--edit': 'edit', '--original': 'originalPath', '--unchanged': 'unchangedPath', '--stable-ms': 'stableMs', '--timeout-ms': 'timeoutMs', '--kind': 'kind', '--export': 'exportPath', '--import-expectations': 'importExpectationsPath' };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!key || args[i + 1] === undefined) throw new Error(`Invalid option: ${args[i]}`);
    options[key] = ['stableMs', 'timeoutMs'].includes(key) ? Number(args[i + 1]) : args[i + 1];
  }
  if (!['reader', 'edited', 'saved', 'conflict', 'imported', 'import-saved', 'exported', 'original-sample', 'original-big'].includes(options.phase)) throw new Error('Unknown e2e phase');
  if (!Number.isSafeInteger(options.stableMs) || options.stableMs < 0 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= options.stableMs) throw new Error('Invalid polling timeout or stability duration');
  if (options.phase === 'saved' && (!options.edit || !options.originalPath)) throw new Error('saved phase requires --edit and --original');
  if (['edited', 'conflict'].includes(options.phase) && !options.unchangedPath) throw new Error(`${options.phase} phase requires --unchanged`);
  if (['imported', 'import-saved', 'exported'].includes(options.phase) && !['hwp', 'hwpx'].includes(options.kind)) throw new Error('import phase requires --kind hwp|hwpx');
  if (options.phase === 'exported' && !options.exportPath) throw new Error('exported phase requires --export');
  if (options.importExpectationsPath && !['imported', 'import-saved', 'exported'].includes(options.phase)) throw new Error('--import-expectations requires an import phase');
  return options;
}

// Original scenarios never serialize the whole report or read/copy sample bytes.
// The shell checks source SHA-256 before launch and again after stopping the app.
async function checkOriginalState(statePath, outputPath, options) {
  const deadline = performance.now() + options.timeoutMs;
  let state, readyAt;
  let problems = ['originalView report is not available'];
  try {
    do {
      try {
        state = JSON.parse(await readFile(statePath, 'utf8'));
        problems = stateProblems(state, options);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new Error('originalView report could not be read');
        problems = ['originalView report is missing or incomplete'];
      }
      const budget = problems.filter(problem => problem.startsWith('예산 초과:'));
      if (budget.length && budget.length === problems.length) {
        const error = new Error(budget.join('; '));
        error.exitCode = 3;
        throw error;
      }
      if (!problems.length) {
        readyAt ??= performance.now();
        if (performance.now() - readyAt >= options.stableMs) return;
      } else if (readyAt !== undefined) {
        throw new Error(`원본 보기 안정성 확인 실패: ${problems.join('; ')}`);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (performance.now() < deadline);
    throw new Error(`원본 보기 확인 시간 초과 (${options.timeoutMs}ms): ${problems.join('; ') || 'stability window incomplete'}`);
  } finally {
    const view = state?.originalView;
    const stats = {
      available: typeof view?.available === 'boolean' ? view.available : null,
      mode: ['original', 'markdown'].includes(view?.mode) ? view.mode : null,
      hasError: view?.errorMessage != null || !!state?.error,
    };
    for (const key of ['pages', 'imgBlobCount', 'svgInDom', 'parseMs', 'firstPageMs', 'maxFrameGapMs']) {
      stats[key] = Number.isFinite(view?.[key]) ? view[key] : null;
    }
    const summary = JSON.stringify({ scenario: options.phase, originalView: stats }, null, 2);
    console.log(summary);
    await writeFile(outputPath, `${summary}\n`);
  }
}

async function main() {
  const [statePath, documentPath, query, baselinePath, outputPath, ...args] = process.argv.slice(2);
  if (!statePath || !documentPath || !query || !baselinePath || !outputPath) {
    throw new Error('Usage: node scripts/e2e-state.mjs STATE DOCUMENT QUERY BASELINE_OR_- OUTPUT [--phase reader|edited|saved|conflict|imported|import-saved|exported|original-sample|original-big] [--edit TEXT] [--original FILE] [--unchanged FILE] [--stable-ms MS] [--timeout-ms MS]');
  }
  const options = optionsFrom(args);
  if (['original-sample', 'original-big'].includes(options.phase)) return checkOriginalState(statePath, outputPath, options);
  const expected = { path: options.phase === 'imported' ? '' : ['import-saved', 'exported'].includes(options.phase) ? path.join(await realpath(path.dirname(documentPath)), path.basename(documentPath)) : await realpath(documentPath), query, phase: options.phase, kind: options.kind, exportPath: options.exportPath };
  if (options.importExpectationsPath) {
    const spec = JSON.parse(await readFile(options.importExpectationsPath, 'utf8'));
    if (!spec || !Array.isArray(spec.warningCodes) || !spec.warningCodes.length || spec.warningCodes.some(code => typeof code !== 'string' || !code)
      || !spec.bodyCounts || typeof spec.bodyCounts !== 'object' || Array.isArray(spec.bodyCounts) || !Object.keys(spec.bodyCounts).length
      || Object.entries(spec.bodyCounts).some(([fragment, count]) => !fragment || !Number.isSafeInteger(count) || count < 1)
      || !Array.isArray(spec.excludedText) || spec.excludedText.some(fragment => typeof fragment !== 'string' || !fragment)) {
      throw new Error('Invalid import expectations: require warningCodes, positive bodyCounts and excludedText');
    }
    expected.importExpectations = spec;
  }
  const baseline = baselinePath === '-' ? null : JSON.parse(await readFile(baselinePath, 'utf8'));
  if (['saved', 'conflict'].includes(options.phase) && !baseline) throw new Error(`${options.phase} phase requires a pre-save baseline`);
  const original = options.originalPath ? await readFile(options.originalPath) : undefined;
  const unchanged = options.unchangedPath ? await readFile(options.unchangedPath) : undefined;
  const deadline = performance.now() + options.timeoutMs;
  let readyAt;
  let problems = [];
  do {
    let state;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
      // Re-read disk each poll: a save may finish after this process starts.
      const content = await readFile(documentPath);
      expected.hash = createHash('sha256').update(content).digest('hex');
      problems = stateProblems(state, expected, baseline);
      if (['import-saved', 'exported'].includes(options.phase)) {
        if (expected.importExpectations) problems.push(...importContentProblems(content, expected.importExpectations));
        problems.push(...await importAssetsProblems(documentPath, content, state.importResult?.assetCount));
        if (options.phase === 'exported') problems.push(...await exportPackageProblems(await readFile(options.exportPath), state.importResult?.assetCount));
      } else if (options.phase !== 'imported') {
        problems.push(...documentProblems(content, { original, edit: options.edit, unchanged }));
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      problems = [error.message];
    }
    if (!problems.length) {
      readyAt ??= performance.now();
      if (performance.now() - readyAt >= options.stableMs) {
        await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`);
        console.log(JSON.stringify(state, null, 2));
        return;
      }
    } else if (readyAt !== undefined) {
      throw new Error(`상태/디스크 안정성 확인 실패: ${problems.join('; ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (performance.now() < deadline);
  if (problems.includes('render.taskItems must be >= 1')) {
    console.error('체크리스트가 렌더되지 않았습니다. Markdown → TipTap taskList/taskItem 변환과 앱을 최신 코드로 빌드했는지 확인하세요.');
  }
  throw new Error(`상태 확인 시간 초과 (${options.timeoutMs}ms): ${problems.join('; ') || 'stability window incomplete'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = error.exitCode === 3 ? 3 : 1; });
}

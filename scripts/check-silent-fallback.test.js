'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkLines, checkDiff } = require('./check-silent-fallback.js');

const SCRIPT_PATH = path.resolve(__dirname, 'check-silent-fallback.js');

test('checkLines: passes clean code with valid error handling', () => {
	const lines = [
		'try {',
		'  doSomething();',
		'} catch (err) {',
		'  logger.error(err);',
		'  throw err;',
		'}',
	];
	const violations = checkLines('packages/worker/src/service.ts', lines);
	assert.equal(violations.length, 0);
});

test('checkLines: permits grandfathered paths', () => {
	const lines = ['} catch (_) {}', 'const inMemoryEntities = [];'];
	const violations = checkLines('packages/web/src/lib/entityActions.ts', lines);
	assert.equal(violations.length, 0);
});

test('checkLines: flags empty catch block', () => {
	const lines = [
		'try {',
		'  dangerousOp();',
		'} catch {}',
	];
	const violations = checkLines('packages/worker/src/processor.ts', lines);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /empty catch block silently swallows error/);
});

test('checkLines: flags empty catch with underscore or err parameter', () => {
	const lines = [
		'} catch (_) {}',
		'} catch (err) {}',
	];
	const violations = checkLines('packages/mcp-server/src/tool.ts', lines);
	assert.equal(violations.length, 2);
});

test('checkLines: permits inMemory[A-Z] identifiers in test files', () => {
	const lines = ['const inMemoryStorage = new Map();'];
	const violations = checkLines('packages/core/src/__tests__/store.test.ts', lines);
	assert.equal(violations.length, 0);
});

test('checkLines: flags inMemory[A-Z] identifier outside test files', () => {
	const lines = ['const inMemoryCache = new Map();'];
	const violations = checkLines('packages/core/src/domain/store.ts', lines);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /in-memory fallback identifier 'inMemoryCache' outside __tests__/);
});

test('checkDiff: flags added empty catch block in diff', () => {
	const diff = [
		'diff --git a/packages/core/src/action.ts b/packages/core/src/action.ts',
		'--- a/packages/core/src/action.ts',
		'+++ b/packages/core/src/action.ts',
		'@@ -10,0 +11,1 @@',
		'+} catch (e) {}',
	].join('\n');

	const violations = checkDiff(diff);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /added empty catch block/);
});

test('checkDiff: flags added inMemory[A-Z] identifier in diff outside __tests__', () => {
	const diff = [
		'diff --git a/packages/mcp-server/src/tools/sync.ts b/packages/mcp-server/src/tools/sync.ts',
		'--- a/packages/mcp-server/src/tools/sync.ts',
		'+++ b/packages/mcp-server/src/tools/sync.ts',
		'@@ -20,0 +21,1 @@',
		'+const inMemoryBacklog = [];',
	].join('\n');

	const violations = checkDiff(diff);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /added in-memory fallback identifier 'inMemoryBacklog'/);
});

test('checkDiff: ignores prose in non-code files that describes the rule (#1356)', () => {
	const md = [
		'diff --git a/docs/guides/OPERATING_MODEL.md b/docs/guides/OPERATING_MODEL.md',
		'--- a/docs/guides/OPERATING_MODEL.md',
		'+++ b/docs/guides/OPERATING_MODEL.md',
		'@@ -1,1 +1,2 @@',
		'+| no silent fallback | an empty `catch {}` or an inMemoryStore fallback |',
	].join('\n');
	assert.deepEqual(checkDiff(md), []);

	const ts = md.replace(/docs\/guides\/OPERATING_MODEL\.md/g, 'packages/web/src/lib/x.ts');
	assert.equal(checkDiff(ts).length, 2);
});

test('CLI: clean fixture exits 0 with no error output', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-clean-'));
	try {
		const cleanFile = path.join(tmpDir, 'service.ts');
		fs.writeFileSync(cleanFile, 'try { doTask(); } catch (err) { console.error(err); }\n', 'utf8');

		const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', cleanFile], {
			encoding: 'utf8',
		});

		assert.equal(res.status, 0);
		assert.equal(res.stderr, '');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('CLI: violating fixture with empty catch exits 1 and cites ADR-101 / ADR-102', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-violating-'));
	try {
		const rogueFile = path.join(tmpDir, 'rogue.ts');
		fs.writeFileSync(rogueFile, 'try { doTask(); } catch {}\n', 'utf8');

		const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', rogueFile], {
			encoding: 'utf8',
		});

		assert.equal(res.status, 1);
		assert.match(res.stderr, /empty catch block/);
		assert.match(res.stderr, /ADR-101 \/ ADR-102 §3/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('CLI: violating fixture with in-memory identifier outside tests exits 1', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-violating-mem-'));
	try {
		const rogueFile = path.join(tmpDir, 'service.ts');
		fs.writeFileSync(rogueFile, 'const inMemoryState = {};\n', 'utf8');

		const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', rogueFile], {
			encoding: 'utf8',
		});

		assert.equal(res.status, 1);
		assert.match(res.stderr, /in-memory fallback identifier/);
		assert.match(res.stderr, /ADR-101 \/ ADR-102 §3/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

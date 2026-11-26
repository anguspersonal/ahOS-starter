'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	computeDepths,
	splitTopLevelArgs,
	collectRequireTargets,
	collectPathVars,
	stripJsonComments,
	readTurboInputs,
	resolveInputPatterns,
	isCovered,
	checkPackage,
	checkAll,
	PACKAGES,
	REPO_ROOT,
	globTest,
	globToRegExp,
	UnsupportedGlobError,
} = require('./check-turbo-inputs.js');

// --- unit-level parser tests -------------------------------------------

test('splitTopLevelArgs respects nested parens and strings', () => {
	assert.deepEqual(splitTopLevelArgs(`'a', "b, c", fn(1, 2)`), [`'a'`, `"b, c"`, `fn(1, 2)`]);
	assert.deepEqual(splitTopLevelArgs(`__dirname, '..'`), ['__dirname', `'..'`]);
});

test('collectRequireTargets only keeps relative specifiers', () => {
	const text = `
		const a = require('../../scripts/foo.js');
		const b = require('pg');
		import { x } from '../bar.js';
		import z from 'zod';
	`;
	assert.deepEqual(collectRequireTargets(text), ['../../scripts/foo.js', '../bar.js']);
});

test('collectPathVars resolves the REPO_ROOT-then-join chain and drops the intermediate', () => {
	const text = [
		"const path = require('path');",
		"const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');",
		"const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');",
	].join('\n');
	const repoRoot = path.resolve('/repo');
	const fileDir = path.join(repoRoot, 'packages', 'worker', 'scripts');
	const { escapes, resolvedVars } = collectPathVars(text, fileDir);
	assert.equal(resolvedVars.get('REPO_ROOT'), repoRoot);
	// REPO_ROOT itself is an intermediate (consumed by MIGRATIONS_DIR) and must
	// not be reported as a read target on its own.
	assert.deepEqual(
		escapes.map((e) => e.name),
		['MIGRATIONS_DIR'],
	);
	assert.equal(escapes[0].absPath, path.join(repoRoot, 'supabase', 'migrations'));
});

test('collectPathVars reports a join() it cannot resolve, rather than skipping it', () => {
	const text = [
		"const path = require('path');",
		"const SOME_DIR = path.join(computedElsewhere(), 'x');",
	].join('\n');
	const { unresolved, escapes } = collectPathVars(text, '/repo/scripts');
	assert.equal(escapes.length, 0);
	assert.equal(unresolved.length, 1);
	assert.equal(unresolved[0].name, 'SOME_DIR');
});

test('collectPathVars ignores function-local joins (not module top-level)', () => {
	const text = [
		"const path = require('path');",
		'function walk(dir) {',
		"  return path.join(dir, 'x');",
		'}',
	].join('\n');
	const { unresolved, escapes } = collectPathVars(text, '/repo/scripts');
	assert.equal(unresolved.length, 0);
	assert.equal(escapes.length, 0);
});

// --- dependency-free glob matcher (#729 round-1 review, Critical: no more
// require('minimatch')/require('picomatch') — see the matcher's own header
// in check-turbo-inputs.js for what each supported form is for) -----------

test('globTest: literal path segments match only themselves', () => {
	assert.equal(globTest('scripts/check-skill-bodies.js', 'scripts/check-skill-bodies.js'), true);
	assert.equal(globTest('scripts/check-skill-bodies.js', 'scripts/other.js'), false);
	assert.equal(globTest('scripts/check-skill-bodies.js', 'scripts/check-skill-bodies.js.bak'), false);
});

test('globTest: "*" matches within one path segment only', () => {
	assert.equal(globTest('packages/*.ts', 'packages/foo.ts'), true);
	assert.equal(globTest('packages/*.ts', 'packages/a/foo.ts'), false, '"*" must not cross a "/"');
});

test('globTest: "**" matches any depth, including zero segments', () => {
	assert.equal(globTest('.claude/skills/**', '.claude/skills'), true, 'zero segments: the dir itself');
	assert.equal(globTest('.claude/skills/**', '.claude/skills/foo.md'), true, 'one segment');
	assert.equal(globTest('.claude/skills/**', '.claude/skills/a/b/foo.md'), true, 'several segments');
	assert.equal(globTest('.claude/skills/**', '.claude/other/foo.md'), false);
	assert.equal(globTest('packages/**/*.ts', 'packages/foo.ts'), true, 'zero middle segments');
	assert.equal(globTest('packages/**/*.ts', 'packages/a/b/foo.ts'), true, 'several middle segments');
	assert.equal(globTest('packages/**/*.ts', 'packages/foo.tsx'), false);
});

test('globTest: "!" negation is a plain glob test on the un-prefixed pattern (isCovered applies the negation)', () => {
	// The leading "!" is stripped by resolveInputPatterns/isCovered before a
	// pattern ever reaches globTest: confirmed end to end via isCovered here.
	const pkgDir = path.resolve('/repo/packages/mcp-server');
	const patterns = resolveInputPatterns(pkgDir, [
		'../../packages/**/*.ts',
		'!../../packages/**/node_modules/**',
	]);
	assert.equal(isCovered(path.resolve('/repo/packages/foo.ts'), patterns), true);
	assert.equal(isCovered(path.resolve('/repo/packages/node_modules/pkg/index.ts'), patterns), false, 'excluded by the negated glob');
});

test('globTest: "../" prefixes are resolved relative to the package dir before matching', () => {
	const workerDir = path.resolve('/repo/packages/worker');
	const patterns = resolveInputPatterns(workerDir, ['../../scripts/lib/**']);
	const expectedPrefix = workerDir.split(path.sep).join('/').replace(/\/packages\/worker$/, '');
	assert.equal(patterns[0].abs, `${expectedPrefix}/scripts/lib/**`);
	assert.equal(isCovered(path.resolve('/repo/scripts/lib/range.js'), patterns), true);
	assert.equal(isCovered(path.resolve('/repo/scripts/other.js'), patterns), false);
});

test('globTest: "{a,b,c}" brace alternation, as used by the real vitest include configs', () => {
	assert.equal(globTest('src/**/*.{test,spec}.ts', 'src/foo.test.ts'), true);
	assert.equal(globTest('src/**/*.{test,spec}.ts', 'src/a/b/foo.spec.ts'), true);
	assert.equal(globTest('src/**/*.{test,spec}.ts', 'src/foo.ts'), false);
	assert.equal(globTest('**/*.{test,spec,property}.{ts,tsx}', 'foo.property.tsx'), true);
});

test('globTest: "?(x)"/"+(x)" extglob groups, as used by the real jest testMatch config', () => {
	assert.equal(globTest('**/?(*.)+(spec|test).ts', 'test.ts'), true);
	assert.equal(globTest('**/?(*.)+(spec|test).ts', 'spec.ts'), true);
	assert.equal(globTest('**/?(*.)+(spec|test).ts', 'foo.test.ts'), true);
	assert.equal(globTest('**/?(*.)+(spec|test).ts', 'foo.ts'), false);
});

test('globTest: an unsupported glob form fails loudly, never silently no-matches', () => {
	assert.throws(() => globTest('packages/[abc].ts', 'packages/a.ts'), UnsupportedGlobError);
	assert.throws(() => globToRegExp('packages/@(a|b).ts'), UnsupportedGlobError);
});

test('stripJsonComments removes // and /* */ but keeps string content intact', () => {
	const jsonc = `{
		// a comment
		"a": "http://example.com", /* block */ "b": 1
	}`;
	const parsed = JSON.parse(stripJsonComments(jsonc));
	assert.equal(parsed.a, 'http://example.com');
	assert.equal(parsed.b, 1);
});

test('isCovered matches a file against a glob, respects negation, and honours directory-prefix coverage', () => {
	const patterns = resolveInputPatterns('/repo/packages/mcp-server', [
		'../../scripts/foo.js',
		'../../packages/**/*.ts',
		'!../../packages/**/node_modules/**',
	]);
	assert.equal(isCovered(path.resolve('/repo/scripts/foo.js'), patterns), true);
	assert.equal(isCovered(path.resolve('/repo/scripts/bar.js'), patterns), false);
});

// --- fixture-based end-to-end tests --------------------------------------

function mkTmpRepo() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'check-turbo-inputs-'));
}

function write(repoRoot, rel, content) {
	const full = path.join(repoRoot, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
}

function vitestFixturePkg(name = 'fixture-pkg') {
	return {
		name: `@fixture/${name}`,
		dir: `packages/${name}`,
		taskName: 'test:unit',
		testFiles: (repoRoot) => {
			const { vitestTestFiles } = require('./check-turbo-inputs.js');
			return vitestTestFiles(
				path.join(repoRoot, `packages/${name}`),
				path.join(repoRoot, `packages/${name}/vitest.config.ts`),
			);
		},
	};
}

test('fixture: an undeclared repo-root read fails the guard, naming file/target/package', () => {
	const repoRoot = mkTmpRepo();
	try {
		write(
			repoRoot,
			'packages/fixture-pkg/vitest.config.ts',
			`export default { test: { include: ["src/**/*.test.ts"] } };`,
		);
		// No turbo.json at all — zero escapes are declared, so the module-level
		// repo-root read below is undeclared.
		write(
			repoRoot,
			'packages/fixture-pkg/src/reads-root.test.ts',
			[
				"import { readFileSync } from 'node:fs';",
				"import { join } from 'node:path';",
				"import { describe, it } from 'vitest';",
				"const target = join(__dirname, '../../../docs/undeclared.md');",
				"describe('x', () => { it('reads it', () => { readFileSync(target); }); });",
			].join('\n'),
		);
		write(repoRoot, 'docs/undeclared.md', 'hello');

		const result = checkPackage(repoRoot, vitestFixturePkg());
		assert.equal(result.violations.length, 1);
		assert.match(result.violations[0].file, /reads-root\.test\.ts$/);
		assert.match(result.violations[0].target, /docs[\\/]undeclared\.md$/);
		assert.equal(result.violations[0].pkg, '@fixture/fixture-pkg');
	} finally {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('fixture: the same repo-root read passes once declared in turbo.json', () => {
	const repoRoot = mkTmpRepo();
	try {
		write(
			repoRoot,
			'packages/fixture-pkg/vitest.config.ts',
			`export default { test: { include: ["src/**/*.test.ts"] } };`,
		);
		write(
			repoRoot,
			'packages/fixture-pkg/turbo.json',
			JSON.stringify({
				extends: ['//'],
				tasks: { 'test:unit': { inputs: ['$TURBO_DEFAULT$', '../../docs/undeclared.md'] } },
			}),
		);
		write(
			repoRoot,
			'packages/fixture-pkg/src/reads-root.test.ts',
			[
				"import { readFileSync } from 'node:fs';",
				"import { join } from 'node:path';",
				"import { describe, it } from 'vitest';",
				"const target = join(__dirname, '../../../docs/undeclared.md');",
				"describe('x', () => { it('reads it', () => { readFileSync(target); }); });",
			].join('\n'),
		);
		write(repoRoot, 'docs/undeclared.md', 'hello');

		const result = checkPackage(repoRoot, vitestFixturePkg());
		assert.deepEqual(result.violations, []);
		assert.deepEqual(result.unresolved, []);
	} finally {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('fixture: one hop follows a required helper and declares the escape it, not the test, causes', () => {
	const repoRoot = mkTmpRepo();
	try {
		write(
			repoRoot,
			'packages/fixture-pkg/vitest.config.ts',
			`export default { test: { include: ["src/**/*.test.ts"] } };`,
		);
		write(
			repoRoot,
			'packages/fixture-pkg/turbo.json',
			JSON.stringify({
				extends: ['//'],
				tasks: { 'test:unit': { inputs: ['$TURBO_DEFAULT$', '../../scripts/helper.js', '../../.claude/registry.json'] } },
			}),
		);
		write(
			repoRoot,
			'scripts/helper.js',
			[
				"const path = require('path');",
				"const REPO_ROOT = path.resolve(__dirname, '..');",
				"const REGISTRY = path.join(REPO_ROOT, '.claude', 'registry.json');",
				'module.exports = { REGISTRY };',
			].join('\n'),
		);
		write(repoRoot, '.claude/registry.json', '{}');
		write(
			repoRoot,
			'packages/fixture-pkg/src/uses-helper.test.ts',
			[
				"import { createRequire } from 'node:module';",
				"import { describe, it } from 'vitest';",
				'const require = createRequire(import.meta.url);',
				"const { REGISTRY } = require('../../../scripts/helper.js');",
				"describe('x', () => { it('uses it', () => { REGISTRY; }); });",
			].join('\n'),
		);

		const result = checkPackage(repoRoot, vitestFixturePkg());
		assert.deepEqual(result.violations, []);
	} finally {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	}
});

// --- real-tree regression: the guard itself must pass on this repo ---------

test('the real repo tree passes the guard (post-#718 state, per #729 acceptance)', () => {
	const result = checkAll(REPO_ROOT, PACKAGES);
	if (!result.ok) {
		const { formatReport } = require('./check-turbo-inputs.js');
		assert.fail(`expected the guard to pass on the real tree:\n${formatReport(result).join('\n')}`);
	}
});

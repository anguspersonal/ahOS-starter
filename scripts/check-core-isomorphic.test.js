'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	checkFileForAdapterOnlyPackages,
	checkCorePackageJson,
	checkAdapterOnlyPackages,
	checkRootTransitiveBoundary,
} = require('./check-core-isomorphic.js');

const SCRIPT_PATH = path.resolve(__dirname, 'check-core-isomorphic.js');

test('checkFileForAdapterOnlyPackages: allows @supabase/supabase-js inside adapters', () => {
	const fakeFile = '/repo/packages/core/src/adapters/supabase/client.ts';
	const content = `import { createClient } from "@supabase/supabase-js";\nexport const x = 1;`;
	const violations = checkFileForAdapterOnlyPackages(fakeFile, content, '/repo/packages/core/src');
	assert.equal(violations.length, 0);
});

test('checkFileForAdapterOnlyPackages: flags @supabase/supabase-js static import outside adapters', () => {
	const fakeFile = '/repo/packages/core/src/engine/rogue.ts';
	const content = `import { createClient } from "@supabase/supabase-js";\n`;
	const violations = checkFileForAdapterOnlyPackages(fakeFile, content, '/repo/packages/core/src');
	assert.equal(violations.length, 1);
	assert.match(violations[0].reason, /SDK "@supabase\/supabase-js" is forbidden outside adapters\//);
	assert.match(violations[0].reason, /ADR-101 §3, #1340/);
});

test('checkFileForAdapterOnlyPackages: flags dynamic import and require outside adapters', () => {
	for (const content of [
		`const sb = await import("@supabase/supabase-js");`,
		`const sb = require("@supabase/supabase-js");`,
	]) {
		const fakeFile = '/repo/packages/core/src/actions/rogue.ts';
		const violations = checkFileForAdapterOnlyPackages(fakeFile, content, '/repo/packages/core/src');
		assert.equal(violations.length, 1);
		assert.match(violations[0].reason, /SDK "@supabase\/supabase-js" is forbidden outside adapters\//);
	}
});

test('checkCorePackageJson: permits @supabase/supabase-js in dependencies (#1340)', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-clean-'));
	try {
		const pkgPath = path.join(tmpDir, 'package.json');
		fs.writeFileSync(
			pkgPath,
			JSON.stringify({
				name: '@ahkms/core',
				exports: {
					'.': './dist/index.js',
					'./actions': './dist/actions/index.js',
					'./engine': './dist/engine/index.js',
					'./adapters': './dist/adapters/index.js',
				},
				dependencies: {
					'@supabase/supabase-js': '^2.89.0',
					zod: '^4.0.0',
				},
			}),
			'utf8',
		);
		const violations = checkCorePackageJson(pkgPath);
		assert.equal(violations.length, 0);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('checkCorePackageJson: flags @ahkms/shared in dependencies', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-shared-'));
	try {
		const pkgPath = path.join(tmpDir, 'package.json');
		fs.writeFileSync(
			pkgPath,
			JSON.stringify({
				name: '@ahkms/core',
				exports: {
					'.': './dist/index.js',
					'./actions': './dist/actions/index.js',
					'./engine': './dist/engine/index.js',
					'./adapters': './dist/adapters/index.js',
				},
				dependencies: {
					'@ahkms/shared': '*',
					zod: '^4.0.0',
				},
			}),
			'utf8',
		);
		const violations = checkCorePackageJson(pkgPath);
		assert.equal(violations.length, 1);
		assert.match(violations[0].reason, /@ahkms\/shared declared in dependencies/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('CLI: scripts/check-core-isomorphic.js exits 0 on current repository tree', () => {
	const res = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
	assert.equal(res.status, 0, `Expected 0, got ${res.status}: ${res.stderr || res.stdout}`);
	assert.match(res.stdout, /OK: @ahkms\/core exports boundary verified/);
});

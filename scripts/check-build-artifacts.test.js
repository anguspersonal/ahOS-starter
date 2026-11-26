'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkArtifactsAndPlaceholders } = require('./check-build-artifacts.js');

test('flags .pnpm.builds.yaml file', () => {
	const files = ['.pnpm.builds.yaml'];
	const violations = checkArtifactsAndPlaceholders(files, '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /\.pnpm\.builds\.yaml/);
});

test('flags pnpm-workspace.yaml in ahOS npm monorepo', () => {
	const files = ['pnpm-workspace.yaml'];
	const violations = checkArtifactsAndPlaceholders(files, '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /unapproved pnpm-workspace\.yaml/);
});

test('flags temporary lockfiles and compiler scratch', () => {
	const files = ['packages/worker/1234.pnpm-lock.yaml.tmp', 'dist/tsconfig.tsbuildinfo'];
	const violations = checkArtifactsAndPlaceholders(files, '');
	assert.equal(violations.length, 2);
});

test('flags placeholder text in added lines of diff', () => {
	const files = ['packages/worker/src/config.ts'];
	const diff = [
		'diff --git a/packages/worker/src/config.ts b/packages/worker/src/config.ts',
		'--- a/packages/worker/src/config.ts',
		'+++ b/packages/worker/src/config.ts',
		'@@ -1,1 +1,2 @@',
		'+const enabled = true; // set this to true or false',
	].join('\n');

	const violations = checkArtifactsAndPlaceholders(files, diff);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /contains unconfigured placeholder text/);
});

test('flags YOUR_API_KEY_HERE in added lines of diff', () => {
	const files = ['packages/mcp-server/src/api.ts'];
	const diff = [
		'diff --git a/packages/mcp-server/src/api.ts b/packages/mcp-server/src/api.ts',
		'--- a/packages/mcp-server/src/api.ts',
		'+++ b/packages/mcp-server/src/api.ts',
		'@@ -1,1 +1,2 @@',
		'+const key = "YOUR_API_KEY_HERE";',
	].join('\n');

	const violations = checkArtifactsAndPlaceholders(files, diff);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /contains unconfigured placeholder text/);
});

test('ignores test files from placeholder checks', () => {
	const files = ['packages/worker/__tests__/unit/sample.test.ts'];
	const diff = [
		'diff --git a/packages/worker/__tests__/unit/sample.test.ts b/packages/worker/__tests__/unit/sample.test.ts',
		'--- a/packages/worker/__tests__/unit/sample.test.ts',
		'+++ b/packages/worker/__tests__/unit/sample.test.ts',
		'@@ -1,1 +1,2 @@',
		'+const dummy = "set this to true or false";',
	].join('\n');

	const violations = checkArtifactsAndPlaceholders(files, diff);
	assert.equal(violations.length, 0);
});

test('passes clean code changes', () => {
	const files = ['packages/shared/src/types.ts'];
	const diff = [
		'diff --git a/packages/shared/src/types.ts b/packages/shared/src/types.ts',
		'--- a/packages/shared/src/types.ts',
		'+++ b/packages/shared/src/types.ts',
		'@@ -1,1 +1,2 @@',
		'+export interface UserConfig { id: string; }',
	].join('\n');

	const violations = checkArtifactsAndPlaceholders(files, diff);
	assert.equal(violations.length, 0);
});

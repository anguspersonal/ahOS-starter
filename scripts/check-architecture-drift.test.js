'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkArchitectureDrift } = require('./check-architecture-drift.js');

test('passes when no architecture surface files or architecture docs are touched', () => {
	const files = ['packages/worker/src/index.ts', 'README.md'];
	const violations = checkArchitectureDrift(files, '', '');
	assert.equal(violations.length, 0);
});

test('flags structural service change (railway.json) when docs/architecture/architecture.md is omitted', () => {
	const files = ['railway.json'];
	const violations = checkArchitectureDrift(files, '', '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /Structural architecture files changed without updating docs\/architecture\/architecture\.md/);
});

test('flags structural service change (.railway/railway.ts) when docs/architecture/architecture.md is omitted', () => {
	const files = ['.railway/railway.ts'];
	const violations = checkArchitectureDrift(files, '', '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /Structural architecture files changed without updating docs\/architecture\/architecture\.md/);
});

test('flags Dockerfile change when docs/architecture/architecture.md is omitted', () => {
	const files = ['packages/mcp-server/Dockerfile'];
	const violations = checkArchitectureDrift(files, '', '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /Dockerfile/);
});

test('flags Supabase Edge Function addition when docs/architecture/architecture.md is omitted', () => {
	const files = ['supabase/functions/new-webhook/index.ts'];
	const violations = checkArchitectureDrift(files, '', '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /Supabase Edge Function/);
});

test('passes structural change when docs/architecture/architecture.md is included and ADR cited', () => {
	const files = ['railway.json', 'docs/architecture/architecture.md'];
	const diff = '+ Cites [ADR-100] for architecture change';
	const violations = checkArchitectureDrift(files, diff, '');
	assert.equal(violations.length, 0);
});

test('passes structural change when escape hatch -- ALLOW-ARCH-DRIFT is provided', () => {
	const files = ['railway.json'];
	const diff = '-- ALLOW-ARCH-DRIFT: environment variable tuning only';
	const violations = checkArchitectureDrift(files, diff, '');
	assert.equal(violations.length, 0);
});

test('flags docs/architecture/architecture.md update when no ADR is cited or added (ADR-043)', () => {
	const files = ['docs/architecture/architecture.md'];
	const diff = '+ Updated system topology description without citation';
	const violations = checkArchitectureDrift(files, diff, '');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /require an associated ADR or accepted ADR citation/);
});

test('passes docs/architecture/architecture.md update when new ADR file is included in PR', () => {
	const files = ['docs/architecture/architecture.md', 'docs/ADRs/ADR101_New_Topology.md'];
	const diff = '+ Updated system topology';
	const violations = checkArchitectureDrift(files, diff, '');
	assert.equal(violations.length, 0);
});

test('passes docs/architecture/architecture.md update when citing accepted ADR in commit message', () => {
	const files = ['docs/architecture/architecture.md'];
	const diff = '+ Updated system topology';
	const commitMsg = 'feat(arch): align topology with ADR-100';
	const violations = checkArchitectureDrift(files, diff, commitMsg);
	assert.equal(violations.length, 0);
});

test('passes docs/architecture/architecture.md update when escape hatch -- NO-ADR-REQUIRED is provided', () => {
	const files = ['docs/architecture/architecture.md'];
	const diff = '-- NO-ADR-REQUIRED: typographical correction';
	const violations = checkArchitectureDrift(files, diff, '');
	assert.equal(violations.length, 0);
});

test('flags Mermaid diagram update in docs/architecture/architecture.md when visual meaning views are not updated', () => {
	const files = ['docs/architecture/architecture.md'];
	const diff = [
		'diff --git a/docs/architecture/architecture.md b/docs/architecture/architecture.md',
		'--- a/docs/architecture/architecture.md',
		'+++ b/docs/architecture/architecture.md',
		'@@ -50,6 +50,7 @@',
		'+```mermaid',
		'+flowchart TB',
		'+  node_a --> node_b',
		'+```',
	].join('\n');
	const commitMsg = 'docs: update diagram ADR-100';
	const violations = checkArchitectureDrift(files, diff, commitMsg);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /Mermaid diagrams or component topologies.*were modified without updating Visual Meaning views/);
});

test('passes Mermaid diagram update in docs/architecture/architecture.md when visual meaning view is synchronized', () => {
	const files = [
		'docs/architecture/architecture.md',
		'packages/web/src/components/visual-meaning/views/infraCurrentViewData.ts',
	];
	const diff = [
		'diff --git a/docs/architecture/architecture.md b/docs/architecture/architecture.md',
		'--- a/docs/architecture/architecture.md',
		'+++ b/docs/architecture/architecture.md',
		'@@ -50,6 +50,7 @@',
		'+```mermaid',
		'+flowchart TB',
		'+  node_a --> node_b',
		'+```',
	].join('\n');
	const commitMsg = 'docs: update diagram ADR-100';
	const violations = checkArchitectureDrift(files, diff, commitMsg);
	assert.equal(violations.length, 0);
});

test('passes Mermaid diagram update in docs/architecture/architecture.md when escape hatch -- NO-VISUAL-UPDATE is provided', () => {
	const files = ['docs/architecture/architecture.md'];
	const diff = [
		'diff --git a/docs/architecture/architecture.md b/docs/architecture/architecture.md',
		'--- a/docs/architecture/architecture.md',
		'+++ b/docs/architecture/architecture.md',
		'@@ -50,6 +50,7 @@',
		'+```mermaid',
		'+flowchart TB',
		'+-- NO-VISUAL-UPDATE: styling change only',
		'+```',
	].join('\n');
	const commitMsg = 'docs: update diagram ADR-100';
	const violations = checkArchitectureDrift(files, diff, commitMsg);
	assert.equal(violations.length, 0);
});

test('passes prose edit in docs/architecture/architecture.md when @@ hunk header carries ### Runtime Services or ### Component Boundaries (#1798)', () => {
	const files = ['docs/architecture/architecture.md'];
	const diff = [
		'diff --git a/docs/architecture/architecture.md b/docs/architecture/architecture.md',
		'--- a/docs/architecture/architecture.md',
		'+++ b/docs/architecture/architecture.md',
		'@@ -100,3 +100,3 @@ ### Component Boundaries',
		' Context line before',
		'-Old prose line',
		'+Updated prose line citing ADR-109',
		'@@ -201,3 +201,3 @@ ### Runtime Services',
		' Another context line',
		'-Old runtime prose',
		'+Updated runtime prose citing ADR-109',
	].join('\n');
	const violations = checkArchitectureDrift(files, diff, 'docs(arch): reconcile prose ADR-109');
	assert.equal(violations.length, 0);
});

test('passes script-only edit in root package.json without flagging architecture drift (#1824)', () => {
	const files = ['package.json'];
	const diff = [
		'diff --git a/package.json b/package.json',
		'--- a/package.json',
		'+++ b/package.json',
		'@@ -28,1 +28,2 @@',
		'+    "verify:local": "node scripts/verify-local.js",',
	].join('\n');
	const violations = checkArchitectureDrift(files, diff, 'feat: add script');
	assert.deepEqual(violations, []);
});

test('passes dependency-only edit in packages/*/package.json without flagging architecture drift (#1824)', () => {
	const files = ['packages/mcp-server/package.json'];
	const diff = [
		'diff --git a/packages/mcp-server/package.json b/packages/mcp-server/package.json',
		'--- a/packages/mcp-server/package.json',
		'+++ b/packages/mcp-server/package.json',
		'@@ -18,1 +18,2 @@',
		'+    "zod": "^3.23.8",',
	].join('\n');
	const violations = checkArchitectureDrift(files, diff, 'chore(deps): bump zod');
	assert.deepEqual(violations, []);
});

test('flags root package.json edit when "workspaces" field is modified (#1824)', () => {
	const files = ['package.json'];
	const diff = [
		'diff --git a/package.json b/package.json',
		'--- a/package.json',
		'+++ b/package.json',
		'@@ -5,1 +5,1 @@',
		'-  "workspaces": ["packages/*"],',
		'+  "workspaces": ["packages/*", "apps/*"],',
	].join('\n');
	const violations = checkArchitectureDrift(files, diff, 'feat: add apps workspace');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /packages\/\* package manifest or workspace topology/);
});

test('flags newly created packages/<name>/package.json when docs/architecture/architecture.md is omitted (#1824)', () => {
	const files = ['packages/new-service/package.json'];
	const diff = [
		'diff --git a/packages/new-service/package.json b/packages/new-service/package.json',
		'new file mode 100644',
		'index 0000000..1111111',
		'--- /dev/null',
		'+++ b/packages/new-service/package.json',
		'@@ -0,0 +1,5 @@',
		'+{',
		'+  "name": "@ahkms/new-service",',
		'+  "version": "0.1.0"',
		'+}',
	].join('\n');
	const violations = checkArchitectureDrift(files, diff, 'feat: add new-service package');
	assert.equal(violations.length, 1);
	assert.match(violations[0], /packages\/\* package manifest or workspace topology/);
});

test('flags deleted or renamed packages/<name>/package.json when docs/architecture/architecture.md is omitted (#1824)', () => {
	const deletedFiles = ['packages/old-service/package.json'];
	const deletedDiff = [
		'diff --git a/packages/old-service/package.json b/packages/old-service/package.json',
		'deleted file mode 100644',
		'index 1111111..0000000',
		'--- a/packages/old-service/package.json',
		'+++ /dev/null',
	].join('\n');
	const deletedViolations = checkArchitectureDrift(deletedFiles, deletedDiff, 'chore: remove old-service');
	assert.equal(deletedViolations.length, 1);

	const renamedFiles = ['packages/core/package.json'];
	const renamedDiff = [
		'diff --git a/packages/core/package.json b/packages/core/package.json',
		'--- a/packages/core/package.json',
		'+++ b/packages/core/package.json',
		'@@ -2,1 +2,1 @@',
		'-  "name": "@ahkms/core",',
		'+  "name": "@ahkms/engine",',
	].join('\n');
	const renamedViolations = checkArchitectureDrift(renamedFiles, renamedDiff, 'refactor: rename core package');
	assert.equal(renamedViolations.length, 1);

	const movedFiles = ['packages/new-pkg/package.json'];
	const movedDiff = [
		'diff --git a/packages/old-pkg/package.json b/packages/new-pkg/package.json',
		'similarity index 100%',
		'rename from packages/old-pkg/package.json',
		'rename to packages/new-pkg/package.json',
	].join('\n');
	const movedViolations = checkArchitectureDrift(movedFiles, movedDiff, 'refactor: move package directory');
	assert.equal(movedViolations.length, 1);
	assert.match(movedViolations[0], /packages\/\* package manifest or workspace topology/);
});

test('flags multi-line "workspaces" array edits in root package.json under both -U0 and context diffs (#1824)', () => {
	const files = ['package.json'];
	const u0Diff = [
		'diff --git a/package.json b/package.json',
		'--- a/package.json',
		'+++ b/package.json',
		'@@ -7 +7,2 @@',
		'-    "packages/*"',
		'+    "packages/*",',
		'+    "apps/*"',
	].join('\n');
	const u0Violations = checkArchitectureDrift(files, u0Diff, 'feat: add apps workspace');
	assert.equal(u0Violations.length, 1);
	assert.match(u0Violations[0], /packages\/\* package manifest or workspace topology/);

	const contextDiff = [
		'diff --git a/package.json b/package.json',
		'--- a/package.json',
		'+++ b/package.json',
		'@@ -5,4 +5,5 @@',
		'   "private": true,',
		'   "workspaces": [',
		'-    "packages/*"',
		'+    "packages/*",',
		'+    "apps/*"',
		'   ],',
	].join('\n');
	const contextViolations = checkArchitectureDrift(files, contextDiff, 'feat: add apps workspace');
	assert.equal(contextViolations.length, 1);
	assert.match(contextViolations[0], /packages\/\* package manifest or workspace topology/);

	const scriptEditWithWorkspacesContext = [
		'diff --git a/package.json b/package.json',
		'--- a/package.json',
		'+++ b/package.json',
		'@@ -6,6 +6,7 @@',
		'   "workspaces": [',
		'     "packages/*"',
		'   ],',
		'   "scripts": {',
		'     "dev": "turbo run dev",',
		'+    "verify:local": "node scripts/verify-local.js",',
	].join('\n');
	const nonStructuralViolations = checkArchitectureDrift(files, scriptEditWithWorkspacesContext, 'feat: add script');
	assert.deepEqual(nonStructuralViolations, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAgentReadyIssue, formatRejectionComment } = require('./check-agent-ready-issue.js');

const MOCK_REPO_FILES = [
	'packages/core/src/index.ts',
	'packages/core/src/domain/agentReadyBar.ts',
	'packages/mcp-server/src/index.ts',
	'package.json',
];

const VALID_ISSUE_BODY = `
## Goal
Implement a small bugfix in the core domain index.

## Context
Background context for the bugfix.

## Files it may touch
- \`packages/core/src/index.ts\`
- \`packages/core/src/domain/newFile.ts\` (new)

## Files it must not touch
- \`packages/mcp-server/**\`

## Acceptance test (TDD: Red on dev)
\`\`\`bash
npm run test:unit
\`\`\`

## Done when
[ ] All tests pass.

## Out of scope
No public API changes.

## Stop if
The diff exceeds 100 lines.

## Size
XS (~50 lines).
`;

const INVALID_ISSUE_BODY = `
## Goal
Do something ungrounded with TBD tasks.

## Files it may touch
- \`packages/nonexistent/fake.ts\`

## Context
TBD later.
`;

test('checkAgentReadyIssue: valid payload returns ok: true, exitCode: 0, and comment markdown', async () => {
	const result = await checkAgentReadyIssue({
		issueNumber: 100,
		issueBody: VALID_ISSUE_BODY,
		repoFileList: MOCK_REPO_FILES,
		dryRun: true,
	});

	assert.equal(result.ok, true);
	assert.equal(result.exitCode, 0);
	assert.match(result.comment, /^### Agent-ready \(bar v7\)/);
	assert.match(result.comment, /Grounded: pass \(paths verified:.*packages\/core\/src\/index\.ts/);
	assert.deepEqual(result.labelsToAdd, []);
	assert.deepEqual(result.labelsToRemove, []);
});

test('checkAgentReadyIssue: invalid payload returns ok: false, exitCode: 1, and triage labels', async () => {
	const result = await checkAgentReadyIssue({
		issueNumber: 101,
		issueBody: INVALID_ISSUE_BODY,
		repoFileList: MOCK_REPO_FILES,
		dryRun: true,
	});

	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 1);
	assert.deepEqual(result.labelsToAdd, ['status:needs-triage']);
	assert.deepEqual(result.labelsToRemove, ['status:agent-ready']);
	assert.match(result.comment, /### Agent-Ready Bar: Triage Required/);
	assert.match(result.comment, /status:needs-triage/);
	assert.ok(result.reasons.length > 0);
});

test('checkAgentReadyIssue: offline execution performs zero network calls with mock github client', async () => {
	const calls = [];
	const mockApi = {
		async postComment(num, body) {
			calls.push({ type: 'comment', num, body });
		},
		async addLabels(num, labels) {
			calls.push({ type: 'addLabels', num, labels });
		},
		async removeLabel(num, label) {
			calls.push({ type: 'removeLabel', num, label });
		},
	};

	const result = await checkAgentReadyIssue({
		issueNumber: 200,
		issueBody: INVALID_ISSUE_BODY,
		repoFileList: MOCK_REPO_FILES,
		dryRun: false,
		githubApi: mockApi,
	});

	assert.equal(result.ok, false);
	assert.equal(calls.length, 3);
	assert.equal(calls[0].type, 'comment');
	assert.equal(calls[1].type, 'removeLabel');
	assert.equal(calls[1].label, 'status:agent-ready');
	assert.equal(calls[2].type, 'addLabels');
	assert.deepEqual(calls[2].labels, ['status:needs-triage']);
});

test('formatRejectionComment: formats markdown with all failing criteria', () => {
	const mockVerdict = {
		ready: false,
		criteria: {
			architecture: { id: 'architecture', title: 'Not an anti-pattern', passed: true, reason: 'ok' },
			one_person: { id: 'one_person', title: 'One person can do it', passed: true, reason: 'ok' },
			one_run: { id: 'one_run', title: 'Achievable in one run', passed: true, reason: 'ok' },
			verification: { id: 'verification', title: 'Clear verification and test plan', passed: false, reason: 'Missing Acceptance test section' },
			clarity: { id: 'clarity', title: 'Clear what to build', passed: false, reason: 'Contains unresolved open questions' },
			grounded: { id: 'grounded', title: 'Grounded in the repository', passed: false, reason: 'Target path does not exist: packages/foo.ts' },
		},
		evidenceComment: '',
	};

	const markdown = formatRejectionComment(mockVerdict);
	assert.match(markdown, /### Agent-Ready Bar: Triage Required/);
	assert.match(markdown, /Clear verification and test plan.*Missing Acceptance test section/);
	assert.match(markdown, /Clear what to build.*Contains unresolved open questions/);
	assert.match(markdown, /Grounded in the repository.*Target path does not exist/);
});

test('CLI: supports --body-file and --title flags with annotated (new: ...) markers', () => {
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const { execFileSync } = require('node:child_process');

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ready-cli-'));
	const bodyFile = path.join(tmpDir, 'issue.md');
	const annotatedBody = VALID_ISSUE_BODY.replace(
		'- `packages/core/src/domain/newFile.ts` (new)',
		'- `packages/core/src/domain/newFile.ts` (new: test fixture)',
	);
	fs.writeFileSync(bodyFile, annotatedBody, 'utf8');

	try {
		const output = execFileSync(
			process.execPath,
			[
				path.join(__dirname, 'check-agent-ready-issue.js'),
				'--body-file',
				bodyFile,
				'--title',
				'fix(scripts): test title',
				'--dry-run',
			],
			{ encoding: 'utf8' },
		);
		assert.match(output, /^### Agent-ready \(bar v7\)/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});


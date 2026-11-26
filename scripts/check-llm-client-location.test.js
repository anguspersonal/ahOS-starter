'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFile, checkLlmClientLocation } = require('./check-llm-client-location.js');

const SCRIPT_PATH = path.resolve(__dirname, 'check-llm-client-location.js');

test('checkFile: allows LLM imports under packages/core/src/adapters/', () => {
	const relPath = 'packages/core/src/adapters/gemini.ts';
	const content = `import { GoogleGenerativeAI } from '@google/generative-ai';\nexport const client = new GoogleGenerativeAI();`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 0);
});

test('checkFile: allows @google/genai import under packages/core/src/adapters/', () => {
	const relPath = 'packages/core/src/adapters/derive/llmDerivePort.ts';
	const content = `import { GoogleGenAI } from '@google/genai';\nexport const client = new GoogleGenAI();`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 0);
});

test('checkFile: permits grandfathered paths with TODO(#1321)', () => {
	const relPath = 'packages/mcp-server/src/anthropic.ts';
	const content = `import Anthropic from "@anthropic-ai/sdk";`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 0);
});

test('checkFile: flags forbidden @anthropic-ai/sdk import outside adapters', () => {
	const relPath = 'packages/mcp-server/src/tools/rogueTool.ts';
	const content = `import Anthropic from '@anthropic-ai/sdk';`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /direct LLM SDK import/);
	assert.match(violations[0], /packages\/core\/src\/adapters\//);
});

test('checkFile: flags forbidden @google/generative-ai import outside adapters', () => {
	const relPath = 'packages/worker/src/services/aiService.ts';
	const content = `const { GoogleGenerativeAI } = require('@google/generative-ai');`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /direct LLM SDK import/);
	assert.match(violations[0], /packages\/core\/src\/adapters\//);
});

test('checkFile: flags forbidden @google/genai import outside adapters (from, require, dynamic import)', () => {
	for (const content of [
		`import { GoogleGenAI } from '@google/genai';`,
		`const { GoogleGenAI } = require('@google/genai');`,
		`const genai = await import('@google/genai');`,
	]) {
		const violations = checkFile('packages/worker/src/rogue.ts', content);
		assert.equal(violations.length, 1);
		assert.match(violations[0], /direct LLM SDK import/);
		assert.match(violations[0], /packages\/core\/src\/adapters\//);
	}
});

test('checkFile: flags direct generativelanguage.googleapis.com URL outside adapters', () => {
	const relPath = 'packages/web/src/components/chat.tsx';
	const content = `fetch('https://generativelanguage.googleapis.com/v1beta/models');`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /hardcoded LLM API endpoint/);
});

test('checkFile: flags direct api.anthropic.com URL outside adapters', () => {
	const relPath = 'packages/worker/src/anthropicFetch.ts';
	const content = `fetch('https://api.anthropic.com/v1/messages');`;
	const violations = checkFile(relPath, content);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /hardcoded LLM API endpoint/);
});

test('CLI: clean fixture exits 0 with no error output', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-clean-'));
	try {
		const cleanFile = path.join(tmpDir, 'clean.ts');
		fs.writeFileSync(cleanFile, 'export const greeting = "hello world";\n', 'utf8');

		const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', cleanFile], {
			encoding: 'utf8',
		});

		assert.equal(res.status, 0);
		assert.equal(res.stderr, '');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('CLI: violating fixture exits 1 and message cites packages/core/src/adapters/ and ADR-101 / ADR-102', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-violating-'));
	try {
		const rogueFile = path.join(tmpDir, 'rogue.ts');
		fs.writeFileSync(rogueFile, "import Anthropic from '@anthropic-ai/sdk';\n", 'utf8');

		const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', rogueFile], {
			encoding: 'utf8',
		});

		assert.equal(res.status, 1);
		assert.match(res.stderr, /packages\/core\/src\/adapters\//);
		assert.match(res.stderr, /ADR-101 \/ ADR-102 §3/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

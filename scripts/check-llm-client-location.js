#!/usr/bin/env node
'use strict';

/**
 * LLM client location guard (ADR-101 / ADR-102 §3).
 *
 * Prevents direct LLM provider SDK imports (@google/genai, @google/generative-ai, @anthropic-ai/sdk)
 * or direct provider API endpoints (generativelanguage.googleapis.com, api.anthropic.com)
 * outside of packages/core/src/adapters/**.
 *
 * ADR-101 §3 and ADR-102 establish that all direct LLM interactions must be encapsulated
 * inside adapter implementations in packages/core/src/adapters/. Neither mcp-server tools,
 * worker services, nor browser UI components should instantiate vendor LLM clients directly.
 *
 * Grandfathered existing offenders from before ADR-102 are listed in GRANDFATHERED_PATHS with TODO(#1321).
 *
 * Usage:
 *   node scripts/check-llm-client-location.js
 *   node scripts/check-llm-client-location.js --files <file1,file2>
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const GRANDFATHERED_PATHS = [
	// TODO(#1321): Move Anthropic client to packages/core/src/adapters/anthropic.ts
	'packages/mcp-server/src/anthropic.ts',
	// TODO(#1321): Move worker Anthropic client to packages/core/src/adapters/anthropic.ts
	'packages/worker/src/utils/anthropic.ts',
	// TODO(#1321): Move Gemini client to packages/core/src/adapters/gemini.ts
	'packages/web/src/lib/gemini.ts',
	// TODO(#1321): Migrate Vite dev proxy target once web routes via core/CAR
	'packages/web/vite.config.ts',
	// TODO(#1321): Test fixture referencing generativelanguage.googleapis.com in mock error
	'packages/web/src/__tests__/geminiChat.test.ts',
];

const ALLOWED_PREFIX = 'packages/core/src/adapters/';

const FORBIDDEN_PATTERNS = [
	{
		regex: /(?:from\s+['"]|require\s*\(\s*['"])(?:@google\/genai|@google\/generative-ai|@anthropic-ai\/sdk)['"]|import\s*\(\s*['"](?:@google\/genai|@google\/generative-ai|@anthropic-ai\/sdk)['"]\s*\)/,
		description: 'direct LLM SDK import (@google/genai, @google/generative-ai, @anthropic-ai/sdk)',
	},
	{
		regex: /\b(?:generativelanguage\.googleapis\.com|api\.anthropic\.com)\b/,
		description: 'hardcoded LLM API endpoint (generativelanguage.googleapis.com, api.anthropic.com)',
	},
];

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function findCodeFiles(dir) {
	const results = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === 'node_modules' ||
				entry.name === 'dist' ||
				entry.name === '.git' ||
				entry.name === '.turbo' ||
				entry.name === 'coverage'
			) {
				continue;
			}
			results.push(...findCodeFiles(fullPath));
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			if (CODE_EXTENSIONS.has(ext)) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

function checkFile(relPath, content) {
	const normalized = relPath.replace(/\\/g, '/');

	if (normalized.startsWith(ALLOWED_PREFIX)) {
		return [];
	}

	if (GRANDFATHERED_PATHS.includes(normalized)) {
		return [];
	}

	// Exclude self and test files of this guard
	if (
		normalized === 'scripts/check-llm-client-location.js' ||
		normalized === 'scripts/check-llm-client-location.test.js'
	) {
		return [];
	}

	const violations = [];
	for (const { regex, description } of FORBIDDEN_PATTERNS) {
		if (regex.test(content)) {
			violations.push(
				`${normalized}: contains ${description}. LLM client SDKs and endpoints belong in ${ALLOWED_PREFIX} (ADR-101 / ADR-102 §3).`
			);
		}
	}

	return violations;
}

function checkLlmClientLocation(filesToScan) {
	const violations = [];

	for (const file of filesToScan) {
		const relPath = path.isAbsolute(file) ? path.relative(REPO_ROOT, file) : file;
		const absPath = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);

		if (!fs.existsSync(absPath)) continue;

		const content = fs.readFileSync(absPath, 'utf8');
		const fileViolations = checkFile(relPath, content);
		violations.push(...fileViolations);
	}

	return violations;
}

function main(argv = process.argv.slice(2)) {
	let filesToScan = [];
	const filesIdx = argv.indexOf('--files');

	if (filesIdx !== -1 && argv[filesIdx + 1]) {
		filesToScan = argv[filesIdx + 1]
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	} else {
		const packagesDir = path.join(REPO_ROOT, 'packages');
		if (fs.existsSync(packagesDir)) {
			filesToScan = findCodeFiles(packagesDir);
		}
	}

	const violations = checkLlmClientLocation(filesToScan);

	if (violations.length > 0) {
		console.error('llm-client-location: violations found:');
		for (const v of violations) {
			console.error(`  ${v}`);
		}
		return 1;
	}

	return 0;
}

if (require.main === module) {
	process.exit(main());
}

module.exports = {
	checkFile,
	checkLlmClientLocation,
	findCodeFiles,
	main,
	GRANDFATHERED_PATHS,
	ALLOWED_PREFIX,
	FORBIDDEN_PATTERNS,
};

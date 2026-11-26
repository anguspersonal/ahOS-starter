'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { checkNoNewCadence } = require('./check-no-new-cadence.js');

const SCRIPT_PATH = path.resolve(__dirname, 'check-no-new-cadence.js');

test('checkNoNewCadence unit: passes clean additions outside legacy schedule directories', () => {
	const cleanFiles = [
		'packages/core/src/engine/newLoop.ts',
		'packages/mcp-server/src/tools/newTool.ts',
		'packages/worker/src/services/newService.ts',
	];
	const violations = checkNoNewCadence(cleanFiles);
	assert.equal(violations.length, 0);
});

test('checkNoNewCadence unit: flags file added under packages/mcp-server/src/schedule/', () => {
	const violatingFiles = [
		'packages/mcp-server/src/schedule/nightlySweep.ts',
	];
	const violations = checkNoNewCadence(violatingFiles);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /packages\/core\/src\/engine\//);
	assert.match(violations[0], /nightlySweep\.ts/);
});

test('checkNoNewCadence unit: flags file added under packages/worker/src/schedule/', () => {
	const violatingFiles = [
		'packages/worker/src/schedule/hourlyJob.ts',
	];
	const violations = checkNoNewCadence(violatingFiles);
	assert.equal(violations.length, 1);
	assert.match(violations[0], /packages\/core\/src\/engine\//);
	assert.match(violations[0], /hourlyJob\.ts/);
});

test('CLI: clean fixture exits 0 with no error output', () => {
	const cleanFiles = 'packages/core/src/engine/loop.ts,packages/mcp-server/src/tools/search.ts';
	const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', cleanFiles], {
		encoding: 'utf8',
	});

	assert.equal(res.status, 0);
	assert.equal(res.stderr, '');
});

test('CLI: violating fixture exits 1 and message points at packages/core/src/engine/', () => {
	const violatingFiles = 'packages/core/src/index.ts,packages/mcp-server/src/schedule/autoEnrich.ts';
	const res = spawnSync(process.execPath, [SCRIPT_PATH, '--files', violatingFiles], {
		encoding: 'utf8',
	});

	assert.equal(res.status, 1);
	assert.match(res.stderr, /packages\/core\/src\/engine\//);
	assert.match(res.stderr, /packages\/mcp-server\/src\/schedule\/autoEnrich\.ts/);
});

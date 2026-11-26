'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { checkDirectory } = require('./check-circular-deps.js');

test('checkDirectory: reports clean when no cycles exist', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-cycle-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmpDir, 'a.js'), 'import { b } from "./b.js"; export const a = 1;');
  fs.writeFileSync(path.join(tmpDir, 'b.js'), 'export const b = 2;');

  const result = checkDirectory(tmpDir);
  assert.equal(result.filesCount, 2);
  assert.equal(result.cycles.length, 0);
});

test('checkDirectory: detects simple 2-module cycle', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '2-cycle-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmpDir, 'a.js'), 'import { b } from "./b.js"; export const a = 1;');
  fs.writeFileSync(path.join(tmpDir, 'b.js'), 'import { a } from "./a.js"; export const b = 2;');

  const result = checkDirectory(tmpDir);
  assert.equal(result.filesCount, 2);
  assert.equal(result.cycles.length, 1);
  const cyclePaths = result.cycles[0].map((p) => path.basename(p));
  assert.deepEqual(cyclePaths, ['a.js', 'b.js', 'a.js']);
});

test('checkDirectory: ignores import statements inside comments', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // a.js mentions b.js in a comment, but does not import it
  fs.writeFileSync(path.join(tmpDir, 'a.js'), '// import { b } from "./b.js";\n/* import { b } from "./b.js"; */\nexport const a = 1;');
  fs.writeFileSync(path.join(tmpDir, 'b.js'), 'import { a } from "./a.js"; export const b = 2;');

  const result = checkDirectory(tmpDir);
  assert.equal(result.filesCount, 2);
  assert.equal(result.cycles.length, 0);
});

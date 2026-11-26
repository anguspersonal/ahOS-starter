const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Before the require, process.exit is replaced with a function that throws,
// and restored afterwards. The require must succeed.
const originalExit = process.exit;
let guardModule;
try {
  process.exit = (code) => {
    throw new Error(`process.exit(${code}) called on import`);
  };
  guardModule = require('./check-standalone-lockfiles.js');
} finally {
  process.exit = originalExit;
}

test('exports STANDALONE_PACKAGES including web, auditPackage, and main without exiting on require', () => {
  assert.ok(Array.isArray(guardModule.STANDALONE_PACKAGES));
  assert.ok(guardModule.STANDALONE_PACKAGES.includes('web'));
  assert.strictEqual(typeof guardModule.auditPackage, 'function');
  assert.strictEqual(typeof guardModule.main, 'function');
});

test('fails with exit 1 when package manifest exists but package-lock.json is missing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lock-missing-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'x');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.0' } })
    );
    const audit = guardModule.auditPackage('x', tmpRoot);
    assert.strictEqual(audit.lockMissing, true);
    assert.strictEqual(audit.skipped, false);
    const code = guardModule.main({ root: tmpRoot, packages: ['x'] });
    assert.strictEqual(code, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('skips a retired package whose directory does not exist and returns 0', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pkg-gone-'));
  try {
    const audit = guardModule.auditPackage('gone', tmpRoot);
    assert.strictEqual(audit.skipped, true);
    assert.strictEqual(audit.lockMissing, false);
    assert.deepStrictEqual(audit.missing, []);
    const code = guardModule.main({ root: tmpRoot, packages: ['gone'] });
    assert.strictEqual(code, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('omits a declared dependency in lockfile: missing names it and main returns 1', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-missing-dep-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'y');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'y',
        dependencies: {
          foo: '^1.0.0',
          bar: '^2.0.0',
          '@ahkms/shared': '*',
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, 'package-lock.json'),
      JSON.stringify({
        name: 'y',
        lockfileVersion: 3,
        packages: {
          '': {
            dependencies: {
              foo: '^1.0.0',
            },
          },
        },
      })
    );
    const audit = guardModule.auditPackage('y', tmpRoot);
    assert.strictEqual(audit.lockMissing, false);
    assert.deepStrictEqual(audit.missing, ['bar']);
    const code = guardModule.main({ root: tmpRoot, packages: ['y'] });
    assert.strictEqual(code, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('auditPackage("web") on repo root is clean with lock present and no missing dependencies', () => {
  const audit = guardModule.auditPackage('web');
  assert.strictEqual(audit.skipped, false);
  assert.strictEqual(audit.lockMissing, false);
  assert.deepStrictEqual(audit.missing, []);
});

test('packages/web/Dockerfile copies package-lock.json with package.json before npm install', () => {
  const dockerfilePath = path.join(__dirname, '..', 'packages', 'web', 'Dockerfile');
  const content = fs.readFileSync(dockerfilePath, 'utf-8');
  const workdirIdx = content.indexOf('WORKDIR /usr/src/app/packages/web');
  assert.ok(workdirIdx !== -1, 'WORKDIR /usr/src/app/packages/web exists');
  const afterWorkdir = content.slice(workdirIdx);
  const copyIdx = afterWorkdir.indexOf('COPY packages/web/package.json packages/web/package-lock.json ./');
  assert.ok(copyIdx !== -1, 'COPY packages/web/package.json packages/web/package-lock.json ./ exists');
  const runInstallIdx = afterWorkdir.indexOf('RUN npm install');
  assert.ok(runInstallIdx !== -1, 'RUN npm install exists');
  assert.ok(copyIdx < runInstallIdx, 'COPY comes before RUN npm install');
});

test('packages/web/Dockerfile pins core dependencies to web package-lock.json', () => {
  const dockerfilePath = path.join(__dirname, '..', 'packages', 'web', 'Dockerfile');
  const content = fs.readFileSync(dockerfilePath, 'utf-8');
  assert.ok(content.includes('COPY scripts/pin-core-to-service-lock.js /tmp/pin-core-to-service-lock.js'), 'copies pin-core script');
  assert.ok(content.includes('RUN node /tmp/pin-core-to-service-lock.js /tmp/service-lock.json package.json'), 'runs pin-core script');
});

test('all service Dockerfiles copy packages/core/action-manifest.json exported by @ahkms/core', () => {
  for (const pkg of ['web', 'mcp-server', 'worker']) {
    const dockerfilePath = path.join(__dirname, '..', 'packages', pkg, 'Dockerfile');
    const content = fs.readFileSync(dockerfilePath, 'utf-8');
    assert.ok(
      content.includes('packages/core/action-manifest.json'),
      `packages/${pkg}/Dockerfile must copy packages/core/action-manifest.json`
    );
  }
});


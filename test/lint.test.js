'use strict';
// The project lint (test/lint.js) passes on the repo and catches each kind of violation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const lint = (dir) => spawnSync(process.execPath, [path.join(__dirname, 'lint.js')], { env: { ...process.env, LINT_ROOT: dir }, encoding: 'utf8' });
const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-lint-'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.copyFileSync(path.join(root, '.github/workflows/ci.yml'), path.join(dir, '.github/workflows/ci.yml'));
  for (const f of ['rea-availability-filter.user.js', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'SECURITY.md', 'PRIVACY.md']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js'))) fs.copyFileSync(path.join(__dirname, f), path.join(dir, 'test', f));
  return dir;
};
const edit = (dir, fn) => { const p = path.join(dir, 'rea-availability-filter.user.js'); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };

test('lint passes on the repository', () => {
  const r = lint(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lint: ok/);
});

test('lint catches header, changelog, privacy, storage and dynamic-code violations', () => {
  const cases = [
    [(s) => s.replace('// @grant        none', '// @grant        GM_xmlhttpRequest'), /@grant must stay "none"/],
    [(s) => s.replace(/(\/\/ @version\s+)\S+/, '$19.9.9'), /CHANGELOG\.md top entry/],
    [(s) => s.replace('const nullStorage', "const leak = 'https://evil.example.com/x';\n  const nullStorage"), /URL outside realestate\.com\.au: https:\/\/evil\.example\.com\/x/],
    [(s) => s.replace('const nullStorage', "const k = 'rea-avail-filter/stray';\n  const nullStorage"), /storage key literal/],
    [(s) => s.replace('const nullStorage', "localStorage.setItem('x', 1);\n  const nullStorage"), /literal key/],
    [(s) => s.replace('const nullStorage', "eval('1');\n  const nullStorage"), /dynamic code/],
    [(s) => s.replace('const nullStorage', "new WebSocket('wss://www.realestate.com.au');\n  const nullStorage"), /WebSocket is not used/],
  ];
  for (const [fn, re] of cases) {
    const dir = copy();
    edit(dir, fn);
    const r = lint(dir);
    assert.equal(r.status, 1, `expected failure for ${re}`);
    assert.match(r.stderr, re);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint catches a Playwright version that differs from CI', () => {
  const dir = copy();
  const p = path.join(dir, 'package.json');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/playwright@\d+\.\d+\.\d+/, 'playwright@1.0.0'));
  const r = lint(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /playwright@1\.0\.0, CI pins/);
  fs.rmSync(dir, { recursive: true, force: true });
});

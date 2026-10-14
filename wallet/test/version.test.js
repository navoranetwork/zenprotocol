// The release number in package.json has its entry in CHANGELOG.md (see the top of that file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package.json version is a release in CHANGELOG.md, with a date', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(log, new RegExp(`^## ${version.replace(/\./g, '\\.')} — \\d{4}-\\d{2}-\\d{2}$`, 'm'), `CHANGELOG.md has no "## ${version} — <date>" entry`);
  assert.match(log, /^## Unreleased$/m);
});

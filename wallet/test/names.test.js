// site/contract-names.json: every address key is a valid ZP address (a typo would leave its contract unnamed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAddress } from '../src/keys.js';

test('contract names: address keys decode, id keys are 72 hex', () => {
  const names = JSON.parse(readFileSync(new URL('../../site/contract-names.json', import.meta.url)));
  for (const k of Object.keys(names).filter(k => k !== '_comment')) {
    if (/^[0-9a-f]{72}$/.test(k)) continue;
    assert.doesNotThrow(() => decodeAddress(k), k);
  }
});

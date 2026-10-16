// The public test wallets that the services refuse:  node --test site/test/known-wallets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { KNOWN_TEST_WALLETS, isKnownTestKey } from '../known-wallets.mjs';
import { accountFromMnemonic, deriveKey } from '../../wallet/src/keys.js';

const phrases = ['abandon '.repeat(23) + 'art', 'abandon '.repeat(11) + 'about', 'test '.repeat(11) + 'junk', 'zoo '.repeat(11) + 'wrong',
  'legal winner thank year wave sausage worth useful legal winner thank yellow'];
test('the list is the 0/0 key of each public phrase', () => {
  const keys = phrases.map(p => Buffer.from(deriveKey(accountFromMnemonic(p), 0, 0).publicKey).toString('hex'));
  assert.deepEqual(keys.sort(), Object.keys(KNOWN_TEST_WALLETS).sort());
  assert.ok(isKnownTestKey('"' + keys[0].toUpperCase() + '"'));
  assert.ok(!isKnownTestKey('02' + 'ab'.repeat(32)));
});

test('a service stops on a public wallet: always on mainnet, on the testnet unless ZP_ALLOW_TEST_KEYS=1', async () => {
  const run = async (address, allow) => {
    const pk = Object.keys(KNOWN_TEST_WALLETS)[0];
    const srv = http.createServer((q, s) => s.end(JSON.stringify(q.url === '/wallet/address' ? address : pk))).listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    const out = await new Promise(ok => {
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['scripts/check-wallet.mjs', `http://127.0.0.1:${srv.address().port}`, 'pw', 'test'],
        { env: { ...process.env, ZP_ALLOW_TEST_KEYS: allow ? '1' : '' } }, (e, so, se) => ok({ code: e ? e.code : 0, se })));
    });
    srv.close(); return out.code;
  };
  assert.equal(await run('tzn1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqshjlp3', false), 3);
  assert.equal(await run('tzn1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqshjlp3', true), 0);
  assert.equal(await run('zen1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqsabcdef', true), 3);
});

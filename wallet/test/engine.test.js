// The contract engine's contracts in the wallet: the id the wallet computes itself, the activation it signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { v1ContractId, v1SourceBytes, activationCost, checkParam, EngineClient, kalapasOf, formatAmount, bodyHexOf, commandsOf, holdings, sendsAsset, windowsOf, engineAsset, tryAsset } from '../src/engine.js';
import { openWallet, prepareActivateV1 } from '../src/wallet.js';
import { deriveKey } from '../src/keys.js';
import { deserializeTx, txHash, hex, unhex, Writer, Data, Asset } from '../src/serialize.js';
import { verifyDigest } from '../src/tx.js';

const src = 'module X\nlet main = 1   // é ✓\n';
test('V1 contract id = SHA3-256(BE32(1) || UTF-8 source), as Contract.fs makeContractId', () => {
  const b = new TextEncoder().encode(src);
  assert.equal(v1ContractId(src), '00000001' + hex(sha3_256(Uint8Array.from([0, 0, 0, 1, ...b]))));
  assert.notEqual(v1ContractId(src), v1ContractId(src + ' '));
  assert.throws(() => v1SourceBytes('x'.repeat(65537)), /at most 65,536/);
  assert.throws(() => v1SourceBytes('bad \ud800 surrogate'), /not valid UTF-8/);
  assert.equal(activationCost('abcd', 10), 40n);
});

test('family parameters are checked like the engine does', () => {
  assert.equal(checkParam('owner', { type: 'publickey' }, ' 03' + 'AB'.repeat(32)), '03' + 'ab'.repeat(32));
  assert.throws(() => checkParam('owner', { type: 'publickey' }, '04' + 'ab'.repeat(32)), /02 or 03/);
  assert.throws(() => checkParam('t', { type: 'u32', min: 2 }, '1'), /at least 2/);
  assert.equal(checkParam('a', { type: 'amount' }, '2.5 ZP'), '2.5 ZP');
  assert.equal(checkParam('a', { type: 'asset', default: 'zp' }, ''), null);
  assert.throws(() => checkParam('s', { type: 'string' }, 'say "hi"'), /no quotes/);
  assert.throws(() => checkParam('s', { type: 'string' }, 'a\nb'), /one line/);
});

test('activation: the source in the contract field, length x blocks to ActivationSacrifice, refused for another id', () => {
  const w = openWallet({ id: 'a', name: 'a', network: 'test', kind: 'mnemonic' }, Array(23).fill('abandon').concat('art').join(' '));
  const k = deriveKey(w.account, 0, 0);
  const state = { tip: 2100, utxos: [{ outpoint: { txHash: new Uint8Array(32).fill(3), index: 0 }, lock: { type: 'PK', hash: k.pkHash }, spend: { asset: '00', amount: 10n ** 9n } }] };
  const p = prepareActivateV1(w, state, src, 1000, v1ContractId(src));
  const tx = deserializeTx(unhex(p.hex));
  assert.equal(tx.contract.version, 1);
  assert.equal(new TextDecoder().decode(tx.contract.bytes), src);
  const sac = tx.outputs.find(o => o.lock.type === 'ActivationSacrifice');
  assert.equal(sac.spend.amount, BigInt(src.length) * 1000n);
  assert.ok(verifyDigest(tx.witnesses[0].signature, txHash(tx), k.publicKey));
  assert.ok(p.address.startsWith('ctzn1'));
  assert.throws(() => prepareActivateV1(w, state, src, 1000, '00000001' + 'ab'.repeat(32)), /does not match/);
  assert.throws(() => prepareActivateV1(w, state, src, 0), /from 1/);
});

test('engine client: polls a job until done, explains errors', async () => {
  let n = 0;
  const f = async (url, o) => {
    if (url.endsWith('/engine/make')) return new Response(JSON.stringify({ job: 'abcdef0123456789abcdef01', status: 'queued' }), { status: 202 });
    if (url.includes('/engine/job/')) { n++; return new Response(JSON.stringify(n < 3 ? { status: 'running' } : { status: 'done', ok: true })); }
    if (url.endsWith('/engine/ask')) return new Response(JSON.stringify({ error: 'over the daily limit' }), { status: 429 });
    return new Response('{}', { status: 404 });
  };
  const e = new EngineClient('https://x', f);
  const { job } = await e.make('token', {});
  const steps = []; const j = await e.wait(job, s => steps.push(s.status), { everyMs: 1 });
  assert.equal(j.status, 'done'); assert.deepEqual(steps, ['running', 'running', 'done']);
  await assert.rejects(e.ask('x'), /descriptions are used up/);
  await assert.rejects(new EngineClient('https://x', async () => new Response('{}', { status: 503 })).families(), /The contract service is busy: try again in a few minutes/);
  await assert.rejects(new EngineClient('https://x', async () => { throw new TypeError('offline'); }).families(), /Can't reach the contract service.*not affected/);
});

test('try: amounts, body bytes, commands and holdings', () => {
  assert.equal(kalapasOf('2.5 ZP'), '250000000'); assert.equal(kalapasOf('300'), '300');
  assert.throws(() => kalapasOf('2.5'), /kalapas, or an amount/);
  assert.equal(formatAmount('-600000000', 'zp'), '-6 ZP'); assert.equal(formatAmount('250000000', { contract: { version: 0, hash: '00'.repeat(32) }, subtype: '00'.repeat(32) }), '2.5 ZP');
  assert.equal(formatAmount('7', 'ab'.repeat(32)), '7 token abababab…');
  // the escrow body { amount: u64 } as the node signs it: Dict(12), 1 entry, "amount", U64(5) 300
  const w = new Writer(); Data.write(w, { t: 'Dict', v: [['amount', { t: 'U64', v: 300n }]] });
  assert.equal(bodyHexOf([['amount', { type: 'amount', data: 'u64' }]], { amount: '300' }), hex(w.out()));
  assert.equal(bodyHexOf([['amount', { type: 'amount', data: 'u64' }]], { amount: '0.000003 ZP' }), hex(w.out()));
  assert.equal(bodyHexOf([], {}), null);
  assert.throws(() => bodyHexOf([['to', { type: 'address', data: 'lock' }]], { to: 'zz' }), /public key hash/);
  assert.throws(() => bodyHexOf([['x', { type: 'mystery', data: 'mystery' }]], { x: '1' }), /cannot fill/);
  const fam = { params: { asset: { type: 'asset', default: 'zp' }, timeout_block: { type: 'u32' }, options: { type: 'options' } }, commands: {
    deposit: { description: 'Lock what you send', sends: 'asset', signedBy: [], body: {} },
    refund: { sends: null, signedBy: ['seller', 'arbiter'], anyoneFrom: 'timeout_block', body: { amount: { type: 'amount', data: 'u64' } } },
    vote: { sends: 'self', signedBy: [], until: 'timeout_block', body: { choice: { type: 'choice', data: 'string', of: 'options' }, returnAddress: { type: 'address', data: 'lock' } } } } };
  const cmds = commandsOf(fam);
  assert.deepEqual(cmds.map(c => c.name), ['deposit', 'refund', 'vote']); assert.deepEqual(cmds[1].signedBy, ['seller', 'arbiter']); assert.equal(cmds[1].body[0][0], 'amount');
  assert.equal(sendsAsset(cmds[0], { asset: 'AB'.repeat(32) }, fam, 'cc'.repeat(32)), 'ab'.repeat(32)); assert.equal(sendsAsset(cmds[0], {}, fam, 'x'), 'zp');
  assert.equal(sendsAsset(cmds[2], {}, fam, 'cc'.repeat(32)), 'cc'.repeat(32)); assert.equal(sendsAsset(cmds[1], {}, fam, 'x'), null);
  assert.deepEqual(windowsOf(cmds[1], { timeout_block: '5000' }), [{ kind: 'anyoneFrom', block: 5000 }]); assert.deepEqual(windowsOf(cmds[1], {}), []);
  const vb = bodyHexOf(cmds[2].body, { choice: 'yes', returnAddress: 'ab'.repeat(32) }, { choices: { choice: ['yes', 'no'] } });
  const w2 = new Writer(); Data.write(w2, { t: 'Dict', v: [['choice', { t: 'String', v: 'yes' }], ['returnAddress', { t: 'Lock', v: { type: 'PK', hash: unhex('ab'.repeat(32)) } }]] }); assert.equal(vb, hex(w2.out()));
  assert.throws(() => bodyHexOf(cmds[2].body, { choice: 'maybe', returnAddress: 'ab'.repeat(32) }, { choices: { choice: ['yes', 'no'] } }), /one of yes, no/);
  assert.deepEqual(holdings([{ asset: 'zp', amount: '200' }, { asset: 'zp', amount: '400' }]).map(h => h.amount), [600n]);
});

test('try: sourceId first, the source again when the engine no longer has it', async () => {
  const sent = [];
  const f = async (url, o) => { const b = JSON.parse(o.body); sent.push(b); return b.sourceId ? new Response(JSON.stringify({ error: 'send the source' }), { status: 404 }) : new Response(JSON.stringify({ job: 'ab'.repeat(12) }), { status: 202 }); };
  const r = await new EngineClient('https://x', f).try({ source: 'let main = 1', sourceId: '00000001' + 'ab'.repeat(32), call: { command: 'deposit' }, roles: { buyer: '03' + 'ab'.repeat(32) } });
  assert.equal(r.job, 'ab'.repeat(12)); assert.equal(sent.length, 2); assert.ok(!('source' in sent[0])); assert.equal(sent[1].source, 'let main = 1'); assert.equal(sent[1].roles.buyer, '03' + 'ab'.repeat(32));
});

test('a wallet asset as the engine names it: zp, or v<version>:<contract hash>[:<subtype>]; /try takes the hash form', () => {
  // the node's JSON form (Consensus Asset.toString): BE32 version + contract hash [+ 32-byte subtype], e.g. the testnet's zUSDC
  assert.equal(engineAsset('00'), 'zp');
  const h = 'ee'.repeat(32), sub = '01'.padEnd(64, '0');
  assert.equal(engineAsset('00000001' + h), 'v1:' + h);
  assert.equal(engineAsset('00000000' + h + sub), `v0:${h}:${sub}`);
  assert.equal(engineAsset('000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577'), 'v1:5ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577');
  assert.equal(checkParam('asset', { type: 'asset' }, 'v1:' + h), 'v1:' + h);
  assert.throws(() => checkParam('asset', { type: 'asset' }, 'nothex'), /contract hash/);
  assert.equal(tryAsset('v1:' + h), h); assert.equal(tryAsset('zp'), 'zp');
});

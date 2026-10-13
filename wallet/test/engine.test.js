// The contract engine's contracts in the wallet: the id the wallet computes itself, the activation it signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { v1ContractId, v1SourceBytes, activationCost, checkParam, EngineClient, kalapasOf, formatAmount, bodyHexOf, commandsOf, holdings } from '../src/engine.js';
import { openWallet, prepareActivateV1 } from '../src/wallet.js';
import { deriveKey } from '../src/keys.js';
import { deserializeTx, txHash, hex, unhex, Writer, Data } from '../src/serialize.js';
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
  await assert.rejects(e.ask('x'), /daily limit/);
});

test('try: amounts, body bytes, commands and holdings', () => {
  assert.equal(kalapasOf('2.5 ZP'), '250000000'); assert.equal(kalapasOf('300'), '300');
  assert.throws(() => kalapasOf('2.5'), /kalapas, or an amount/);
  assert.equal(formatAmount('-600000000', 'zp'), '-6 ZP'); assert.equal(formatAmount('250000000', { contract: { version: 0, hash: '00'.repeat(32) }, subtype: '00'.repeat(32) }), '2.5 ZP');
  assert.equal(formatAmount('7', 'ab'.repeat(32)), '7 token abababab…');
  // the escrow body { amount: u64 } as the node signs it: Dict(12), 1 entry, "amount", U64(5) 300
  const w = new Writer(); Data.write(w, { t: 'Dict', v: [['amount', { t: 'U64', v: 300n }]] });
  assert.equal(bodyHexOf([['amount', { type: 'u64' }]], { amount: '300' }), hex(w.out()));
  assert.equal(bodyHexOf([['amount', { type: 'u64' }]], { amount: '0.000003 ZP' }), hex(w.out()));
  assert.equal(bodyHexOf([], {}), null);
  assert.throws(() => bodyHexOf([['who', { type: 'publickey' }]], { who: '04' + 'ab'.repeat(32) }), /public key/);
  assert.throws(() => bodyHexOf([['x', { type: 'mystery' }]], { x: '1' }), /cannot fill/);
  const cmds = commandsOf({ commands: { release: { description: 'pays the seller', signedBy: ['buyer', 'arbiter'], body: { amount: { type: 'u64' } } }, deposit: { sends: true } } });
  assert.deepEqual(cmds.map(c => c.name), ['release', 'deposit']); assert.deepEqual(cmds[0].signedBy, ['buyer', 'arbiter']); assert.equal(cmds[0].body[0][0], 'amount');
  assert.deepEqual(commandsOf({ commands: [{ name: 'refund', body: [{ name: 'amount', type: 'u64' }] }] })[0].body[0][1].type, 'u64');
  assert.deepEqual(holdings([{ asset: 'zp', amount: '200' }, { asset: 'zp', amount: '400' }]).map(h => h.amount), [600n]);
});

test('try: sourceId first, the source again when the engine no longer has it', async () => {
  const sent = [];
  const f = async (url, o) => { const b = JSON.parse(o.body); sent.push(b); return b.sourceId ? new Response(JSON.stringify({ error: 'send the source' }), { status: 404 }) : new Response(JSON.stringify({ job: 'ab'.repeat(12) }), { status: 202 }); };
  const r = await new EngineClient('https://x', f).try({ source: 'let main = 1', sourceId: '00000001' + 'ab'.repeat(32), call: { command: 'deposit' }, roles: { buyer: '03' + 'ab'.repeat(32) } });
  assert.equal(r.job, 'ab'.repeat(12)); assert.equal(sent.length, 2); assert.ok(!('source' in sent[0])); assert.equal(sent[1].source, 'let main = 1'); assert.equal(sent[1].roles.buyer, '03' + 'ab'.repeat(32));
});

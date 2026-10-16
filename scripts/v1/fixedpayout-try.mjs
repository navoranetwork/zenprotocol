// Tests of FixedPayout V1 (contracts/v1/FixedPayout.fst, docs/BETS.md) against the contract engine service: the node's
// verdict (check) and every command run as a node runs it, with gas (try). Nothing is signed, sent or activated.
// Needs an engine on zp-contracts-v1 dab00f8 or later (Zen.MerkleTree, Zen.Integers).
//
// The market: BTC at or above 110,000 at the close CLOSE, collateral a test token standing for zUSDC. The oracle's
// round has one leaf (BTC), so its Merkle root is the leaf and the audit path is empty (as in zp-contracts-v1
// tests/merkle/vectors.txt, the 1-leaf vector). The leaf is SHA3(ticker bytes, value x 1000 as a big-endian U64), as the
// oracle service builds it (src/Oracle/Leaf.fs).
//
// usage: node scripts/v1/fixedpayout-try.mjs [engine url]     (default http://127.0.0.1:11580/engine)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENGINE = (process.argv[2] || 'http://127.0.0.1:11580/engine').replace(/\/$/, '');
const source = readFileSync(new URL('../../contracts/v1/FixedPayout.fst', import.meta.url), 'utf8');
const sha3 = (...parts) => createHash('sha3-256').update(Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'hex') : p))).digest('hex');
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const be64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const contractHash = sha3(be32(1), Buffer.from(source, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const D = {
  u64: n => Buffer.concat([Buffer.of(5), be64(n)]),
  string: s => Buffer.concat([Buffer.of(6), str(s)]),
  hash: h => Buffer.concat([Buffer.of(7), Buffer.from(h, 'hex')]),
  publicKey: k => Buffer.concat([Buffer.of(10), Buffer.from(k, 'hex')]),
  list: items => Buffer.concat([Buffer.of(13), varint(items.length), ...items]),
};
const dict = o => { const ks = Object.keys(o).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };

// keys: the engine families' example keys (public, test only)
const O = '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb';   // the oracle
const B = '03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc';   // a bettor
const pkHash = k => sha3(k);
const ORACLE = sha3(Buffer.from('a test V1 oracle contract'));      // the Oracle contract's hash (version 1)
const TOKEN = sha3(Buffer.from('a test token for FixedPayout'));    // stands for zUSDC: a version 1 contract's default token
const CLOSE = 1791900000000;                                        // a whole hour, as the oracle stamps its slots
const HOUR = 3600000;
const PRICE = 110000000, N = 10_000_000;                            // the line 110,000 (x 1000); 10 zUSDC (6 decimals)
const market = (o = {}) => ({ OraclePubKey: D.publicKey(O), OracleContractId: D.string('00000001' + ORACLE), Ticker: D.string('BTC'),
  Price: D.u64(PRICE), Start: D.u64(CLOSE), Expiry: D.u64(CLOSE), Collateral: D.string('00000001' + TOKEN), ...o });

// the oracle's close round: one leaf, so root = leaf and the path is empty
const leafOf = (t, v) => sha3(Buffer.from(t, 'utf8'), be64(v));
const roundAt = (value, ts = CLOSE) => { const root = leafOf('BTC', value); return { root, ts, value, att: sha3(sha3(sha3(root, be64(ts)), O)) }; };
const up = roundAt(111000000), down = roundAt(109000000);           // 111,000 (Bull wins) and 109,000 (Bear wins)
const settleBody = (r, position) => dict({ ...market(), Position: D.string(position), Root: D.hash(r.root), Timestamp: D.u64(r.ts),
  Value: D.u64(r.value), Index: D.u64(0), AuditPath: D.list([]) });
const attIn = r => ({ asset: `${ORACLE}:${r.att}`, amount: '1' });  // the round's attestation token in the contract's wallet

async function job(path, body) {
  const r = await fetch(`${ENGINE}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 202) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  for (let i = 0; i < 300; i++) {
    await sleep(i < 5 ? 1000 : 2000);
    const s = await (await fetch(`${ENGINE}/job/${j.job}`)).json();
    if (s.status === 'done') return s;
    if (s.status === 'failed' || s.status === 'timeout') throw new Error(`${path}: ${s.status} ${s.error || ''}`);
  }
  throw new Error(`${path}: no answer in 10 minutes`);
}
let failures = 0;
const costs = {};
const ok = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n      ' + detail}`); if (!cond) failures++; };
const out = (r, kind, hash, pred) => (r.outputs || []).find(o => o.who?.kind === kind && (hash === null || o.who.hash === hash) && pred(o));
const mine = a => typeof a === 'string' && a.toLowerCase().startsWith(contractHash + ':');
const isToken = a => typeof a === 'string' && a.toLowerCase().includes(TOKEN);
async function call(name, c, expect) {
  const s = await job('try', { sourceId: contractHash, call: { context: { blockNumber: 3000, timestamp: String(CLOSE + HOUR) }, wallet: [], ...c } });
  if (!s.try) { ok(name, false, 'no try in the answer: ' + JSON.stringify(s).slice(0, 400)); return null; }
  const r = s.try.result;
  costs[name] = `declared ${r.declaredCost}, used ${r.gasUsed}`;
  if (expect.error) ok(`${name}: refused with "${expect.error}"`, r.ok === false && r.error === expect.error, `got ok=${r.ok} error=${JSON.stringify(r.error)}`);
  else ok(`${name}: succeeds`, r.ok === true, `error: ${JSON.stringify(r.error)}`);
  if (r.ok) ok(`${name}: gas used within the declared`, Number(r.gasUsed) <= Number(r.declaredCost), costs[name]);
  if (r.ok && expect.check) for (const [what, f] of expect.check) ok(`${name}: ${what}`, !!f(r), JSON.stringify(r.outputs).slice(0, 700));
  return s.try;
}
const ctx = ms => ({ context: { blockNumber: 3000, timestamp: String(ms) } });

// 1. a node's verdict
console.log(`engine ${ENGINE}\ncontract FixedPayout.fst: ${Buffer.byteLength(source)} bytes, id 00000001${contractHash}`);
const chk = (await job('check', { source })).check || {};
ok('check: a node would accept it', chk.verdict === 'accepted', `verdict ${chk.verdict}; refusal ${JSON.stringify(chk.refusal)}; node: ${chk.nodeMessage}`);
if (chk.verdict !== 'accepted') process.exit(1);

// 2. Issue: 10 zUSDC -> 10 Bull + 10 Bear to the bettor
const issued = await call('Issue 10', { command: 'Issue', sender: { publicKey: B }, spend: [{ asset: TOKEN, amount: String(N) }], bodyHex: dict(market()) }, {
  check: [['two position tokens, 10 each, to the bettor', r => (r.outputs || []).filter(o => o.who?.kind === 'pk' && o.who.hash === pkHash(B) && mine(o.asset) && String(o.amount) === String(N)).length === 2],
          ['the 10 zUSDC are kept by the contract', r => out(r, 'contract', contractHash, o => isToken(o.asset) && String(o.amount) === String(N))]] });
const positions = (issued?.result?.outputs || []).filter(o => o.who?.kind === 'pk' && mine(o.asset)).map(o => o.asset);
const [BULL, BEAR] = positions;                                     // Issue locks Bull first, then Bear
const w1 = issued?.next?.wallet || [];
await call('Issue, anonymous', { command: 'Issue', spend: [{ asset: TOKEN, amount: String(N) }], bodyHex: dict(market()) }, { error: "Sender can't be anonymous" });
await call('Issue, Start and Expiry differ', { command: 'Issue', sender: { publicKey: B }, spend: [{ asset: TOKEN, amount: String(N) }], bodyHex: dict(market({ Expiry: D.u64(CLOSE + HOUR) })) },
  { error: 'Could not parse the market (OraclePubKey, OracleContractId, Ticker up to 4 characters, Price, Start = Expiry, Collateral)' });
await call('Issue, no collateral', { command: 'Issue', sender: { publicKey: B }, bodyHex: dict(market()) }, { error: 'No collateral provided' });

// 3. Settle (anyone), with the round's attestation in the contract's wallet
const settled = await call('Settle: Bull wins at 111,000', { command: 'Settle', wallet: [...w1, attIn(up)], bodyHex: settleBody(up, 'Bull') }, {
  check: [['a marker kept by the contract', r => out(r, 'contract', contractHash, o => mine(o.asset) && String(o.amount) === '1')]] });
const w2 = settled?.next?.wallet || [];
await call('Settle, no attestation in the wallet', { command: 'Settle', wallet: w1, bodyHex: settleBody(up, 'Bull') },
  { error: "No attestation of this round in the contract: run the Oracle's Attest to this contract first" });
const refusedSettle = 'Settle refused: not the close round, a wrong proof or side, already settled or void, or more than 24 hours after the close';
await call('Settle the losing side', { command: 'Settle', wallet: [...w1, attIn(up)], bodyHex: settleBody(up, 'Bear') }, { error: refusedSettle });
await call('Settle twice', { command: 'Settle', wallet: w2, bodyHex: settleBody(up, 'Bull') }, { error: refusedSettle });
const early = roundAt(111000000, CLOSE - HOUR);
await call('Settle with a round that is not the close', { command: 'Settle', wallet: [...w1, attIn(early)], bodyHex: settleBody(early, 'Bull') }, { error: refusedSettle });
await call('Settle with a wrong value (the proof fails)', { command: 'Settle', wallet: [...w1, attIn(up)], bodyHex: dict({ ...market(), Position: D.string('Bull'), Root: D.hash(up.root), Timestamp: D.u64(CLOSE), Value: D.u64(112000000), Index: D.u64(0), AuditPath: D.list([]) }) }, { error: refusedSettle });
await call('Settle 25 hours after the close', { command: 'Settle', wallet: [...w1, attIn(up)], bodyHex: settleBody(up, 'Bull'), ...ctx(CLOSE + 25 * HOUR) }, { error: refusedSettle });
await call('Settle: Bear wins at 109,000', { command: 'Settle', wallet: [...w1, attIn(down)], bodyHex: settleBody(down, 'Bear') }, {});

// 4. Redeem after the Settle: the winner 1 per token, the loser nothing
await call('Redeem 10 Bull (won)', { command: 'Redeem', sender: { publicKey: B }, wallet: w2, spend: [{ asset: BULL, amount: String(N) }], bodyHex: dict({ ...market(), Position: D.string('Bull') }) }, {
  check: [['10 zUSDC to the bettor', r => out(r, 'pk', pkHash(B), o => isToken(o.asset) && String(o.amount) === String(N))],
          ['the Bull tokens destroyed', r => out(r, 'destroy', null, o => o.asset === BULL)]] });
const notPaid = 'Not paid: this side did not win, or the market is not settled or void yet';
await call('Redeem 10 Bear (lost)', { command: 'Redeem', sender: { publicKey: B }, wallet: w2, spend: [{ asset: BEAR, amount: String(N) }], bodyHex: dict({ ...market(), Position: D.string('Bear') }) }, { error: notPaid });
await call('Redeem before any Settle or Void', { command: 'Redeem', sender: { publicKey: B }, wallet: w1, spend: [{ asset: BULL, amount: String(N) }], bodyHex: dict({ ...market(), Position: D.string('Bull') }) }, { error: notPaid });

// 5. Void: no Settle within 24 hours; then every token pays half
const voidRefused = 'Void refused: the market is settled or void, or 24 hours have not passed since the close';
await call('Void 23 hours after the close', { command: 'Void', wallet: w1, bodyHex: dict(market()), ...ctx(CLOSE + 23 * HOUR) }, { error: voidRefused });
await call('Void after a Settle', { command: 'Void', wallet: w2, bodyHex: dict(market()), ...ctx(CLOSE + 25 * HOUR) }, { error: voidRefused });
const voided = await call('Void 25 hours after the close', { command: 'Void', wallet: w1, bodyHex: dict(market()), ...ctx(CLOSE + 25 * HOUR) }, {
  check: [['a marker kept by the contract', r => out(r, 'contract', contractHash, o => mine(o.asset) && String(o.amount) === '1')]] });
const w3 = voided?.next?.wallet || [];
await call('Redeem 10 Bear after the Void', { command: 'Redeem', sender: { publicKey: B }, wallet: w3, spend: [{ asset: BEAR, amount: String(N) }], bodyHex: dict({ ...market(), Position: D.string('Bear') }), ...ctx(CLOSE + 26 * HOUR) }, {
  check: [['5 zUSDC (half) to the bettor', r => out(r, 'pk', pkHash(B), o => isToken(o.asset) && String(o.amount) === String(N / 2))]] });
await call('Settle after the Void', { command: 'Settle', wallet: [...w3, attIn(up)], bodyHex: settleBody(up, 'Bull') }, { error: refusedSettle });

// 6. Cancel: equal Bull and Bear back for the collateral
await call('Cancel 10 + 10', { command: 'Cancel', sender: { publicKey: B }, wallet: w1, spend: [{ asset: BULL, amount: String(N) }, { asset: BEAR, amount: String(N) }], bodyHex: dict(market()) }, {
  check: [['10 zUSDC to the bettor', r => out(r, 'pk', pkHash(B), o => isToken(o.asset) && String(o.amount) === String(N))]] });
await call('Cancel 10 + 5', { command: 'Cancel', sender: { publicKey: B }, wallet: w1, spend: [{ asset: BULL, amount: String(N) }, { asset: BEAR, amount: String(N / 2) }], bodyHex: dict(market()) },
  { error: 'There must be an equal amount of both bull and bear tokens in the transaction' });
await call('Unknown command', { command: 'Bet', sender: { publicKey: B }, bodyHex: dict(market()) }, { error: 'Unsupported command' });

console.log(`\ncontract id 00000001${contractHash}\npositions: Bull ${BULL}\n           Bear ${BEAR}\ncosts:`);
for (const [n, g] of Object.entries(costs)) console.log(`  ${n}: ${g}`);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

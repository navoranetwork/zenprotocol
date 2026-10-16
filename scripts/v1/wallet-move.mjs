// Moving the testnet off the public wallet phrase (docs/WALLET-MIGRATION.md): the snapshot of the old zUSDC and the
// position tokens, the issue plan with its asserts (site/wallet-move-core.mjs), and the issue of the new zUSDC.
// Runs in the zen-tools image (node 22 with sqlite, the body tool), with the index database mounted:
//   docker run --rm --network host --env-file testnet-stack.env -v "$PWD:/r" -v zenprotocol-testnet_stack-data:/data:ro \
//     -e NEW_PHRASE_FILE=/r/.new-phrase -e SURPLUS=<units> -e OUT=/r/wallet-move zen-tools \
//     node --no-warnings --experimental-sqlite /r/scripts/v1/wallet-move.mjs snapshot
//   … -e NEW_CONTRACT=<ctzn1… of the new zUSDC> [-e DRY=1] … wallet-move.mjs issue
// The new phrase is read from NEW_PHRASE_FILE and never printed.
//
// Environment: NODE (http://127.0.0.1:31567)  EXPLORER (http://127.0.0.1:11581/explorer/api)  BETS (http://127.0.0.1:8097)
//   BRIDGE (http://127.0.0.1:8090)  DB (/data/index.sqlite)  OLD_ASSET (default BRIDGE_ASSET: the old zUSDC)
//   DEX_ADDRESS, BETS_CONTRACT (from testnet-stack.env)  SURPLUS (reserve surplus to issue, units; required, may be 0)
//   OUT (./wallet-move)  PASSWORD (TESTNET_PASSWORD or testnet)  ZO (dotnet /app/zen-oracle.dll)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPlan, isContract } from '../../site/wallet-move-core.mjs';
import { accountFromMnemonic, deriveKey, encodeAddress, pkHash, decodeAddress } from '../../wallet/src/keys.js';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('NODE', 'http://127.0.0.1:31567'), EXPLORER = env('EXPLORER', 'http://127.0.0.1:11581/explorer/api');
const BETS = env('BETS', 'http://127.0.0.1:8097'), BRIDGE = env('BRIDGE', 'http://127.0.0.1:8090');
const OUT = env('OUT', './wallet-move'), PW = env('PASSWORD', env('TESTNET_PASSWORD', 'testnet'));
const OLD = env('OLD_ASSET', env('BRIDGE_ASSET', '')), DEXA = env('DEX_ADDRESS', ''), FPA = env('BETS_CONTRACT', '');
const ZO = env('ZO', 'dotnet /app/zen-oracle.dll').split(' ');
const get = async p => { const r = await fetch(p); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const post = async (p, b) => { const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const die = m => { console.error(m); process.exit(1); };
fs.mkdirSync(OUT, { recursive: true });
const write = (f, v) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x, 1));

// the public phrases (site/known-wallets.mjs lists their 0/0 keys) and the paths we check
const PUBLIC = ['abandon '.repeat(23) + 'art', 'abandon '.repeat(11) + 'about', 'test '.repeat(11) + 'junk', 'zoo '.repeat(11) + 'wrong',
  'legal winner thank year wave sausage worth useful legal winner thank yellow'];
const PATHS = [...[0, 1, 2].flatMap(b => Array.from({ length: 50 }, (_, i) => [b, i])), ...Array.from({ length: 10 }, (_, i) => [3, i])];
const addressesOf = phrase => { const a = accountFromMnemonic(phrase); return new Map(PATHS.map(([b, i]) => [`${b}/${i}`, encodeAddress(deriveKey(a, b, i).pkHash, 'test')])); };
const newPhrase = () => {
  const f = env('NEW_PHRASE_FILE', ''); if (!f) die('NEW_PHRASE_FILE is required (a file with the new phrase; never printed)');
  const p = fs.readFileSync(f, 'utf8').trim(); if (PUBLIC.includes(p)) die('the new phrase is a public phrase: refused');
  return p;
};

async function snapshot() {
  if (!OLD || !DEXA || !FPA) die('OLD_ASSET (or BRIDGE_ASSET), DEX_ADDRESS and BETS_CONTRACT are required');
  if (env('SURPLUS', '') === '') die('SURPLUS is required: the reserve surplus to issue, in units (USDC held minus zUSDC out), or 0');
  const status = await get(BRIDGE + '/status');
  console.log(`bridge: zUSDC out ${status.zusdcOutstanding}, reserves ${JSON.stringify(status.reserves)}, asset ${status.asset}`);
  if (status.asset !== OLD) die(`the bridge's asset ${status.asset} is not OLD_ASSET ${OLD}`);
  // quiet: nothing in the mempool calls the old zUSDC, FixedPayout or the Dex
  const busy = [];
  for (const e of (await get(NODE + '/blockchain/mempool')) || []) for (const [h, tx] of Object.entries(e))
    for (const w of tx.witness || []) { const c = w.ContractWitness?.contractId; if (c && [OLD.slice(0, 72), FPA, DEXA].some(x => x && (x === c || x === encodeAddress(Uint8Array.from(Buffer.from(c, 'hex')), 'test', true)))) busy.push(h); }
  if (busy.length) die(`the mempool has ${busy.length} call(s) to zUSDC, FixedPayout or the Dex: wait until it is empty (${busy.slice(0, 3).join(', ')})`);
  const svc = await get(BETS + '/markets');
  const markets = svc.markets.filter(m => m.event.Collateral === OLD).map(m => ({ bull: m.bull, bear: m.bear, status: m.status, result: m.result, ticker: m.ticker, line: m.line, close: m.close }));
  const assets = [OLD, ...markets.flatMap(m => [m.bull, m.bear])];
  // holders: from the index's unspent outputs, then their balances live from the node (the index trails the tip)
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(env('DB', '/data/index.sqlite'), { readOnly: true });
  const ph = assets.map(() => '?').join(',');
  const holders = new Set(db.prepare(`SELECT DISTINCT address FROM utxo WHERE asset IN (${ph})`).all(...assets).map(r => r.address));
  holders.add(DEXA); holders.add(FPA);
  const balances = [];
  const list = [...holders];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    for (const address of chunk) for (const b of (await post(NODE + '/addressdb/balance', { addresses: [address] })) || [])
      if (assets.includes(b.asset) && Number(b.balance) > 0) balances.push({ address, asset: b.asset, amount: String(b.balance) });
  }
  // open Dex orders, by the maker's address
  const ord = await get(EXPLORER + '/dex/orders');
  const orders = (ord.orders || []).filter(o => !o.pending && assets.includes(o.under_asset))
    .map(o => ({ maker: encodeAddress(pkHash(Buffer.from(o.maker, 'hex')), 'test'), under_asset: o.under_asset, under_amount: o.under_amount, tx: o.tx }));
  // old zUSDC still at the old bridge address: each coin with the input addresses of the transaction that brought it
  const oldAddrs = addressesOf(PUBLIC[0]), bridgeOld = oldAddrs.get('0/0');
  const bridgeCoins = db.prepare('SELECT outpoint, amount FROM utxo WHERE address = ? AND asset = ?').all(bridgeOld, OLD).map(r => {
    const t = db.prepare('SELECT inputs FROM txs WHERE hash = ?').get(r.outpoint.split(':')[0]);
    return { outpoint: r.outpoint, amount: r.amount, inputs: t ? JSON.parse(t.inputs).map(i => i[0]) : [] };
  });
  const np = addressesOf(newPhrase());
  const ownOld = new Map([...oldAddrs].map(([p, a]) => [a, p === '2/0' ? np.get('2/0') : np.get('2/1')]));
  const known = new Set(PUBLIC.flatMap(p => [...addressesOf(p).values()]));
  const input = { oldAsset: OLD, supply: status.zusdcOutstanding, balances, orders, markets, dex: DEXA, bridgeOld, bridgeNew: np.get('0/0'),
    betsNew: np.get('2/1'), bridgeCoins, ownOld, oldWallet: new Set(oldAddrs.values()), known, surplus: env('SURPLUS') };
  const r = buildPlan(input);
  write('snapshot.json', { at: new Date().toISOString(), tip: (await get(NODE + '/blockchain/info')).blocks, indexedTo: ord.indexedTo, oldAsset: OLD,
    supply: status.zusdcOutstanding, reserves: status.reserves, markets, balances, orders, bridgeCoins, manual: r.manual, totals: r.totals });
  write('issue-plan.json', { ok: r.ok, problems: r.problems, totals: r.totals, plan: r.plan, manual: r.manual });
  console.log(`markets ${markets.length}, holders ${holders.size}, balances ${balances.length}, orders ${orders.length}, coins at the old bridge ${bridgeCoins.length}`);
  console.log('totals', JSON.stringify(r.totals));
  for (const p of r.plan) console.log(`  ${p.address}  ${(Number(p.amount) / 1e6).toFixed(6)}  ${JSON.stringify(p.parts)}`);
  for (const m of r.manual) console.log(`  MANUAL ${m.amount} ${m.outpoint} inputs ${JSON.stringify(m.inputs)}`);
  if (!r.ok) { for (const p of r.problems) console.log('PROBLEM', p); die('the plan failed its asserts: nothing will be issued'); }
  console.log(`plan ok: ${r.plan.length} issues, in ${OUT}/issue-plan.json`);
}

async function issue() {
  const NEW = env('NEW_CONTRACT', ''), DRY = env('DRY', '') === '1';
  if (!NEW) die('NEW_CONTRACT (the new zUSDC contract address) is required');
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, 'issue-plan.json'), 'utf8'));
  if (!plan.ok) die('issue-plan.json is not ok: run snapshot again');
  const known = new Set(PUBLIC.flatMap(p => [...addressesOf(p).values()]));
  for (const p of plan.plan) if (known.has(p.address) || isContract(p.address)) die(`refused: ${p.address} is a public-phrase or contract address`);
  const doneFile = path.join(OUT, 'issued.json');
  const done = fs.existsSync(doneFile) ? JSON.parse(fs.readFileSync(doneFile, 'utf8')) : {};
  for (const p of plan.plan) {
    if (done[p.address]) { console.log(`skip ${p.address}: issued ${done[p.address].tx}`); continue; }
    const body = execFileSync(ZO[0], [...ZO.slice(1), 'body', `Amount:u=${p.amount}`, `returnAddress:p=${Buffer.from(decodeAddress(p.address).hash).toString('hex')}`], { encoding: 'utf8' }).trim();
    if (DRY) { console.log(`DRY issue ${p.amount} -> ${p.address}`); continue; }
    const r = await post(NODE + '/wallet/contract/execute', { address: NEW, command: 'Issue', messageBody: body, options: { returnAddress: false, sign: "m/44'/258'/0'/3/0" }, spends: [], password: PW });
    const tx = typeof r === 'string' ? r.replace(/"/g, '').trim() : '';
    if (!/^[0-9a-f]{64}$/.test(tx)) die(`issue to ${p.address} failed: ${JSON.stringify(r).slice(0, 300)}`);
    done[p.address] = { amount: p.amount, tx, at: new Date().toISOString() }; fs.writeFileSync(doneFile, JSON.stringify(done, null, 1));
    console.log(`issued ${(Number(p.amount) / 1e6).toFixed(6)} -> ${p.address}: ${tx}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('done');
}

const mode = process.argv[2];
if (mode === 'snapshot') await snapshot(); else if (mode === 'issue') await issue(); else die('usage: wallet-move.mjs snapshot | issue');

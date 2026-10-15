// USDC bridge prototype (testnet only, custodial): USDC on an EVM chain <-> zUSDC on ZP.
//   deposit:   USDC sent to the bridge's EVM address by a linked EVM address -> zUSDC issued (AuthenticatedSupply Issue) to its ZP address
//   withdraw:  a linked ZP address sends zUSDC to the bridge's ZP address -> after BRIDGE_ZP_CONFIRMATIONS blocks the bridge
//              destroys it and sends USDC to the linked EVM address by itself (POST /withdraw {zpTx, evm} remains for a
//              ZP address linked to several EVM addresses, or to claim at once). Transactions are read from the node itself.
// Amounts are in USDC base units (6 decimals) on both sides, 1:1. See docs/BRIDGE.md.
//
// Environment (all optional but the contract):
//   BRIDGE_NODE      ZP node API            (http://127.0.0.1:31567)
//   BRIDGE_CONTRACT  AuthenticatedSupply address (ctzn1...)   BRIDGE_ASSET  its asset id (contract id hex, default asset)
//   BRIDGE_PASSWORD  wallet password (testnet)    BRIDGE_SIGN  sign path (m/44'/258'/0'/3/0)
//   BRIDGE_EVM       rpc URL, or  mock:<file>  (a JSON list of {tx, log, from, to, amount, block} for tests)
//   BRIDGE_USDC      USDC token address on that chain      BRIDGE_EVM_KEY  private key of the bridge's EVM wallet (for withdrawals)
//   BRIDGE_LOG_RANGE (190) blocks per log query (sepolia.base.org allows 200)   BRIDGE_CONFIRMATIONS (12)   BRIDGE_DATA (./data)   BRIDGE_LISTEN (127.0.0.1:8090)   BRIDGE_INTERVAL (15 s)
//   BRIDGE_FUNDERS   comma-separated EVM addresses whose USDC transfers top up the reserves: never treated as deposits, no zUSDC issued
//   BRIDGE_ZO        command that runs zen-oracle (dotnet src/Oracle/bin/Release/zen-oracle.dll)
//   BRIDGE_ZP_CONFIRMATIONS (2) ZP blocks before a withdrawal is paid   BRIDGE_AUTO_WITHDRAW (1) pay withdrawals without a claim
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeAddress } from '../../wallet/src/keys.js';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('BRIDGE_NODE', 'http://127.0.0.1:31567'), CONTRACT = env('BRIDGE_CONTRACT', ''), ASSET = env('BRIDGE_ASSET', '');
const PW = env('BRIDGE_PASSWORD', 'testnet'), SIGN = env('BRIDGE_SIGN', "m/44'/258'/0'/3/0");
const EVM = env('BRIDGE_EVM', 'mock:./data/evm.json'), USDC = env('BRIDGE_USDC', '0x036CbD53842c5426634e7929541eC2318f3dCF7e');   // Base Sepolia test USDC
const CONF = Number(env('BRIDGE_CONFIRMATIONS', '12')), DATA = env('BRIDGE_DATA', './data');
const [HOST, PORT] = env('BRIDGE_LISTEN', '127.0.0.1:8090').split(':');
const ZO = env('BRIDGE_ZO', 'dotnet src/Oracle/bin/Release/zen-oracle.dll').split(' ');
const ZP_CONF = Math.max(1, Number(env('BRIDGE_ZP_CONFIRMATIONS', '2'))), AUTO = env('BRIDGE_AUTO_WITHDRAW', '1') !== '0';
const INTERVAL = Number(env('BRIDGE_INTERVAL', '15')) * 1000;
const FUNDERS = new Set(env('BRIDGE_FUNDERS', '').split(',').map(a => a.trim().toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a)));

fs.mkdirSync(DATA, { recursive: true });
const file = n => path.join(DATA, n);
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const save = (n, v) => { fs.writeFileSync(file(n) + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(file(n) + '.tmp', file(n)); };
let links = load('links.json', {});        // evm address (lower case) -> { zp, since }
let done = load('done.json', {});          // "<evmtx>:<log>" -> { zp tx, amount, asset }   and  "w:<zptx>" -> { evm tx, asset }; status counts only asset === ASSET
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- ZP side ----------------------------------------------------------------------------------
async function zp(pathname, body) {
  const r = await fetch(NODE + pathname, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
const pkHashHex = addr => Buffer.from(decodeAddress(addr).hash).toString('hex');
const body = specs => execFileSync(ZO[0], [...ZO.slice(1), 'body', ...specs], { encoding: 'utf8' }).trim();
async function execute(command, specs, spends) {
  const r = await zp('/wallet/contract/execute', { address: CONTRACT, command, messageBody: body(specs), options: { sign: SIGN, returnAddress: false }, spends, password: PW });
  if (typeof r !== 'string' || !/^"?[0-9a-f]{64}"?$/.test(r.trim())) throw new Error('execute ' + command + ': ' + JSON.stringify(r).slice(0, 200));
  return r.replace(/"/g, '').trim();
}
const issue = (zpAddr, amount) => execute('Issue', [`Amount:u=${amount}`, `returnAddress:p=${pkHashHex(zpAddr)}`], []);
const destroy = amount => execute('Destroy', [`Amount:u=${amount}`], [{ asset: ASSET, amount: Number(amount) }]);

// ---- EVM side ---------------------------------------------------------------------------------
let ethers = null, provider = null, wallet = null;
async function evmInit() {
  if (EVM.startsWith('mock:')) return;
  ethers = await import('ethers');
  provider = new ethers.JsonRpcProvider(EVM);
  if (process.env.BRIDGE_EVM_KEY) wallet = new ethers.Wallet(process.env.BRIDGE_EVM_KEY, provider);
}
const bridgeEvm = () => wallet ? wallet.address.toLowerCase() : env('BRIDGE_EVM_ADDRESS', '').toLowerCase();
// USDC the bridge holds on the EVM chain (its reserves), cached for 30 s so /status stays cheap; null when unknown or mocked
let reservesCache = { at: 0, value: null }, chainId = null;
async function evmReserves() {
  if (EVM.startsWith('mock:') || !bridgeEvm()) return null;
  if (Date.now() - reservesCache.at < 30000) return reservesCache.value;
  try {
    if (chainId === null) chainId = Number((await provider.getNetwork()).chainId);
    const usdc = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
    reservesCache = { at: Date.now(), value: String(await usdc.balanceOf(bridgeEvm())) };
  } catch (e) { log('reserves read failed:', e.message); reservesCache = { at: Date.now(), value: null }; }
  return reservesCache.value;
}
let bridgeZpCache = '';
async function bridgeZp() {
  if (!bridgeZpCache) { try { const a = String(await zp('/wallet/address')).replace(/"/g, '').trim(); if (/^t?zn1[0-9a-z]+$/.test(a)) bridgeZpCache = a; } catch { } }
  return bridgeZpCache;
}
// USDC transfers to the bridge: [{tx, log, from, amount, block}] with block <= tip - confirmations
async function evmDeposits() {
  if (EVM.startsWith('mock:')) {
    const f = EVM.slice(5); if (!fs.existsSync(f)) return [];
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    return list.map(d => ({ tx: d.tx, log: d.log ?? 0, from: d.from.toLowerCase(), amount: String(d.amount), block: d.block ?? 0 }));
  }
  const tip = await provider.getBlockNumber(), from = Number(load('evm-cursor.json', { block: Math.max(0, tip - 5000) }).block);
  const to = tip - CONF; if (to < from) return [];
  const usdc = new ethers.Contract(USDC, ['event Transfer(address indexed from, address indexed to, uint256 value)'], provider);
  const out = [];
  const RANGE = Number(env('BRIDGE_LOG_RANGE', '190'));   // public rpc nodes limit eth_getLogs (sepolia.base.org: 200 blocks since 2026-10)
  for (let a = from; a <= to; a += RANGE) {
    const evs = await usdc.queryFilter(usdc.filters.Transfer(null, bridgeEvm()), a, Math.min(to, a + RANGE - 1));
    for (const e of evs) out.push({ tx: e.transactionHash, log: e.index, from: e.args.from.toLowerCase(), amount: String(e.args.value), block: e.blockNumber });
  }
  save('evm-cursor.json', { block: to + 1 });
  return out;
}
async function evmSend(to, amount) {
  if (EVM.startsWith('mock:')) return 'mock-withdrawal-' + Date.now();
  const usdc = new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)'], wallet);
  const tx = await usdc.transfer(to, BigInt(amount)); await tx.wait(CONF > 1 ? 1 : 1); return tx.hash;
}

// ---- live events (GET /events, server-sent events): the page refreshes when something changes -----------------
const clients = new Set();
function notify(kind, extra = {}) {
  const msg = `event: change\ndata: ${JSON.stringify({ kind, at: Date.now(), ...extra })}\n\n`;
  for (const r of clients) { try { r.write(msg); } catch { clients.delete(r); } }
}
setInterval(() => { for (const r of clients) { try { r.write(': ping\n\n'); } catch { clients.delete(r); } } }, 25000).unref();

// ---- loops ------------------------------------------------------------------------------------
let pendingDeposits = load('pending.json', []);   // deposits seen from addresses that had no link yet
async function depositsRound() {
  const seen = await evmDeposits();
  const all = [...pendingDeposits, ...seen], keep = [], keys = new Set();
  for (const d of all) {
    const key = d.tx + ':' + d.log;
    if (keys.has(key) || done[key]) continue; keys.add(key);
    if (FUNDERS.has(d.from)) { log('reserve top-up', d.amount, 'from', d.from, d.tx); notify('reserves'); continue; }   // funds the reserves, issues nothing
    const link = links[d.from];
    if (!link) { keep.push(d); if (!pendingDeposits.some(p => p.tx === d.tx && p.log === d.log)) notify('waiting', { evm: d.from }); continue; }       // wait until the sender links a ZP address
    try {
      const tx = await issue(link.zp, d.amount);
      done[key] = { zpTx: tx, amount: d.amount, zp: link.zp, from: d.from, asset: ASSET }; save('done.json', done);
      log('deposit', d.amount, 'from', d.from, '-> issued to', link.zp, tx);
      notify('deposit', { evm: d.from });
    } catch (e) { log('deposit failed', key, e.message); keep.push(d); }
  }
  pendingDeposits = keep; save('pending.json', keep);
}

// a withdrawal: the user's transaction pays zUSDC to the bridge's ZP address; the sender must be a linked ZP address.
// Read from the node (GET /blockchain/transaction, with its confirmations), not from the explorer's index, which stays
// 10 blocks behind the tip on purpose.
async function nodeTx(hash) {
  const r = await fetch(NODE + '/blockchain/transaction?hash=' + hash, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && j.tx && Array.isArray(j.tx.outputs) ? j : null;
}
const lockAddr = l => (l && typeof l === 'object' && (l.PK || l.Coinbase)?.address) || null;
async function readPayment(zpTx) {
  const j = await nodeTx(zpTx); if (!j) return null;
  const me = await bridgeZp();
  const paid = j.tx.outputs.filter(o => lockAddr(o.lock) === me && o.spend?.asset === ASSET).reduce((s, o) => s + BigInt(o.spend.amount), 0n);
  const senders = new Set();
  for (const i of j.tx.inputs || []) {
    if (!i.outpoint) continue;
    const prev = await nodeTx(i.outpoint.txHash), a = prev && lockAddr(prev.tx.outputs[i.outpoint.index]?.lock);
    if (a) senders.add(a);
  }
  return { paid, senders, confirmations: Number(j.confirmations) || 0 };
}
const linkedTo = senders => Object.entries(links).filter(([, l]) => senders.has(l.zp)).sort((a, b) => (b[1].since || 0) - (a[1].since || 0));
const busy = new Set();   // one payout per transaction at a time (the claim and the automatic round may meet)
async function withdraw(zpTx, evmTo) {
  const key = 'w:' + zpTx;
  if (done[key]) return done[key];
  const p = await readPayment(zpTx);
  if (!p) throw new Error('transaction not found: it is not on the ZP testnet yet (or the id is wrong)');
  if (p.paid <= 0n) throw new Error('the transaction pays no zUSDC to the bridge address');
  const link = links[evmTo.toLowerCase()];      // one ZP address may be linked to several EVM addresses: check the one asked for
  if (!link || !p.senders.has(link.zp)) throw new Error('the paying ZP address is not linked to that EVM address');
  if (p.confirmations < ZP_CONF) throw new Error(`waiting for ZP blocks: ${p.confirmations} of ${ZP_CONF} confirmations`);
  if (busy.has(key)) throw new Error('being paid now');
  busy.add(key);
  try {
    if (done[key]) return done[key];
    const burn = await destroy(p.paid);
    const out = await evmSend(evmTo, p.paid);
    done[key] = { evmTx: out, burn, amount: String(p.paid), to: evmTo.toLowerCase(), asset: ASSET, at: Date.now() }; save('done.json', done);
    log('withdrawal', String(p.paid), '->', evmTo, out);
    notify('withdrawal', { evm: evmTo.toLowerCase() });
    return done[key];
  } finally { busy.delete(key); }
}
// zUSDC arriving at the bridge's ZP address from a linked address is paid out without a claim; the latest link of
// that ZP address receives it. Arrivals still short of ZP_CONF blocks are listed for /lookup.
let arriving = [];   // [{ zpTx, amount, confirmations, evm }]
const failedAt = {};
async function withdrawalsRound() {
  const me = await bridgeZp(); if (!me) return;
  const rows = await zp('/addressdb/transactions', { addresses: [me], skip: 0, take: 50 });
  if (!Array.isArray(rows)) return;
  const next = [];
  for (const r of rows) {
    if (r.asset !== ASSET || !(BigInt(r.amount) > 0n) || done['w:' + r.txHash]) continue;
    if (failedAt[r.txHash] && Date.now() - failedAt[r.txHash] < 5 * 60000) continue;
    let p; try { p = await readPayment(r.txHash); } catch { continue; }
    if (!p || p.paid <= 0n) continue;
    const [evm] = linkedTo(p.senders)[0] || [];
    if (!evm) continue;                                   // not from a linked address (a contract, the bridge itself, or unlinked): needs no payout
    if (p.confirmations < ZP_CONF || !AUTO) { next.push({ zpTx: r.txHash, amount: String(p.paid), confirmations: p.confirmations, evm }); if (!arriving.some(a => a.zpTx === r.txHash)) notify('arriving', { evm }); continue; }
    try { await withdraw(r.txHash, evm); } catch (e) { failedAt[r.txHash] = Date.now(); log('withdrawal failed', r.txHash, e.message); }
  }
  arriving = next;
}

// ---- API ----------------------------------------------------------------------------------------
// POST /link      {evm, zp, message, signature}  message = "Link <evm> to <zp>" signed with the EVM key (EIP-191)
// POST /withdraw  {zpTx, evm}
// GET  /status    reserves (USDC held), zUSDC outstanding, counts, the bridge's addresses on both chains
// GET  /lookup?evm=0x…   one EVM address: its linked ZP address, its deposits (issued and waiting) and its withdrawals
// GET  /events    server-sent events: `change` {kind: deposit | waiting | arriving | withdrawal | link | reserves, evm?} when it happens
const json = (res, code, v) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 8192) no(new Error('too large')); }); req.on('end', () => ok(b)); });
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/events') {
      if (clients.size >= 500) return json(res, 503, { error: 'too many listeners' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n\n'); clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/status') {
      // only this token: entries of an earlier zUSDC contract (no `asset`, or another one) are history, not outstanding
      const cur = Object.values(done).filter(d => d.asset === ASSET);
      const outstanding = cur.filter(d => d.zpTx).reduce((s, d) => s + BigInt(d.amount), 0n) - cur.filter(d => d.burn).reduce((s, d) => s + BigInt(d.amount), 0n);
      const reserves = await evmReserves();   // first: it also learns chainId
      return json(res, 200, { chain: 'testnet', evm: EVM.startsWith('mock:') ? 'mock' : EVM, chainId, bridgeEvm: bridgeEvm(), bridgeZp: await bridgeZp(), usdc: USDC, contract: CONTRACT, asset: ASSET,
        confirmations: CONF, zpConfirmations: ZP_CONF, autoWithdraw: AUTO, reserves,
        links: Object.keys(links).length, deposits: cur.filter(d => d.zpTx).length, withdrawals: cur.filter(d => d.burn).length,
        zusdcOutstanding: String(outstanding), pendingDeposits: pendingDeposits.length });
    }
    if (req.method === 'GET' && u.pathname === '/lookup') {
      const evm = String(u.searchParams.get('evm') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(evm)) throw new Error('bad address');
      const mine = Object.entries(done);
      return json(res, 200, { evm, zp: links[evm]?.zp || null,
        deposits: mine.filter(([, d]) => d.zpTx && d.from === evm).map(([k, d]) => ({ evmTx: k.split(':')[0], amount: d.amount, zpTx: d.zpTx })),
        waiting: pendingDeposits.filter(d => d.from === evm).map(d => ({ evmTx: d.tx, amount: d.amount })),
        withdrawals: mine.filter(([, d]) => d.burn && String(d.to).toLowerCase() === evm).map(([k, d]) => ({ zpTx: k.slice(2), amount: d.amount, evmTx: d.evmTx })),
        arriving: arriving.filter(a => a.evm === evm).map(a => ({ zpTx: a.zpTx, amount: a.amount, confirmations: a.confirmations, need: ZP_CONF })) });
    }
    if (req.method === 'POST' && u.pathname === '/link') {
      const { evm, zp: z, message, signature } = JSON.parse(await readBody(req));
      if (!/^0x[0-9a-fA-F]{40}$/.test(evm) || !decodeAddress(z).hash) throw new Error('bad address');
      if (message !== `Link ${evm} to ${z}`) throw new Error('message must be "Link <evm> to <zp>"');
      if (!EVM.startsWith('mock:')) { const rec = (await import('ethers')).verifyMessage(message, signature); if (rec.toLowerCase() !== evm.toLowerCase()) throw new Error('signature does not match'); }
      links[evm.toLowerCase()] = { zp: z, since: Date.now() }; save('links.json', links);
      notify('link', { evm: evm.toLowerCase() });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/withdraw') {
      const { zpTx, evm } = JSON.parse(await readBody(req));
      if (!/^[0-9a-f]{64}$/.test(zpTx) || !/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('bad input');
      return json(res, 200, await withdraw(zpTx, evm));
    }
    json(res, 404, { error: 'unknown path' });
  } catch (e) { json(res, 400, { error: String(e.message || e).slice(0, 200) }); }
}).listen(Number(PORT), HOST, () => log('bridge on', HOST + ':' + PORT));

await evmInit();
for (;;) {
  try { await depositsRound(); } catch (e) { log('round failed:', e.message); }
  try { await withdrawalsRound(); } catch (e) { log('withdrawals round failed:', e.message); }
  await new Promise(r => setTimeout(r, INTERVAL));
}

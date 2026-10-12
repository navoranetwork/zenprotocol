#!/usr/bin/env node
// Testnet faucet: sends a fixed amount of test ZP to an address someone enters on /faucet.html.
// It has its own wallet (a phrase made on first start, kept in FAUCET_DATA, never sent anywhere), so it can only give
// away what the operator put into it: the node's own wallet and password are not used. The operator tops it up by
// sending test ZP to the address it prints (also shown on the page). It signs with the ZP Wallet library and publishes
// through the node like any wallet. Limits: one gift per address per day, a few per visitor (IP) per day, and a cap
// per hour. Testnet coins have no value; the limits only keep the faucet available for everyone.
//
//   FAUCET_NODE=http://127.0.0.1:31567 FAUCET_DATA=/data FAUCET_PORT=8095 node site/faucet/faucet.mjs
//   node site/faucet/faucet.mjs selftest        (no node needed)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NodeClient } from '../../wallet/src/node.js';
import { newMnemonic, isValidAddress, decodeAddress } from '../../wallet/src/keys.js';
import { openWallet, readState, receiveAddress, publish } from '../../wallet/src/wallet.js';
import { buildTransaction, parseZP, formatZP, ZP } from '../../wallet/src/tx.js';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('FAUCET_NODE', 'http://127.0.0.1:31567');
const DATA = env('FAUCET_DATA', './faucet-data');
const PORT = Number(env('FAUCET_PORT', 8095));
const AMOUNT = parseZP(env('FAUCET_AMOUNT', '100'));            // ZP per gift
const PER_ADDRESS_HOURS = Number(env('FAUCET_ADDRESS_HOURS', 24));
const PER_IP_DAY = Number(env('FAUCET_IP_PER_DAY', 3));
const PER_HOUR = Number(env('FAUCET_PER_HOUR', 30));
const SPLIT = Number(env('FAUCET_SPLIT', 40));                   // coins of exactly AMOUNT kept ready, so gifts need no change
const NET = 'test';
const say = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// ---- limits (pure, tested by selftest) ---------------------------------------------------------------------------
export function checkLimits(log, now, address, ip) {
  const h = 3600e3;
  if (log.some(e => e.address === address && now - e.time < PER_ADDRESS_HOURS * h))
    return `This address already received test ZP in the last ${PER_ADDRESS_HOURS} hours.`;
  if (ip && log.filter(e => e.ip === ip && now - e.time < 24 * h).length >= PER_IP_DAY)
    return `You reached the limit of ${PER_IP_DAY} requests a day. Try again tomorrow.`;
  if (log.filter(e => now - e.time < h).length >= PER_HOUR)
    return 'The faucet is busy. Try again in an hour.';
  return null;
}
export function checkAddress(a) {
  if (typeof a !== 'string' || a.length > 120) return 'Enter a testnet address (tzn1...).';
  a = a.trim();
  if (a.startsWith('zen1')) return 'That is a mainnet address. The faucet only sends testnet coins: use a testnet address (tzn1...).';
  if (!isValidAddress(a, NET)) {
    try { if (decodeAddress(a).contract) return 'That is a contract address. Enter a wallet address (tzn1...).'; } catch {}
    return 'That is not a valid testnet address (tzn1...).';
  }
  return null;
}

// ---- wallet ------------------------------------------------------------------------------------------------------
function loadWallet() {
  fs.mkdirSync(DATA, { recursive: true });
  const f = path.join(DATA, 'faucet-wallet.json');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify({ mnemonic: newMnemonic(), created: new Date().toISOString() }), { mode: 0o600 });
    say('created the faucet wallet', f);
  }
  const { mnemonic } = JSON.parse(fs.readFileSync(f, 'utf8'));
  return openWallet({ id: 'faucet', name: 'faucet', network: NET, kind: 'mnemonic' }, mnemonic);
}
const opKey = o => Buffer.from(o.txHash).toString('hex') + ':' + o.index;

function main() {
  const node = new NodeClient(NODE, { timeoutMs: 20000 });
  const w = loadWallet(), addr = receiveAddress(w);
  const LOG = path.join(DATA, 'faucet-log.json');
  let log = []; try { log = JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch {}
  const saveLog = () => { log = log.filter(e => Date.now() - e.time < 3 * 24 * 3600e3); fs.writeFileSync(LOG, JSON.stringify(log)); };
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));      // one wallet action at a time: no two transactions pick the same coin
  const pending = new Map();      // outpoints spent by our own transactions that are not in a block yet -> time
  say(`faucet address ${addr}, ${formatZP(AMOUNT)} ZP per gift, node ${NODE}`);

  const spendable = async () => {
    const st = await readState(w, node);
    for (const [k, t] of pending) if (Date.now() - t > 3600e3) pending.delete(k);
    const live = new Set(st.utxos.map(u => opKey(u.outpoint)));
    for (const k of pending.keys()) if (!live.has(k)) pending.delete(k);            // in a block now: gone from the unspent list
    const utxos = st.utxos.filter(u => u.spend.asset === '00' && !pending.has(opKey(u.outpoint)) &&
      (u.lock.type !== 'Coinbase' || st.tip + 1 - u.lock.blockNumber >= 10));
    return { st, utxos };
  };
  const send = (st, utxos, payments) => {
    const key = [...w.keys.values()][0];
    const prepared = buildTransaction({ utxos: utxos.map(u => ({ ...u, spend: { asset: ZP, amount: u.spend.amount }, key })),
      payments, changeLock: { type: 'PK', hash: decodeAddress(addr).hash }, tipBlockNumber: st.tip, maturity: 10 });
    for (const i of prepared.tx.inputs) pending.set(opKey(i.outpoint), Date.now());
    return prepared;
  };
  // keep coins of exactly AMOUNT ready: then gifts in the same block do not wait for each other's change
  const refill = () => serial(async () => {
    const { st, utxos } = await spendable();
    const ready = utxos.filter(u => u.spend.amount === AMOUNT).length;
    const big = utxos.filter(u => u.spend.amount > AMOUNT * 2n).sort((a, b) => (b.spend.amount > a.spend.amount ? 1 : -1))[0];
    if (ready >= SPLIT / 4 || !big) return;
    const n = Math.min(SPLIT, Number(big.spend.amount / AMOUNT) - 1);
    if (n < 2) return;
    const lock = { type: 'PK', hash: decodeAddress(addr).hash };
    const prepared = send(st, [big], Array.from({ length: n }, () => ({ lock, spend: { asset: ZP, amount: AMOUNT } })));
    say(`split ${formatZP(big.spend.amount)} ZP into ${n} coins: ${await publish(node, prepared)}`);
  });

  const give = (to, ip) => serial(async () => {
    const why = checkAddress(to) || checkLimits(log, Date.now(), to.trim(), ip);
    if (why) return { status: 429, body: { error: why } };
    to = to.trim();
    const { st, utxos } = await spendable();
    const exact = utxos.find(u => u.spend.amount === AMOUNT);
    const pool = exact ? [exact] : utxos;
    const total = pool.reduce((s, u) => s + u.spend.amount, 0n);
    if (total < AMOUNT) return { status: 503, body: { error: utxos.length || pending.size ? 'The faucet is waiting for its last gifts to be confirmed. Try again in a few minutes.' : 'The faucet is empty. Please try again later.' } };
    const prepared = send(st, pool, [{ lock: { type: 'PK', hash: decodeAddress(to).hash }, spend: { asset: ZP, amount: AMOUNT } }]);
    const tx = await publish(node, prepared);
    log.push({ address: to, ip, time: Date.now(), tx }); saveLog();
    say(`gave ${formatZP(AMOUNT)} ZP to ${to}: ${tx}`);
    refill().catch(e => say('refill:', e.message));
    return { status: 200, body: { tx, amount: formatZP(AMOUNT), address: to } };
  });
  const status = async () => {
    const { st, utxos } = await spendable();
    const balance = st.utxos.filter(u => u.spend.asset === '00').reduce((s, u) => s + u.spend.amount, 0n);
    const now = Date.now();
    return { address: addr, amount: formatZP(AMOUNT), balance: formatZP(balance), gifts: balance / AMOUNT > 0n ? String(balance / AMOUNT) : '0',
             ready: utxos.length > 0, perAddressHours: PER_ADDRESS_HOURS, perIpDay: PER_IP_DAY, tip: st.tip,
             given24h: log.filter(e => now - e.time < 24 * 3600e3).length };
  };

  http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/faucet/status')
      return status().then(s => reply(200, s), e => reply(502, { error: 'The testnet node did not answer: ' + e.message }));
    if (req.method === 'POST' && url === '/faucet/request') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        let to; try { to = JSON.parse(body).address; } catch { return reply(400, { error: 'Enter a testnet address (tzn1...).' }); }
        give(to, ip).then(r => reply(r.status, r.body), e => { say('error:', e.message); reply(502, { error: 'Could not send: ' + e.message }); });
      });
      return;
    }
    reply(404, { error: 'not found' });
  }).listen(PORT, '127.0.0.1', () => say(`listening on 127.0.0.1:${PORT}`));
  setInterval(() => refill().catch(e => say('refill:', e.message)), 5 * 60e3);
  refill().catch(e => say('refill:', e.message));
}

function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
  const now = Date.now(), a = 'tzn1qav9w7rgjwpw03hm3eayk0du35dkvrvza0km9ytw3m7hdvdnxad3qsu08uq';
  assert(checkAddress(a) === null, 'a testnet address is accepted');
  assert(/mainnet/.test(checkAddress('zen1qav9w7rgjwpw03hm3eayk0du35dkvrvza0km9ytw3m7hdvdnxad3qsu08uq')), 'a mainnet address is refused');
  assert(checkAddress('tzn1qqqq') !== null, 'a broken address is refused');
  assert(checkAddress(5) !== null && checkAddress('x'.repeat(500)) !== null, 'junk is refused');
  assert(checkLimits([], now, a, '1.2.3.4') === null, 'first request passes');
  assert(checkLimits([{ address: a, ip: '9', time: now - 3600e3 }], now, a, '1.2.3.4') !== null, 'same address within a day is refused');
  assert(checkLimits([{ address: a, ip: '9', time: now - 25 * 3600e3 }], now, a, '1.2.3.4') === null, 'same address after a day passes');
  const ipLog = [1, 2, 3].map(i => ({ address: 'x' + i, ip: '1.2.3.4', time: now - i * 60e3 }));
  assert(checkLimits(ipLog, now, a, '1.2.3.4') !== null, `more than ${PER_IP_DAY} a day from one IP is refused`);
  const hourLog = Array.from({ length: PER_HOUR }, (_, i) => ({ address: 'y' + i, ip: 'ip' + i, time: now - 60e3 }));
  assert(checkLimits(hourLog, now, a, 'new') !== null, 'the hourly cap holds');
  console.log('selftest passed');
}

if (process.argv[2] === 'selftest') selftest(); else main();

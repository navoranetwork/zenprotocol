// The V1 zUSDC token on the public testnet (docs/TESTNET-V1-MIGRATION.md, step 2): activates
// contracts/v1/AuthenticatedSupply.fst with the bridge key (the node wallet's key at m/44'/258'/0'/3/0) written into
// authenticatedPubKey, as the V0 install did, and prints the BRIDGE_* lines for testnet-stack.env.
// Run only after scripts/v1/zusdc-try.mjs passed (it tests this exact source) and with no old zUSDC outstanding:
// it refuses while the bridge's /status shows zusdcOutstanding other than 0 (FORCE=1 skips that check).
//
// usage: node scripts/v1/testnet-v1-zusdc.mjs [node api] [wallet password]
//        env: FORK (2050), NUMBLOCKS (20000), BRIDGE (http://127.0.0.1:8090)
// On the testnet server, from a zenprotocol checkout on node-upgrade-script:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/testnet-v1-zusdc.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API = process.argv[2] || 'http://127.0.0.1:31567', PW = process.argv[3] || 'testnet';
const FORK = Number(process.env.FORK || 2050), BLOCKS = Number(process.env.NUMBLOCKS || 20000);
const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8090', SIGN = "m/44'/258'/0'/3/0";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const get = async p => (await fetch(API + p)).json();
const post = async (p, b) => (await (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(900000) })).text()).trim();

const tip = (await get('/blockchain/info')).blocks;
if (tip < FORK) { console.error(`the testnet is at block ${tip}; V1 contracts can be activated from block ${FORK}`); process.exit(1); }
if (process.env.FORCE !== '1') {   // FORCE=1: the old bridge was closed and its zUSDC abandoned (2026-10-14), or it is stopped
  const st = await fetch(BRIDGE + '/status').then(r => r.json()).catch(() => null);
  if (!st) { console.error(`the bridge (${BRIDGE}) does not answer: start it, or FORCE=1 if it is closed on purpose`); process.exit(1); }
  if (st.zusdcOutstanding !== '0') {
    console.error(`the bridge shows ${st.zusdcOutstanding} old zUSDC outstanding: withdraw it first (docs/TESTNET-V1-MIGRATION.md, step 2), or FORCE=1`);
    process.exit(1);
  }
}
const key = (await post('/wallet/publickey', { path: SIGN, password: PW })).replace(/"/g, '');
if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error('wallet/publickey: ' + key.slice(0, 200));
const template = readFileSync(new URL('../../contracts/v1/AuthenticatedSupply.fst', import.meta.url), 'utf8');
const code = template.replace('let authenticatedPubKey = ""', `let authenticatedPubKey = "${key}"`);
if (code === template) throw new Error('the template has no empty authenticatedPubKey');
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const contractId = '00000001' + createHash('sha3-256').update(Buffer.concat([be32(1), Buffer.from(code, 'utf8')])).digest('hex');
const active = async () => (await get('/contract/active')).find(c => c.contractId === contractId);

log(`AuthenticatedSupply.fst with key ${key}: ${Buffer.byteLength(code)} bytes, contract id ${contractId}`);
if (await active()) log('already active: this activation only extends it');
const a = JSON.parse(await post('/wallet/contract/activate', { code, numberOfBlocks: BLOCKS, password: PW, version: 1 }));
if (!a.contractId) throw new Error('activation: ' + JSON.stringify(a).slice(0, 400));
if (a.contractId !== contractId) throw new Error(`the node computed ${a.contractId}, expected ${contractId}`);
log('activation sent, waiting for its block');
for (let i = 0; !(await active()); i++) { if (i > 900) throw new Error('not active after an hour'); await sleep(4000); }
const c = await active();
log(`active: ${c.address}, expires at block ${c.expire ?? '?'}`);
console.log(`\nIn ~/zenprotocol-testnet/testnet-stack.env (replacing the V0 values; MM_ASSET waits for the Dex step):\nBRIDGE_CONTRACT=${c.address}\nBRIDGE_ASSET=${contractId}\nBRIDGE_ID=${contractId}\nBRIDGE_ADDRESS=${c.address}`);

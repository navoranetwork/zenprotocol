// FixedPayout V1 on the public testnet (docs/BETS.md): activates contracts/v1/FixedPayout.fst (no parameters) from the
// node wallet and prints the lines for testnet-stack.env. Run only after scripts/v1/fixedpayout-try.mjs passed, on a
// node image with zp-contracts-v1 dab00f8 or later (Zen.MerkleTree, Zen.Integers).
//
// usage: node scripts/v1/testnet-v1-bets.mjs [node api] [wallet password]     env: FORK (2050), NUMBLOCKS (20000)
// On the testnet server, from a zenprotocol checkout on node-upgrade-script:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/testnet-v1-bets.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API = process.argv[2] || 'http://127.0.0.1:31567', PW = process.argv[3] || 'testnet';
const FORK = Number(process.env.FORK || 2050), BLOCKS = Number(process.env.NUMBLOCKS || 20000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const get = async p => (await fetch(API + p)).json();
const post = async (p, b) => (await (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(900000) })).text()).trim();

const tip = (await get('/blockchain/info')).blocks;
if (tip < FORK) { console.error(`the testnet is at block ${tip}; V1 contracts can be activated from block ${FORK}`); process.exit(1); }
const code = readFileSync(new URL('../../contracts/v1/FixedPayout.fst', import.meta.url), 'utf8');
const be32 = Buffer.alloc(4); be32.writeUInt32BE(1);
const contractId = '00000001' + createHash('sha3-256').update(Buffer.concat([be32, Buffer.from(code, 'utf8')])).digest('hex');
const active = async () => (await get('/contract/active')).find(c => c.contractId === contractId);

log(`FixedPayout.fst: ${Buffer.byteLength(code)} bytes, contract id ${contractId}`);
if (await active()) log('already active: this activation only extends it');
const a = JSON.parse(await post('/wallet/contract/activate', { code, numberOfBlocks: BLOCKS, password: PW, version: 1 }));
if (!a.contractId) throw new Error('activation: ' + JSON.stringify(a).slice(0, 400));
if (a.contractId !== contractId) throw new Error(`the node computed ${a.contractId}, expected ${contractId}`);
log('activation sent, waiting for its block');
for (let i = 0; !(await active()); i++) { if (i > 900) throw new Error('not active after an hour'); await sleep(4000); }
const c = await active();
log(`active: ${c.address}, expires at block ${c.expire ?? '?'}`);
console.log(`\nIn ~/zenprotocol-testnet/testnet-stack.env:\nBETS_CONTRACT=${c.address}\nBETS_ID=${contractId}\n(and BETS_SIGN, BETS_DEX, BETS_ORACLE_ADDRESS, BETS_ORACLE_ID, BETS_ORACLE_KEY, BETS_COLLATERAL: docs/BETS.md)`);

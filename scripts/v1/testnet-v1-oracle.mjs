// The V1 Oracle on the public testnet (docs/TESTNET-V1-MIGRATION.md, step 1).
//
//   activate  activates contracts/v1/Oracle.fst as a version 1 contract from the node wallet and prints the
//             ORACLE_CONTRACT line for testnet-stack.env. Run only after scripts/v1/oracle-try.mjs passed.
//   attest    after the oracle service committed a round to the new contract: sends one Attest of the latest
//             round (signed by the node wallet key m/44'/258'/0'/3/0), so a real attestation is on the chain.
//
// usage: node scripts/v1/testnet-v1-oracle.mjs activate|attest [node api] [wallet password]
//        env: FORK (2050), NUMBLOCKS (20000), ORACLE (http://127.0.0.1:8085), SIGN_PATH (m/44'/258'/0'/3/0)
// Node 18+, no packages. On the testnet server, from the zenprotocol checkout:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/testnet-v1-oracle.mjs activate
// The testnet wallet's password is the public test one ("testnet"); never use this with a real wallet.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MODE = process.argv[2], API = process.argv[3] || 'http://127.0.0.1:31567', PW = process.argv[4] || 'testnet';
const FORK = Number(process.env.FORK || 2050), BLOCKS = Number(process.env.NUMBLOCKS || 20000);
const ORACLE = process.env.ORACLE || 'http://127.0.0.1:8085', SIGN = process.env.SIGN_PATH || "m/44'/258'/0'/3/0";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const get = async p => (await fetch(API + p)).json();
const post = async (p, b) => (await (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(900000) })).text()).trim();
const sha3 = (...parts) => createHash('sha3-256').update(Buffer.concat(parts)).digest('hex');
const source = readFileSync(new URL('../../contracts/v1/Oracle.fst', import.meta.url), 'utf8');
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const contractId = '00000001' + sha3(be32(1), Buffer.from(source, 'utf8'));

function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const dict = o => { const ks = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };

const tip = (await get('/blockchain/info')).blocks;
if (tip < FORK) { console.error(`the testnet is at block ${tip}; V1 contracts can be activated from block ${FORK}`); process.exit(1); }
const active = async () => (await get('/contract/active')).find(c => c.contractId === contractId);

if (MODE === 'activate') {
  log(`Oracle.fst: ${Buffer.byteLength(source)} bytes, contract id ${contractId}`);
  const already = await active();
  if (already) log(`already active (${already.address}); this activation only extends it by ${BLOCKS} blocks`);
  const a = JSON.parse(await post('/wallet/contract/activate', { code: source, numberOfBlocks: BLOCKS, password: PW, version: 1 }));
  if (!a.contractId) throw new Error('activation: ' + JSON.stringify(a).slice(0, 400));
  if (a.contractId !== contractId) throw new Error(`the node computed ${a.contractId}, expected ${contractId}`);
  log(`activation sent, waiting for its block`);
  for (let i = 0; !(await active()); i++) { if (i > 900) throw new Error('not active after an hour'); await sleep(4000); }
  const c = await active();
  log(`active: ${c.address}, expires at block ${c.expire ?? '?'}`);
  console.log(`\nIn ~/zenprotocol-testnet/testnet-stack.env (replacing the V0 values):\nORACLE_CONTRACT=${c.address}\nORACLE_ID=${contractId}\nORACLE_ADDRESS=${c.address}`);
} else if (MODE === 'attest') {
  const c = await active();
  if (!c) throw new Error(`the V1 Oracle ${contractId} is not active`);
  const r = await (await fetch(ORACLE + '/rounds/latest')).json();
  if (!r.tx) throw new Error('the latest round was not sent to a contract: ' + JSON.stringify(r).slice(0, 200));
  const ts = Buffer.alloc(8); ts.writeBigUInt64BE(BigInt(r.timestamp));
  const commit = sha3(Buffer.from(r.root, 'hex'), ts);              // what the service committed: SHA3(root ‖ timestamp)
  const pk = (await post('/wallet/publickey', { path: SIGN, password: PW })).replace(/"/g, '');
  if (!/^0[23][0-9a-f]{64}$/.test(pk)) throw new Error('wallet/publickey: ' + pk.slice(0, 200));
  log(`round ${r.timestamp} (tx ${r.tx}), commit ${commit}, oracle key ${pk}`);
  const body = dict({ Commit: Buffer.concat([Buffer.of(7), Buffer.from(commit, 'hex')]), OraclePubKey: Buffer.concat([Buffer.of(10), Buffer.from(pk, 'hex')]) });
  const t = await post('/wallet/contract/execute', { address: c.address, command: 'Attest', messageBody: body, options: { returnAddress: false, sign: SIGN }, spends: [], password: PW });
  if (!/^"?[0-9a-f]{64}"?$/.test(t)) throw new Error('Attest refused: ' + t.slice(0, 400));
  const attestation = sha3(Buffer.from(sha3(Buffer.from(commit, 'hex'), Buffer.from(pk, 'hex')), 'hex'));
  log(`Attest sent: ${t.replace(/"/g, '')}`);
  console.log(`attestation token ${contractId}${attestation} goes to the key at ${SIGN}`);
} else {
  console.error('usage: node scripts/v1/testnet-v1-oracle.mjs activate|attest [node api] [wallet password]');
  process.exit(2);
}

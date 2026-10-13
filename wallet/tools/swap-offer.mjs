#!/usr/bin/env node
// The wallet's ZP <-> BTC seller calls on a real node, from the command line: offer ZP for bitcoin, then take it back.
// Checks what a mock cannot: that the node accepts the seller's signature on the contract witness (PK sender).
// Dry run by default (builds and checks, publishes nothing); --send publishes the offer, waits for its block,
// checks the swap state, then (with --cancel) takes the offer back and checks the ZP returned.
//   TESTNET_MNEMONIC="word1 ... word24" node tools/swap-offer.mjs --swap <contract id, 72 hex> [--node http://127.0.0.1:31567]
//        [--net test] [--zp 1] [--btc 0.0001] [--addr bc1q...] [--send] [--cancel]
// Node 20 or newer (the wallet's crypto library); on an older host: docker run --rm --network host -v "$PWD:/w" -w /w -e TESTNET_MNEMONIC node:22-alpine node tools/swap-offer.mjs ...
import { NodeClient } from '../src/node.js';
import { openWallet, discover, readState, prepareOffer, prepareCancel, publish, signerOf, receiveAddress } from '../src/wallet.js';
import { btcScript, parseBTC, newOfferId } from '../src/swap.js';
import { parseZP, formatZP } from '../src/tx.js';
import { hex } from '../src/serialize.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const NET = arg('net', 'test'), SEND = process.argv.includes('--send'), CANCEL = process.argv.includes('--cancel');
const SWAP = arg('swap', ''), NODE = arg('node', 'http://127.0.0.1:31567');
if (!/^[0-9a-f]{72}$/.test(SWAP)) { console.error('Give --swap <contract id> (72 hex, from /contract/active)'); process.exit(2); }
const phrase = process.env.TESTNET_MNEMONIC; if (!phrase) { console.error('Set TESTNET_MNEMONIC'); process.exit(2); }
const node = new NodeClient(NODE, { timeoutMs: 600000 });
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = async addr => { const r = await fetch(`${NODE}/contract/state?address=${addr}`); return r.ok ? r.json() : null; };
const { encodeAddress } = await import('../src/keys.js');
const swapAddr = encodeAddress(Uint8Array.from(SWAP.match(/../g).map(h => parseInt(h, 16))), NET, true);

const w = openWallet({ id: 'cli', name: 'cli', network: NET, kind: 'mnemonic' }, phrase);
await discover(w, node);
const signer = signerOf(w);
say('wallet', receiveAddress(w), 'seller key', hex(signer.publicKey));
const amount = parseZP(arg('zp', '1')), sats = parseBTC(arg('btc', '0.0001'));
const scripts = [btcScript(arg('addr', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), 'main')];
const id = arg('id', newOfferId());
let st = await readState(w, node);
say(`balance ${formatZP(st.assets.find(a => a.asset === '00')?.spendable ?? 0n)} ZP, tip ${st.tip}`);
const offer = await prepareOffer({ w, state: st, node, swapContractId: SWAP, id, amount, sats, scripts });
say(`offer ${id}: ${formatZP(amount)} ZP for ${sats} sat, transaction ${offer.hash} built and checked${SEND ? '' : ' (dry run)'}`);
if (!SEND) process.exit(0);
say('published', await publish(node, offer));
let o = null;
for (let i = 0; i < 60 && !o; i++) { await sleep(20000); const s = await state(swapAddr); o = s?.dict?.find(([k]) => k === id)?.[1] ?? null; }
if (!o) { say('FAIL: the offer is not in the swap state after 20 minutes'); process.exit(1); }
const seller = o.dict.find(([k]) => k === 'seller')?.[1]?.pk;
say(seller === hex(signer.publicKey) ? 'PASS: offer in the swap state, seller = this key (the node accepted the signed call)' : `FAIL: seller ${seller}`);
if (!CANCEL) process.exit(seller === hex(signer.publicKey) ? 0 : 1);
await sleep(5000); st = await readState(w, node);
const used = new Set(offer.spent);
const cancel = await prepareCancel({ w, state: st, node, swapContractId: SWAP, id, amount, exclude: [...used] });
say('cancel published', await publish(node, cancel));
for (let i = 0; i < 60; i++) { await sleep(20000); const s = await state(swapAddr); if (!s?.dict?.some(([k]) => k === id)) { say('PASS: offer taken back, the ZP returned'); process.exit(0); } }
say('FAIL: the offer is still there after 20 minutes'); process.exit(1);

// A mock ZP node for browser tests of the wallet (tools/ui-test/run.py). It plays what the wallet calls: info, cgp,
// candidates, contract/active, contract/execute (as the real node: adds a Contract witness with the posted message body),
// publishtransaction (kept, GET /__published), and the address index for ONE funded wallet (the public test phrase).
// usage: node mock-node.mjs [--net test|main] [--port 8082] [--tip 95] [--alloc 0]
// Change the state while it runs: GET /__set?tip=N&alloc=P&zp=ZP&cands=1|0&utxo=I&reset=1   (tip, allocation in force, ZP balance, candidates, index of the funded output, forget published transactions)
import http from 'node:http';
import { deriveKey, encodeAddress } from '../../src/keys.js';
import { openWallet } from '../../src/wallet.js';
import { VOTING_CONTRACT } from '../../src/cgp.js';
import { Reader, VarInt, Output, Outpoint, Data, serializeTx, deserializeTx, txHash, hex, unhex } from '../../src/serialize.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const NET = arg('net', 'test'), PORT = Number(arg('port', 8082));
const st = { tip: Number(arg('tip', 95)), alloc: Number(arg('alloc', 0)), zp: BigInt(arg('zp', '5000')) * 100000000n, cands: true, published: [], asked: {}, utxo: 0 };
const VOTING = VOTING_CONTRACT[NET];
// ZP <-> BTC swap (a V1 contract) and the site's prover status (/swap/status) when the wallet's node URL ends in /node
const SWAP = '00000001' + 'dd'.repeat(32), SWAP_ADDR = encodeAddress(unhex(SWAP), NET, true);
const w = openWallet({ id: 'm', name: 'm', network: NET, kind: 'mnemonic' }, Array(23).fill('abandon').concat('art').join(' '));
const key0 = deriveKey(w.account, 0, 0), addr0 = encodeAddress(key0.pkHash, NET);
const other = encodeAddress(deriveKey(w.account, 0, 21).pkHash, NET);
const fund = () => [{ outpoint: { txHash: 'ab'.repeat(32), index: st.utxo }, lock: { PK: { hash: hex(key0.pkHash) } }, spend: { asset: '00', amount: String(st.zp) } }];
const offers = () => [
  { id: 'o-mine1', zp: 3, amount: '300000000', sats: 60000, confs: 2, state: 'open', until: null, buyer: null, seller: hex(key0.publicKey), scripts: 2, used: 0, canReserve: true, payment: null },
  { id: 'o-mine2', zp: 1, amount: '100000000', sats: 20000, confs: 2, state: 'reserved', until: st.tip + 50, buyer: 'cd'.repeat(32), seller: hex(key0.publicKey), scripts: 2, used: 1, canReserve: false, payment: null },
  { id: 'o-other', zp: 7, amount: '700000000', sats: 90000, confs: 2, state: 'open', until: null, buyer: null, seller: '03' + '44'.repeat(32), scripts: 1, used: 0, canReserve: true, payment: null }];
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(typeof body === 'string' && type !== 'application/json' ? body : JSON.stringify(body)); };

http.createServer((req, res) => {
  const u = new URL(req.url.replace(/^\/node(?=\/)/, ''), 'http://x');
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      switch (u.pathname) {
        case '/__set': for (const [k, v] of u.searchParams) { if (k === 'tip') st.tip = +v; if (k === 'alloc') st.alloc = +v; if (k === 'zp') st.zp = BigInt(v) * 100000000n; if (k === 'cands') st.cands = v === '1'; if (k === 'utxo') st.utxo = +v; if (k === 'reset') { st.published = []; st.asked = {}; } } return send(res, 200, { tip: st.tip, alloc: st.alloc });
        case '/__addr': return send(res, 200, { wallet: addr0, other });
        case '/__published': return send(res, 200, st.published);
        case '/blockchain/info': return send(res, 200, { chain: NET === 'main' ? 'main' : 'testnet', blocks: st.tip, headers: st.tip, difficulty: 0.1, medianTime: Date.now() });
        case '/blockchain/cgp': return send(res, 200, { interval: Math.floor(st.tip / (NET === 'main' ? 10000 : 100)) + 1, allocation: st.alloc, payout: null });
        case '/blockchain/candidates': return send(res, 200, st.cands ? [
          { recipient: other, spendlist: [{ asset: '00', amount: '200000000' }] },
          { recipient: encodeAddress(unhex(hex(key0.pkHash)), NET), spendlist: [{ asset: '00', amount: '50000000' }] }] : []);
        case '/swap/status': return send(res, 200, { swapId: SWAP, zpTip: st.tip, btcNet: 'main', offers: offers() });
        case '/contract/active': return send(res, 200, [{ contractId: VOTING, address: encodeAddress(unhex(VOTING), NET, true), expire: st.tip + 90000, code: '// voting contract\n'.padEnd(4000, 'x') }]);
        case '/addressdb/outputs': return send(res, 200, body.addresses?.includes(addr0) ? fund() : []);
        case '/addressdb/balance': return send(res, 200, body.addresses?.includes(addr0) ? [{ asset: '00', balance: String(st.zp) }] : []);
        case '/addressdb/transactions': return send(res, 200, []);
        case '/addressdb/discovery': return send(res, 200, (body.addresses || []).map(a => ({ address: a, hasBalance: a === addr0, hasTxs: a === addr0 })));
        case '/blockchain/contract/execute': {
          const r = new Reader(unhex(body.tx)), n = VarInt.read(r), inputs = [];
          let inSum = 0n;
          for (let i = 0; i < n; i++) { if (r.u8() !== 1) throw new Error('pointed output expected'); inputs.push({ type: 'outpoint', outpoint: Outpoint.read(r) }); inSum += Output.read(r).spend.amount; }
          const m = VarInt.read(r), outputs = []; for (let i = 0; i < m; i++) outputs.push(Output.read(r));
          const msg = Data.read(new Reader(unhex(body.messageBody)));
          const swap = body.address === SWAP_ADDR, zen = { contract: { version: 0, hash: new Uint8Array(32) }, subtype: new Uint8Array(32) };
          const add = { inputs: [], outputs: [] };
          if (swap) {
            if (!/^0[23][0-9a-f]{64}$/.test(body.options?.sender || '')) return send(res, 400, 'offer needs id, sats, s0, returnAddress, and a signed call', 'text/plain');
            const left = inSum - outputs.reduce((a, o) => a + o.spend.amount, 0n);
            if (body.command === 'offer') add.outputs.push({ lock: { type: 'Contract', contractId: { version: 1, hash: unhex(SWAP.slice(8)) } }, spend: { asset: zen, amount: left } });
            if (body.command === 'cancel') { add.inputs.push({ type: 'outpoint', outpoint: { txHash: unhex('ee'.repeat(32)), index: 0 } }); add.outputs.push({ lock: { type: 'PK', hash: key0.pkHash }, spend: { asset: zen, amount: 300000000n } }); }
          }
          const tx = { version: 0, inputs: [...inputs, ...add.inputs], outputs: [...outputs, ...add.outputs], contract: null, witnesses: [{ type: 'Contract', contractId: swap ? { version: 1, hash: unhex(SWAP.slice(8)) } : { version: 0, hash: unhex(VOTING.slice(8)) }, command: body.command,
            messageBody: msg, stateCommitment: { type: 'NotCommitted' }, beginInputs: inputs.length, beginOutputs: outputs.length, inputsLength: add.inputs.length, outputsLength: add.outputs.length, signature: null, cost: 5n }] };
          return send(res, 200, hex(serializeTx(tx)), 'text/plain');
        }
        case '/blockchain/transaction': {   // a published transaction: first asked it is in the mempool, then in a block
          const h = u.searchParams.get('hash'), known = st.published.find(x => hex(txHash(deserializeTx(unhex(x)))) === h);
          if (!known) return send(res, 404, 'not found', 'text/plain');
          st.asked[h] = (st.asked[h] || 0) + 1;
          return send(res, 200, st.asked[h] <= 1 ? { hash: h, confirmations: 0 } : { hash: h, blockNumber: st.tip + 1, confirmations: 1 });
        }
        case '/blockchain/publishtransaction': { st.published.push(body.tx); return send(res, 200, hex(txHash(deserializeTx(unhex(body.tx))))); }
        default: return send(res, 404, 'not found', 'text/plain');
      }
    } catch (e) { send(res, 400, String(e.message), 'text/plain'); }
  });
}).listen(PORT, () => console.log(`mock ${NET} node on :${PORT}, tip ${st.tip}, wallet address ${addr0}, voting contract ${VOTING}`));

// A mock ZP node for browser tests of the wallet (tools/ui-test/run.py). It plays what the wallet calls: info, cgp,
// candidates, contract/active, contract/execute (as the real node: adds a Contract witness with the posted message body),
// publishtransaction (kept, GET /__published), and the address index for ONE funded wallet (the public test phrase).
// usage: node mock-node.mjs [--net test|main] [--port 8082] [--tip 95] [--alloc 0]
// Change the state while it runs: GET /__set?tip=N&alloc=P&zp=ZP&cands=1|0&utxo=I&reset=1   (tip, allocation in force, ZP balance, candidates, index of the funded output, forget published transactions)
import http from 'node:http';
import { deriveKey, encodeAddress, decodeAddress } from '../../src/keys.js';
import { openWallet } from '../../src/wallet.js';
import { VOTING_CONTRACT, CGP_CONTRACT } from '../../src/cgp.js';
import { v1ContractId } from '../../src/engine.js';
import { Reader, Writer, Asset, VarInt, Output, Outpoint, Data, serializeTx, deserializeTx, txHash, hex, unhex } from '../../src/serialize.js';
import { sha3_256 } from '@noble/hashes/sha3.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const NET = arg('net', 'test'), PORT = Number(arg('port', 8082));
const st = { tip: Number(arg('tip', 95)), alloc: Number(arg('alloc', 0)), zp: BigInt(arg('zp', '5000')) * 100000000n, cands: true, published: [], asked: {}, utxo: 0 };
const VOTING = VOTING_CONTRACT[NET], CGP_ADDR = encodeAddress(unhex(CGP_CONTRACT[NET]), NET, true);   // the CGP fund holds 1,000 ZP
// ZP <-> BTC swap (a V1 contract) and the site's prover status (/swap/status) when the wallet's node URL ends in /node
const SWAP = '00000001' + 'dd'.repeat(32), SWAP_ADDR = encodeAddress(unhex(SWAP), NET, true);
// a V1 Dex with the site's order list (/explorer/api/dex/orders): a bid and an ask of a market maker, and with dexmine=1 an order of this wallet
const DEX = '00000001' + 'fd'.repeat(32), DEX_ADDR = encodeAddress(unhex(DEX), NET, true), MM_PUB = '02' + 'ab'.repeat(32);
const w = openWallet({ id: 'm', name: 'm', network: NET, kind: 'mnemonic' }, Array(23).fill('abandon').concat('art').join(' '));
const key0 = deriveKey(w.account, 0, 0), addr0 = encodeAddress(key0.pkHash, NET);
const other = encodeAddress(deriveKey(w.account, 0, 21).pkHash, NET);
// with tokens=1 the wallet also holds 250 of a V1 contract's token (version 1, hash ee…, default subtype)
const TOKEN = '00000001' + 'ee'.repeat(32);   // as the node's JSON names assets: BE32 version + contract hash
const fund = () => [{ outpoint: { txHash: 'ab'.repeat(32), index: st.utxo }, lock: { PK: { hash: hex(key0.pkHash) } }, spend: { asset: '00', amount: String(st.zp) } },
  ...(st.tokens ? [{ outpoint: { txHash: 'ac'.repeat(32), index: 0 }, lock: { PK: { hash: hex(key0.pkHash) } }, spend: { asset: TOKEN, amount: '250' } }] : []),
  ...(st.zusdc ? [{ outpoint: { txHash: 'ad'.repeat(32), index: 0 }, lock: { PK: { hash: hex(key0.pkHash) } }, spend: { asset: ZUSDC, amount: '2000000' } }] : [])];
const ZUSDC = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577';   // the testnet's V1 zUSDC (6 decimals)
const offers = () => [
  { id: 'o-mine1', zp: 3, amount: '300000000', sats: 60000, confs: 2, state: 'open', until: null, buyer: null, seller: hex(key0.publicKey), scripts: 2, scriptList: ['0014' + '11'.repeat(20), '0014' + '22'.repeat(20)], used: 0, canReserve: true, payment: null },
  { id: 'o-mine2', zp: 1, amount: '100000000', sats: 20000, confs: 2, state: 'reserved', until: st.tip + 50, buyer: 'cd'.repeat(32), seller: hex(key0.publicKey), scripts: 2, used: 1, canReserve: false, payment: null },
  { id: 'o-mine3', zp: 2, amount: '200000000', sats: 30000, confs: 2, state: 'expired', until: st.tip - 3, buyer: 'cd'.repeat(32), seller: hex(key0.publicKey), scripts: 2, used: 1, canReserve: true, payment: null },
  // the buyer's side (buy=…): reserved for this wallet once its reservation is "in a block" (stage 1), then paid with 0..2 confirmations, then proved; gone when bought
  ...(st.buy?.stage === 9 ? [] : [st.buy && st.buy.stage >= 1
    ? { id: 'o-other', zp: 7, amount: '700000000', sats: 90000, confs: 2, state: 'reserved', until: st.tip + 20, buyer: st.buy.pk, seller: '03' + '44'.repeat(32), scripts: 1, used: 1, canReserve: false, address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', payment: st.buy.stage >= 2 ? { txid: 'f0'.repeat(32), confs: st.buy.stage - 2, need: 2, block: st.buy.stage >= 3 ? 900000 : null, proof: st.buy.stage >= 5 ? 'e0'.repeat(32) : null } : null }
    : { id: 'o-other', zp: 7, amount: '700000000', sats: 90000, confs: 2, state: 'open', until: null, buyer: null, seller: '03' + '44'.repeat(32), scripts: 1, scriptList: ['00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262'], used: 0, canReserve: true, payment: null }])];
const FAMILIES = [{"id": "timelock-vault", "title": "Time-locked vault", "description": "Anyone can deposit ZP. From a given block on, 'withdraw' (body: amount) pays the requested amount to the owner only; before it, withdrawals are refused.", "params": {"owner": {"type": "hash", "description": "owner's public key hash (64 hex digits); withdrawals go only to this key", "example": "abcd000000000000000000000000000000000000000000000000000000001234"}, "unlock_block": {"type": "u32", "min": 1, "description": "first block at which withdrawals are allowed", "example": 2500}}, "commands": {"deposit": {"description": "Lock the ZP you send in the vault.", "sends": "zp", "signedBy": [], "body": {}}, "withdraw": {"description": "Pay the owner from the vault, from the unlock block on. Anyone can call it; the money goes only to the owner.", "sends": null, "signedBy": [], "from": "unlock_block", "body": {"amount": {"type": "amount", "data": "u64", "description": "how much to pay the owner (kalapas)"}}}}}, {"id": "escrow", "title": "Escrow with an arbiter", "description": "Holds an asset for a sale. 'deposit' locks what is sent in; 'release' (body: amount) pays the seller, signed by the buyer or the arbiter; 'refund' (body: amount) pays the buyer, signed by the seller or the arbiter, or by anyone after the timeout block.", "params": {"buyer": {"type": "publickey", "description": "the buyer's public key (66 hex): gets refunds, can release", "example": "03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb"}, "seller": {"type": "publickey", "description": "the seller's public key (66 hex): gets the release, can refund", "example": "03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc"}, "arbiter": {"type": "publickey", "description": "the arbiter's public key (66 hex): can release or refund, never paid", "example": "021697ffa6fd9de627c077e3d2fe541084ce13300b0bec1146f95ae57f0d0bd6a5"}, "asset": {"type": "asset", "description": "what is held: zp, or a token (contract hash[:subtype])", "default": "zp"}, "timeout_block": {"type": "u32", "min": 2, "description": "from this block on, anyone can refund the buyer", "example": 5000}}, "commands": {"deposit": {"description": "Lock what you send in the escrow.", "sends": "asset", "signedBy": [], "body": {}}, "release": {"description": "Pay the seller from the escrow.", "sends": null, "signedBy": ["buyer", "arbiter"], "body": {"amount": {"type": "amount", "data": "u64", "description": "how much to pay the seller"}}}, "refund": {"description": "Pay the buyer back. From the timeout block, anyone can.", "sends": null, "signedBy": ["seller", "arbiter"], "anyoneFrom": "timeout_block", "body": {"amount": {"type": "amount", "data": "u64", "description": "how much to pay back"}}}}}, {"id": "token", "title": "Token sale", "description": "Sells the contract's own token 1:1 for ZP (\"buy\") and buys it back from the contract's ZP (\"redeem\"). Body: returnAddress.", "params": {}, "commands": {"buy": {"description": "Buy the contract's token 1:1 with the ZP you send.", "sends": "zp", "signedBy": [], "body": {"returnAddress": {"type": "address", "data": "lock", "description": "where the contract sends what it pays you (your address)"}}}, "redeem": {"description": "Send tokens back and get the same amount of ZP.", "sends": "self", "signedBy": [], "body": {"returnAddress": {"type": "address", "data": "lock", "description": "where the contract sends what it pays you (your address)"}}}}}, {"id": "swap", "title": "Fixed-rate swap", "description": "Sells one asset for another at a fixed rate. 'swap' (body: returnAddress) pays the owner directly and sends the bought amount from the contract's stock; 'fund' adds stock (anyone); 'close' (body: amount; signed by the owner) takes stock back.", "params": {"owner": {"type": "publickey", "description": "the owner's public key (66 hex): receives every payment, and only it can close", "example": "03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb"}, "pay_asset": {"type": "asset", "description": "what buyers pay with: zp, or a token (contract hash[:subtype])", "default": "zp"}, "sell_asset": {"type": "asset", "description": "what the contract sells: a token (contract hash[:subtype]), or zp", "example": "abababababababababababababababababababababababababababababababab"}, "price_num": {"type": "u64", "min": 1, "description": "units sold for every price_den units paid (numerator)", "example": 3}, "price_den": {"type": "u64", "min": 1, "description": "units paid for price_num units sold (denominator)", "example": 2}}, "commands": {"swap": {"description": "Pay with the pay asset and get the sell asset at the fixed rate.", "sends": "pay_asset", "signedBy": [], "body": {"returnAddress": {"type": "address", "data": "lock", "description": "where the contract sends what it pays you (your address)"}}}, "fund": {"description": "Add stock of the sell asset to the contract.", "sends": "sell_asset", "signedBy": [], "body": {}}, "close": {"description": "Take stock back to the owner.", "sends": null, "signedBy": ["owner"], "body": {"amount": {"type": "amount", "data": "u64", "description": "how much stock to take back (units)"}}}}}, {"id": "vote", "title": "Holders' vote", "description": "Token holders vote by sending tokens with their choice; each option's count is the amount sent for it, in the contract's state. The tokens stay locked until the closing block (so they vote once) and voters get receipts; from the closing block, 'redeem' returns the tokens 1:1 for receipts. 'vote' body: option, returnAddress; 'redeem' body: returnAddress.", "params": {"question": {"type": "string", "max": 120, "description": "the question, as voters will read it", "example": "Keep accepting V0 activations after the fork?"}, "options": {"type": "options", "min_count": 2, "max_count": 8, "max": 32, "description": "the choices, separated by commas", "example": "yes,no,abstain"}, "vote_asset": {"type": "asset", "description": "what holders vote with: zp, or a token (contract hash[:subtype])", "default": "zp"}, "close_block": {"type": "u32", "min": 2, "description": "votes are accepted before this block; receipts are redeemed from it", "example": 5000}}, "commands": {"vote": {"description": "Vote for an option with the tokens you send; they stay locked until the close and you get receipts.", "sends": "vote_asset", "signedBy": [], "until": "close_block", "body": {"option": {"type": "choice", "data": "string", "of": "options", "description": "your choice"}, "returnAddress": {"type": "address", "data": "lock", "description": "where the contract sends what it pays you (your address)"}}}, "redeem": {"description": "From the closing block, send receipts back and get your tokens 1:1.", "sends": "self", "signedBy": [], "from": "close_block", "body": {"returnAddress": {"type": "address", "data": "lock", "description": "where the contract sends what it pays you (your address)"}}}}}];
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(typeof body === 'string' && type !== 'application/json' ? body : JSON.stringify(body)); };

http.createServer((req, res) => {
  const u = new URL(req.url.replace(/^\/node(?=\/)/, ''), 'http://x');
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (u.pathname.startsWith('/engine/job/')) { const j = st.jobs?.[u.pathname.slice(12)]; if (!j) return send(res, 404, { error: 'unknown job' }); return send(res, 200, j.polls++ < 1 ? { job: u.pathname.slice(12), status: 'running' } : j.done); }
      switch (u.pathname) {
        case '/__set': for (const [k, v] of u.searchParams) { if (k === 'tip') st.tip = +v; if (k === 'alloc') st.alloc = +v; if (k === 'zp') st.zp = BigInt(v) * 100000000n; if (k === 'cands') st.cands = v === '1'; if (k === 'utxo') st.utxo = +v; if (k === 'tokens') st.tokens = v === '1'; if (k === 'reset') { st.published = []; st.asked = {}; st.known = new Set(); st.tokens = false; st.buy = null; st.dexGone = []; } if (k === 'askLeft') st.askLeft = +v; if (k === 'loose') st.loose = v === '1'; if (k === 'zusdc') st.zusdc = v === '1'; if (k === 'bridge') st.bridge = v === '1'; if (k === 'dexmine') st.dexmine = v === '1'; if (k === 'buystage' && st.buy) st.buy.stage = +v; } return send(res, 200, { tip: st.tip, alloc: st.alloc });
        case '/__addr': return send(res, 200, { wallet: addr0, other });
        case '/explorer/api/dex/orders': {
          const ZU = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577';
          const all = [{ tx: 'b1'.repeat(32), block: 2090, under_asset: ZU, under_amount: '9900000', pair_asset: '00', pair_total: '10000000000', maker: MM_PUB },
            { tx: 'a1'.repeat(32), block: 2091, under_asset: '00', under_amount: '10000000000', pair_asset: ZU, pair_total: '10100000', maker: MM_PUB },
            ...(st.dexmine ? [{ tx: 'c1'.repeat(32), block: 2092, under_asset: '00', under_amount: '200000000', pair_asset: ZU, pair_total: '300000', maker: hex(key0.publicKey) }] : [])];
          return send(res, 200, { tip: st.tip, dex: DEX, orders: all.filter(o => !(st.dexGone || []).includes(o.tx)) });
        }
        case '/bridge/status': return st.bridge ? send(res, 200, { bridgeZp: other, asset: ZUSDC, zpConfirmations: 2, autoWithdraw: true }) : send(res, 404, { error: 'no bridge' });
        case '/__published': return send(res, 200, st.published);
        case '/__lastdex': return send(res, 200, st.lastDex || null);
        case '/blockchain/info': return send(res, 200, { chain: NET === 'main' ? 'main' : 'testnet', blocks: st.tip, headers: st.tip, difficulty: 0.1, medianTime: Date.now() });
        case '/blockchain/cgp': return send(res, 200, { interval: Math.floor(st.tip / (NET === 'main' ? 10000 : 100)) + 1, allocation: st.alloc, payout: null });
        case '/blockchain/candidates': return send(res, 200, st.cands ? [
          { recipient: other, spendlist: [{ asset: '00', amount: '200000000' }] },
          { recipient: encodeAddress(unhex(hex(key0.pkHash)), NET), spendlist: [{ asset: '00', amount: '50000000' }] }] : []);
        case '/oracle/rounds/latest': return send(res, 200, { Tickers: ['BTC', 'GOLD'], Values: [100000, 4000], Timestamp: Date.now(), Evidence: '{}' });
        // the contract engine (zp-contracts-v1 docs/SERVICE.md): a job is running on its first poll, done on the next
        // families as tools/engine/families/*/family.json on zp-contracts-v1 engine-check 052c8ea
        case '/engine/families': return send(res, 200, FAMILIES);
        case '/engine/health': return send(res, 200, { ok: true, ask: { enabled: true, perDay: 5, left: st.askLeft ?? 4 } });
        case '/engine/try': {
          // a toy escrow: deposit adds what is sent; release/refund pay a role from the contract's coins, change back
          if (body.sourceId && !(st.known || new Set()).has(body.sourceId)) return send(res, 404, { error: 'send the source' });
          const src = body.source, cid = body.sourceId || v1ContractId(src); (st.known ||= new Set()).add(cid);
          if (src && /let rec/.test(src)) { const id = 'f'.repeat(8) + Date.now().toString(16).padStart(16, '0'); st.jobs ||= {}; st.jobs[id] = { polls: 0, done: { job: id, kind: 'try', status: 'done', ok: false, check: { verdict: 'refused', refusal: { title: 'a recursive definition', line: 2, fix: 'Use a Zulib loop.' } } } }; return send(res, 202, { job: id }); }
          const c = body.call, roles = body.roles || {}, who = pk => { const r = Object.keys(roles).find(k => roles[k] === pk); return { kind: 'pk', hash: 'ee'.repeat(32), ...(r ? { role: r } : {}) }; };
          for (const k of ['spend', 'wallet']) for (const x of c[k] || []) if (typeof x.amount !== 'string') return send(res, 400, { error: `call.${k}[0].amount: kalapas as a decimal string` });
          const held = (c.wallet || []).reduce((a, x) => a + BigInt(x.amount), 0n), self = { kind: 'contract', hash: cid.slice(8), self: true };
          let result, moves = [], next = { wallet: c.wallet || [], state: c.state ?? null };
          const signer = c.sender?.publicKey, role = Object.keys(roles).find(k => roles[k] === signer);
          if (c.command === 'vote' || c.command === 'redeem') {   // the vote family: votes before close_block (5000 in the test), receipts redeemed from it
            const body2 = c.bodyHex ? Object.fromEntries(Data.read(new Reader(unhex(c.bodyHex))).v) : {}, blk = c.context?.blockNumber ?? 1, a = BigInt(c.spend?.[0]?.amount || '0');
            const open = c.command === 'vote' ? blk < 5000 : blk >= 5000;
            if (!open) result = { ok: false, declaredCost: '900', gasUsed: '300', error: c.command === 'vote' ? 'voting has closed' : 'receipts are redeemed from the closing block' };
            else if (!body2.returnAddress || (c.command === 'vote' && !body2.option)) result = { ok: false, declaredCost: '900', gasUsed: '100', error: 'missing body fields' };
            else { const back = { kind: 'pk', hash: hex(body2.returnAddress.v.hash) };
              result = { ok: true, declaredCost: '892', gasUsed: '892', inputs: [], outputs: [] };
              moves = c.command === 'vote' ? [{ who: self, asset: c.spend[0].asset, change: String(a) }, { who: back, asset: cid.slice(8), change: String(a) }, { who: { kind: 'mint' }, asset: cid.slice(8), change: String(-a) }]
                : [{ who: back, asset: 'zp', change: String(a) }, { who: { kind: 'destroy' }, asset: cid.slice(8), change: String(a) }, { who: self, asset: 'zp', change: String(-a) }];
              st.lastVote = body2.option?.v; }
          } else if (c.command === 'deposit') { const a = BigInt(c.spend?.[0]?.amount || '0'); result = { ok: true, declaredCost: '1429', gasUsed: '1429', inputs: [{ who: signer ? who(signer) : { kind: 'pk', hash: '99'.repeat(32) }, asset: 'zp', amount: String(a) }], outputs: [{ who: self, asset: 'zp', amount: String(a) }] };
            moves = [{ who: self, asset: 'zp', change: String(a) }]; next = { wallet: [...(c.wallet || []), { asset: 'zp', amount: String(a) }], state: null }; }
          else {
            const amt = c.bodyHex ? Data.read(new Reader(unhex(c.bodyHex))).v.find(([k]) => k === 'amount')?.[1].v ?? 0n : 0n;
            const okRoles = c.command === 'release' ? ['buyer', 'arbiter'] : ['seller', 'arbiter'], to = c.command === 'release' ? 'seller' : 'buyer', anyone = c.command === 'refund' && (c.context?.blockNumber ?? 1) >= 5000;
            if (!okRoles.includes(role) && !anyone) result = { ok: false, declaredCost: '1557', gasUsed: '212', error: `only the ${okRoles.join(' or the ')} can ${c.command} (sign the call)` };
            else if (amt > held && !st.loose) result = { ok: false, declaredCost: '1557', gasUsed: '640', error: 'not enough in the escrow' };
            else if (amt > held && st.loose) { result = { ok: true, declaredCost: '1557', gasUsed: '1557', inputs: (c.wallet || []).map(x => ({ who: self, asset: 'zp', amount: x.amount })), outputs: [{ who: { kind: 'pk', hash: 'ee'.repeat(32), role: to }, asset: 'zp', amount: String(amt) }], unbalanced: [{ asset: 'zp', missing: String(amt - held) }] };   // a contract that pays out more than goes in (engine 7fdb129)
              moves = [{ who: { kind: 'pk', hash: 'ee'.repeat(32), role: to }, asset: 'zp', change: String(amt) }, { who: self, asset: 'zp', change: String(-held) }]; next = { wallet: [], state: null }; }
            else { result = { ok: true, declaredCost: '1557', gasUsed: '1557', inputs: (c.wallet || []).map(x => ({ who: self, asset: 'zp', amount: x.amount })), outputs: [{ who: { kind: 'pk', hash: 'ee'.repeat(32), role: to }, asset: 'zp', amount: String(amt) }, ...(held > amt ? [{ who: self, asset: 'zp', amount: String(held - amt) }] : [])] };
              moves = [{ who: { kind: 'pk', hash: 'ee'.repeat(32), role: to }, asset: 'zp', change: String(amt) }, { who: self, asset: 'zp', change: String(-amt) }]; next = { wallet: held > amt ? [{ asset: 'zp', amount: String(held - amt) }] : [], state: null }; }
          }
          st.lastTry = body;
          const id = 'e'.repeat(8) + Date.now().toString(16).padStart(16, '0'); st.jobs ||= {};
          st.jobs[id] = { polls: 0, done: { job: id, kind: 'try', status: 'done', ok: true, try: { contract: cid, result, moves, next } } };
          return send(res, 202, { job: id });
        }
        case '/__lasttry': return send(res, 200, st.lastTry || null);
        case '/engine/make': case '/engine/ask': case '/engine/check': {
          const id = (Date.now().toString(16) + 'a'.repeat(24)).slice(0, 24), src = body.source || `// ${body.family || 'asked'} ${JSON.stringify(body.params || body.text || '')}\nlet main = 1\n`;
          const refused = /let rec/.test(src);
          const check = { network: 'testnet', contractId: v1ContractId(src), bytes: src.length, activation: { v1Height: Number(process.env.V1H || 2050), characters: src.length, minSacrificePerBlock: src.length },
            verdict: refused ? 'refused' : 'accepted', refusal: refused ? { rule: 'recursion', title: 'a recursive definition', line: 2, code: 'let rec spin n = spin n', why: 'Nodes build contracts without proofs.', fix: 'Use a Zulib loop.' } : null };
          st.jobs ||= {}; st.jobs[id] = { polls: 0, done: u.pathname === '/engine/check' ? { job: id, kind: 'check', status: 'done', ok: !refused, check }
            : { job: id, kind: u.pathname.slice(8), status: 'done', ok: true, report: { ok: true, stage: 'done', contractId: v1ContractId(src).slice(8) }, source: src,
                tests: [{ name: 'withdraw before the block is refused', command: 'withdraw', expect: { ok: false, declaredCost: 120 } }, { name: 'deposit', command: 'deposit', expect: { ok: true, declaredCost: 90 } }],
                check, ...(u.pathname === '/engine/ask' ? { rounds: [{}, {}] } : {}) } };
          (st.known ||= new Set()).add(v1ContractId(src));
          return send(res, 202, { job: id, status: 'queued' });
        }
        case '/swap/reserve': {   // the prover reserves for the buyer's address (it pays the fee)
          if (body.id !== 'o-other' || !/^tzn1/.test(body.buyer || '')) return send(res, 400, { error: 'no such offer' });
          st.buy = { buyer: body.buyer, pk: hex(decodeAddress(body.buyer).hash), stage: 0 };
          return send(res, 200, { tx: 'c0'.repeat(32), pkHash: st.buy.pk });
        }
        case '/swap/status': return send(res, 200, { swapId: SWAP, zpTip: st.tip, btcNet: 'main', offers: offers() });
        case '/contract/active': return send(res, 200, [{ contractId: VOTING, address: encodeAddress(unhex(VOTING), NET, true), expire: st.tip + 90000, code: '// voting contract\n'.padEnd(4000, 'x') }]);
        case '/addressdb/outputs': return send(res, 200, body.addresses?.includes(addr0) ? fund() : []);
        case '/addressdb/balance': return send(res, 200, body.addresses?.includes(CGP_ADDR) ? [{ asset: '00', balance: '100000000000' }] : body.addresses?.includes(addr0) ? [{ asset: '00', balance: String(st.zp) }, ...(st.tokens ? [{ asset: TOKEN, balance: '250' }] : [])] : []);
        case '/addressdb/transactions': return send(res, 200, st.zusdc && body.addresses?.includes(addr0) ? [{ txHash: 'ad'.repeat(32), asset: ZUSDC, amount: '2000000', confirmations: 3, timestamp: Date.now() - 60000, lock: { PK: { hash: hex(key0.pkHash), address: addr0 } } }] : []);
        case '/addressdb/discovery': return send(res, 200, (body.addresses || []).map(a => ({ address: a, hasBalance: a === addr0, hasTxs: a === addr0 })));
        case '/blockchain/contract/execute': {
          const r = new Reader(unhex(body.tx)), n = VarInt.read(r), inputs = [];
          let inSum = 0n;
          for (let i = 0; i < n; i++) { if (r.u8() !== 1) throw new Error('pointed output expected'); inputs.push({ type: 'outpoint', outpoint: Outpoint.read(r) }); inSum += Output.read(r).spend.amount; }
          const m = VarInt.read(r), outputs = []; for (let i = 0; i < m; i++) outputs.push(Output.read(r));
          const msg = Data.read(new Reader(unhex(body.messageBody)));
          const swap = body.address === SWAP_ADDR, dex = body.address === DEX_ADDR, zen = { contract: { version: 0, hash: new Uint8Array(32) }, subtype: new Uint8Array(32) };
          const add = { inputs: [], outputs: [] };
          if (swap) {
            if (!/^0[23][0-9a-f]{64}$/.test(body.options?.sender || '')) return send(res, 400, 'offer needs id, sats, s0, returnAddress, and a signed call', 'text/plain');
            const left = inSum - outputs.reduce((a, o) => a + o.spend.amount, 0n);
            const swapLock = { type: 'Contract', contractId: { version: 1, hash: unhex(SWAP.slice(8)) } }, marker = { contract: { version: 1, hash: unhex(SWAP.slice(8)) }, subtype: new Uint8Array(32) };
            if (body.command === 'offer') {   // as BitZenSwap: the ZP to the swap, plus its state marker (1 own token minted and locked to it)
              add.inputs.push({ type: 'mint', spend: { asset: marker, amount: 1n } });
              add.outputs.push({ lock: swapLock, spend: { asset: zen, amount: left } }, { lock: swapLock, spend: { asset: marker, amount: 1n } });
            }
            if (body.command === 'cancel') { add.inputs.push({ type: 'outpoint', outpoint: { txHash: unhex('ee'.repeat(32)), index: 0 } }); add.outputs.push({ lock: { type: 'PK', hash: key0.pkHash }, spend: { asset: zen, amount: 300000000n } }); }
          }
          if (dex) {   // as contracts/v1/Dex.fst: Take (anonymous), Make and Cancel (signed by the maker)
            const f = Object.fromEntries(msg.v), dexLock = { type: 'Contract', contractId: { version: 1, hash: unhex(DEX.slice(8)) } };
            const aid = id => id === '00' ? zen : { contract: { version: parseInt(id.slice(0, 8), 16), hash: unhex(id.slice(8, 72)) }, subtype: new Uint8Array(32) };
            const order = { contract: { version: 1, hash: unhex(DEX.slice(8)) }, subtype: unhex('0e'.repeat(32)) }, makerHash = sha3_256(f.MakerPubKey.v);
            const signed = /^0[23][0-9a-f]{64}$/.test(body.options?.sender || '');
            if (body.command === 'Take') {
              const ua = f.UnderlyingAmount.v, ot = f.OrderTotal.v, pr = f.ProvidedAmount.v, pay = f.RequestedPayout.v;
              if (pay !== ua * pr / ot) return send(res, 400, 'Incorrect requested payout', 'text/plain');
              add.inputs.push({ type: 'outpoint', outpoint: { txHash: unhex('fd'.repeat(32)), index: 0 } });
              add.outputs.push({ lock: f.returnAddress.v, spend: { asset: aid(f.UnderlyingAsset.v), amount: pay } }, { lock: { type: 'PK', hash: makerHash }, spend: { asset: aid(f.PairAsset.v), amount: pr } });
              if (pr < ot) add.outputs.push({ lock: dexLock, spend: { asset: aid(f.UnderlyingAsset.v), amount: ua - pay } }, { lock: dexLock, spend: { asset: order, amount: 1n } });
              add.outputs.push({ lock: { type: 'Destroy' }, spend: { asset: order, amount: 1n } });
              st.lastDex = { command: 'Take', provided: String(pr), payout: String(pay), signed };
            } else if (body.command === 'Make' || body.command === 'Cancel') {
              if (!signed || body.options.sender !== hex(f.MakerPubKey.v)) return send(res, 400, 'SenderPubKey must match MakerPubKey', 'text/plain');
              if (body.command === 'Make') { add.inputs.push({ type: 'mint', spend: { asset: order, amount: 1n } }); add.outputs.push({ lock: dexLock, spend: { asset: order, amount: 1n } }, { lock: dexLock, spend: { asset: aid(f.UnderlyingAsset.v), amount: f.UnderlyingAmount.v } }); }
              else { add.inputs.push({ type: 'outpoint', outpoint: { txHash: unhex('fd'.repeat(32)), index: 1 } }); add.outputs.push({ lock: { type: 'PK', hash: makerHash }, spend: { asset: aid(f.UnderlyingAsset.v), amount: f.UnderlyingAmount.v } }, { lock: { type: 'Destroy' }, spend: { asset: order, amount: 1n } }); }
              st.lastDex = { command: body.command, signed };
            }
          }
          const tx = { version: 0, inputs: [...inputs, ...add.inputs], outputs: [...outputs, ...add.outputs], contract: null, witnesses: [{ type: 'Contract', contractId: dex ? { version: 1, hash: unhex(DEX.slice(8)) } : swap ? { version: 1, hash: unhex(SWAP.slice(8)) } : { version: 0, hash: unhex(VOTING.slice(8)) }, command: body.command,
            messageBody: msg, stateCommitment: { type: 'NotCommitted' }, beginInputs: inputs.length, beginOutputs: outputs.length, inputsLength: add.inputs.length, outputsLength: add.outputs.length, signature: null, cost: 5n }] };
          return send(res, 200, hex(serializeTx(tx)), 'text/plain');
        }
        case '/blockchain/transaction': {   // a published transaction: first asked it is in the mempool, then in a block
          const h = u.searchParams.get('hash');
          if (st.zusdc && h === 'ad'.repeat(32)) return send(res, 200, { tx: { inputs: [{ mint: { asset: ZUSDC, amount: '2000000' } }, { outpoint: { txHash: 'ae'.repeat(32), index: 0 } }], outputs: [{ lock: { PK: { hash: hex(key0.pkHash), address: addr0 } }, spend: { asset: ZUSDC, amount: '2000000' } }] }, confirmations: 3 });   // zUSDC issued by the bridge
          const known = st.published.find(x => hex(txHash(deserializeTx(unhex(x)))) === h);
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

// ZP Wallet - user interface. Plain DOM, no framework; every value shown that comes from a user
// or a node goes through esc(). Secrets live in memory only while unlocked.
import qrcode from 'qrcode-generator';
import { newMnemonic, checkMnemonic, isValidAddress, decodeAddress, encodeAddress } from '../src/keys.js';
import { NodeClient, NodeError, DEFAULT_NODES } from '../src/node.js';
import { createVault, unlockVault, seal, open, storage } from '../src/vault.js';
import { CGP_PARAMS, VOTING_CONTRACT, CGP_CONTRACT, allocationRange, allocationBallot, payoutBallot, candidateBallot, phaseAt, snapshotBlock, phasesOf } from '../src/cgp.js';
import { openWallet, prepareVote, checkInfo, discover, readState, readHistory, prepareSend, prepareExtend, extendCost, MAX_EXTEND_BLOCKS, publish, receiveAddress, canSpend, addresses, prepareOffer, prepareCancel, signerOf, prepareActivateV1 } from '../src/wallet.js';
import { btcScript, parseBTC, formatBTC, newOfferId, MAX_SCRIPTS, totalFromPerZp, checkFresh, BTC_API } from '../src/swap.js';
import { EngineClient, checkParam, v1ContractId, activationCost, engineAsset, tryAsset, commandsOf, bodyHexOf, kalapasOf, formatAmount, assetLabel, holdings, sendsAsset, windowsOf } from '../src/engine.js';
import { parseZP, formatZP, ZP } from '../src/tx.js';
import { hex } from '../src/serialize.js';
import contractNames from '../../site/contract-names.json';

const LOCK_AFTER_MS = 15 * 60 * 1000;
const SETTINGS_KEY = 'zp-wallet.settings.v1';
// the release number from package.json, set by build.mjs (CHANGELOG.md lists what each release changed)
const WALLET_VERSION = typeof __WALLET_VERSION__ === 'string' ? __WALLET_VERSION__ : 'dev';
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortAddr = a => a ? a.slice(0, 10) + '…' + a.slice(-6) : '';
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const icon = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  back: icon('<path d="M15 18l-6-6 6-6"/>'), send: icon('<path d="M7 17L17 7"/><path d="M8 7h9v9"/>'),
  recv: icon('<path d="M17 7L7 17"/><path d="M16 17H7V8"/>'), vote: icon('<path d="M9 12l2 2 4-4"/><rect x="4" y="4" width="16" height="16" rx="3"/>'),
  home: icon('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/>'), gear: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  doc: icon('<path d="M6 3h9l3 3v15H6z"/><path d="M9 12h6M9 16h6"/>'), refresh: icon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  chart: icon('<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l4-5 3 3 4-6"/>'),
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
};

// ---------------------------------------------------------------- state
const S = {
  vault: storage.load(), key: null, open: new Map(), data: new Map(),
  screen: null, tab: 'new', assetNames: {}, draft: {}, error: '', busy: false, modal: null, nodeOk: null, tip: null, cgp: null,
  settings: loadSettings(), lastActivity: Date.now(),
};
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* default */ }
  return { mtab: ['oracle', 'dex', 'swap'].includes(s.mtab) ? s.mtab : 'oracle', network: s.network === 'test' ? 'test' : 'main', nodes: { main: s.nodes?.main || DEFAULT_NODES.main[0], test: s.nodes?.test || '' }, active: s.active || null,
           voteWallets: { main: Array.isArray(s.voteWallets?.main) ? s.voteWallets.main : null, test: Array.isArray(s.voteWallets?.test) ? s.voteWallets.test : null } };
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch { /* private mode */ } }
const net = () => S.settings.network;
// a site that hosts this wallet next to its own node can name it in config.json ({ "testNode": "http://host/node" }), so its testnet works at once
const defaultNode = n => DEFAULT_NODES[n][0] || S.siteDefaults?.[n] || '';
const node = () => S.settings.nodes[net()] ? new NodeClient(S.settings.nodes[net()]) : null;
const walletsHere = () => (S.vault?.wallets || []).filter(w => w.network === net());
const active = () => { const ws = walletsHere(); return ws.find(w => w.id === S.settings.active) || ws[0] || null; };

const zpOf = id => { const z = S.data.get(id)?.state?.assets.find(x => x.asset === '00'); return z ? z.spendable + z.maturing : 0n; };
// wallets that vote together (null = every wallet that can sign); watch-only wallets cannot sign a ballot
const voters = () => { const sel = S.settings.voteWallets[net()]; return walletsHere().filter(w => w.kind !== 'watch' && (sel === null || sel.includes(w.id))); };
const voteWeight = () => voters().reduce((s, w) => s + zpOf(w.id), 0n);
const CONTRACT_ROLE = { CGP: 'Holds the community fund', VCGP: 'Counts CGP votes', FPC: 'Fixed-payout bets', 'DEX-V2': 'Exchange' };
const EXTEND_WARN = 200000000n; // 2 ZP: ask the user to check the contract once more
const MY_CONTRACTS_KEY = 'zp-wallet.my-contracts.v1';   // address -> the family it was made from (contracts activated here)
const myContracts = () => { try { const v = JSON.parse(localStorage.getItem(MY_CONTRACTS_KEY)); return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => /^c(zen|tzn)1/.test(k)).map(([k, x]) => [k, typeof x === 'string' ? { name: x } : x])) : {}; } catch { return {}; } };
const rememberContract = (addr, x) => { try { localStorage.setItem(MY_CONTRACTS_KEY, JSON.stringify({ ...myContracts(), [addr]: x })); } catch { /* private mode */ } };
const nameOf = (id, addr) => { const m = myContracts()[addr]; return contractNames[addr] || contractNames[id] || (typeof m === 'string' ? m : m?.name) || null; };
// price of one ZP in an offer: BTC and satoshis, and in dollars when the oracle has a Bitcoin price (ticker BTC, USD)
const btcUsd = () => { const r = S.markets?.round, i = r?.tickers?.indexOf('BTC') ?? -1; const v = i >= 0 ? Number(r.values[i]) : NaN; return v > 0 ? v : null; };
const rateText = (sats, kalapas) => {
  const per = Number(sats) * 1e8 / Number(kalapas); if (!Number.isFinite(per) || per <= 0) return '–';
  const usd = btcUsd() ? per / 1e8 * btcUsd() : null;
  return `${(per / 1e8).toFixed(8)} BTC per ZP (${per.toLocaleString('en-US', { maximumFractionDigits: per < 10 ? 2 : 0 })} sat)${usd ? ` ≈ $${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 })}` : ''}`;
};
const zpStr = v => Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–';

function go(screen, extra = {}) { freshScreen = true; Object.assign(S, { screen, error: '', modal: null }, extra); if (screen === 'vote') S.cands = null; /* the candidate list belongs to one interval: ask the node again */ render(); if (screen === 'vote') refreshVotes(); window.scrollTo(0, 0); if (screen === 'markets') loadMarkets(); if (screen === 'contracts') loadEngine(); }
// the site that serves this node (oracle, explorer API and index files sit next to /node/)
const siteBase = () => { try { const u = new URL(S.settings.nodes[net()]); return /\/node$/.test(u.pathname) ? u.origin : ''; } catch { return ''; } };
async function loadMarkets() {
  S.marketsError = '';
  const base = siteBase();
  if (!base) { S.markets = null; S.marketsError = 'This node has no oracle or Dex next to it. Markets are on the testnet node of the community.'; return render(); }
  try {
    const get = async p => { const r = await fetch(base + p, { cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
    const norm = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), v]));   // the oracle answers with capitalised names
    const round = norm(await get('/oracle/rounds/latest'));
    let evidence = {}; try { evidence = JSON.parse(round.evidence || '{}'); } catch { /* older round */ }
    if (!Array.isArray(round.tickers) || !Array.isArray(round.values)) throw new Error('unexpected oracle answer');
    const orders = await get('/explorer/api/dex/orders').then(j => Array.isArray(j?.orders) ? j.orders : []).catch(() => []);
    S.markets = { round, evidence, orders, day: new Date(round.timestamp).toISOString().slice(0, 10) };
  } catch (e) { S.markets = null; S.marketsError = 'Could not read the oracle: ' + e.message; }
  await loadSwap();
}
// ZP <-> BTC: the site's prover lists the swap contract's offers (site/bitzen/prover.mjs, GET /swap/status)
async function loadSwap() {
  const base = siteBase(); S.swapError = '';
  if (!base) { S.swap = null; return render(); }
  try {
    const r = await fetch(base + '/swap/status', { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !/^[0-9a-f]{72}$/.test(j.swapId || '') || !Array.isArray(j.offers)) throw new Error('not running');
    S.swap = j;
  } catch { S.swap = null; S.swapError = 'The ZP ⇄ BTC contract is not running on this network yet.'; }
  render();
}
// public keys of this device's wallets that can sign (an offer's seller is one of them)
const mySellers = () => new Map(walletsHere().map(w => [w, S.open.get(w.id)]).filter(([, o]) => o && canSpend(o)).map(([w, o]) => [hex(signerOf(o).publicKey), w]));
// an offer whose take-back was sent from here, or whose cancel the prover sees in the mempool, waits for its block
const takingBack = o => o.state === 'closing' || (S.takingBack?.[o.id] && Date.now() - S.takingBack[o.id] < 30 * 60e3);
// the contract refuses a take-back while the offer is held and in the 10 blocks after (BitZenSwap cancel)
const backFrom = o => o.until != null ? Number(o.until) + 11 : 0;
const canTakeBack = o => o.state !== 'reserved' && !o.payment && !takingBack(o) && (S.swap?.zpTip ?? 0) + 1 >= backFrom(o);
const PENDING_OFFERS_KEY = 'zp-wallet.pending-offers.v1';
const pendingOffers = () => { try { const v = JSON.parse(localStorage.getItem(PENDING_OFFERS_KEY)); return Array.isArray(v) ? v.filter(p => p && typeof p.id === 'string' && Date.now() - p.at < 30 * 60e3 && p.net === net() && p.swapId === S.swap?.swapId && !S.swap?.offers.some(o => o.id === p.id)) : []; } catch { return []; } };
const addPendingOffer = p => { try { localStorage.setItem(PENDING_OFFERS_KEY, JSON.stringify([...pendingOffers(), p].slice(-20))); } catch { /* private mode */ } };
const BTC_USED_KEY = 'zp-wallet.btc-scripts.v1';
const usedScripts = () => { try { const v = JSON.parse(localStorage.getItem(BTC_USED_KEY)); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
const rememberScripts = xs => { try { localStorage.setItem(BTC_USED_KEY, JSON.stringify([...new Set([...usedScripts(), ...xs])].slice(-500))); } catch { /* private mode */ } };
const swapState = o => takingBack(o) ? 'Taking back: waits for its block (about 4 minutes)' : o.payment?.proof ? 'Paid: the ZP went to the buyer' : o.payment ? `Buyer paid, ${o.payment.confs ?? 0} of ${o.payment.need} confirmations` : o.state === 'reserved' ? `Reserved until block ${Number(o.until).toLocaleString('en-US')}` : o.state === 'expired' ? ((S.swap?.zpTip ?? 0) + 1 < backFrom(o) ? `A reservation expired: open again; you can take it back from block ${backFrom(o).toLocaleString('en-US')}` : 'A reservation expired: open again') : 'Open';
function swapCard() {
  if (!siteBase()) return '<div class="card"><p class="muted small">ZP ⇄ BTC needs the community node, which serves the swap next to it.</p></div>';
  const sw = S.swap;
  if (!sw) return `<div class="card"><p class="muted small">${esc(S.swapError || 'Loading…')}</p></div>`;
  const me = mySellers(), mine = sw.offers.filter(o => me.has(o.seller)), a = active(), can = !!(a && S.open.get(a.id) && canSpend(S.open.get(a.id)));
  const waiting = pendingOffers().map(p => `<div class="item"><div><div>${esc(formatZP(BigInt(p.amount)))} ZP for ${esc(formatBTC(p.sats))} BTC</div>
        <div class="small">${esc(rateText(p.sats, BigInt(p.amount)))}</div>
        <div class="muted small"><span class="spin"></span> Sent: waiting for the next block (about 4 minutes), then it is in the market</div></div></div>`).join('');
  return `<div class="card"><div class="row" data-s="between"><h2>Your offers</h2><button class="btn primary small" data-s="fixed" data-act="swap-new" ${can ? '' : 'disabled'}>New offer</button></div>
    <div class="list">${waiting}${mine.length ? mine.map(o => `<div class="item"><div><div>${esc(formatZP(BigInt(o.amount)))} ZP for ${esc(formatBTC(o.sats))} BTC</div>
        <div class="small">${esc(rateText(o.sats, BigInt(o.amount)))}</div>
        <div class="muted small">${esc(swapState(o))} · ${esc(me.get(o.seller).name)}</div><div class="muted small">${o.scripts - o.used} of ${o.scripts} Bitcoin addresses unused</div></div>
        ${canTakeBack(o) ? `<button class="btn small" data-act="swap-cancel" data-id="${esc(o.id)}">Take back</button>` : ''}</div>`).join('')
      : waiting ? '' : '<p class="muted small">You have no offers. Sell ZP for bitcoin: the buyer pays straight to your Bitcoin address.</p>'}</div>
    ${S.modal ? '' : errBox()}</div>
    <div class="card"><div class="kv"><span>Offers in the market</span><span class="amt">${sw.offers.length}</span></div>
      <p class="muted small" data-s="mt10">Buyers reserve and pay on the <a href="${esc(siteBase())}/swap.html" rel="noopener">ZP ⇄ BTC page</a>.</p>
      <details class="how"><summary>How a sale works</summary><p class="muted small">Your ZP waits in a contract. A buyer reserves the offer (about 80 minutes up to 0.01 BTC, 2 hours up to 0.1 BTC, 4 hours above) and pays bitcoin to your Bitcoin address; the contract checks the payment on Bitcoin and releases the ZP to the buyer. You can take an offer back while it is not reserved, and from 10 blocks after a reservation ends (a payment slow to confirm can still arrive).</p></details></div>`;
}

// ---------------------------------------------------------------- creating contracts (the V1 contract engine)
// The site's engine (/engine/, zp-contracts-v1 docs/SERVICE.md) makes and checks a contract; the wallet shows the source
// and the tests, computes the contract id itself, and signs the activation with the user's key.
const engine = () => siteBase() ? new EngineClient(siteBase()) : null;
// the job being made survives a reload: the engine keeps a job's result for a day
const CC_KEY = 'zp-wallet.cc.v1', CC_KEEP_MS = 23 * 3600e3;
const savedCc = () => { try { const x = JSON.parse(localStorage.getItem(CC_KEY))?.[net()]; return x && /^[0-9a-f]{8,64}$/.test(x.jobId) && Date.now() - x.at < CC_KEEP_MS ? x : null; } catch { return null; } };
function saveCc(x) { try { const all = JSON.parse(localStorage.getItem(CC_KEY) || '{}') || {}; if (x) all[net()] = x; else delete all[net()]; localStorage.setItem(CC_KEY, JSON.stringify(all)); } catch { /* private mode */ } }
async function loadEngine() {
  const e = engine(); if (!e) { S.engine = { error: 'Creating contracts needs the community node, which serves the contract engine.' }; return render(); }
  try {
    const [f, h] = await Promise.all([e.families(), e.health().catch(() => null)]);
    S.engine = { families: Array.isArray(f) ? f.filter(x => x && typeof x.id === 'string' && x.params && typeof x.params === 'object') : [], ask: h?.ask && typeof h.ask === 'object' ? h.ask : null };
  } catch { S.engine = { error: 'The contract engine is not available on this network yet.' }; }
  render();
  const s = !S.cc && S.engine.families && savedCc();
  if (s) {
    const family = s.familyId ? S.engine.families.find(x => x.id === s.familyId) : null;
    if (s.kind === 'make' && !family) return saveCc(null);
    S.cc = { step: 'job', kind: s.kind, jobId: s.jobId, job: null, family, values: s.values || {}, text: s.text || '' }; render();
    ccFollow(s.jobId);
  }
}
// the engine's families as cards: an icon, the name, what it does in one line (the family's own first sentence when
// the wallet has no shorter line for it), and a chevron
const FAMILY_UI = {   // [icon, what it does, plain name]
  escrow: ['<path d="M12 3l8 4v5c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V7z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>', 'Holds money for a sale until the buyer or an arbiter releases it', "Escrow"],
  swap: ['<path d="M5 8h12l-3-3"/><path d="M19 16H7l3 3"/>', 'Sell one asset for another at your price; you are paid directly', "Fixed-rate swap"],
  'timelock-vault': ['<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', 'Anyone deposits; only the owner withdraws, from a given block', "Time-locked vault"],
  token: ['<circle cx="12" cy="12" r="8"/><path d="M9 12h6M12 9v6"/>', 'Your own token, sold 1:1 for ZP and bought back', "Token"],
  vote: ['<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/>', "Holders vote by amount; their tokens come back after the close", "Holders' vote"],
};
// what each family does, in plain words (the engine's description stays under "Technical description")
const FAMILY_HOW = {
  escrow: ['The buyer locks money in the contract.', 'The buyer or the arbiter can release it to the seller.', 'The seller or the arbiter can refund it to the buyer; from the refund block on, anyone can.', 'The arbiter only decides: it is never paid.'],
  swap: ['You put in what you sell (its stock).', 'Anyone buys at your fixed price: the payment goes straight to you, the bought amount comes from the stock.', 'Only you can take the stock back.'],
  'timelock-vault': ['Anyone can put ZP in.', 'From the unlock block on, ZP can be paid out, and only to the owner.', 'Before it, nothing can leave.'],
  token: ["Creates the contract's own token.", 'Anyone buys it 1:1 with ZP; the ZP stays in the contract.', 'Sending the token back returns the same amount of ZP.'],
  vote: ['Holders vote by sending tokens with their choice; each choice counts the amount sent for it.', 'The tokens stay locked until the close, so each holder votes once; voters get receipts.', 'From the closing block, receipts are returned for the tokens 1:1.'],
};
// the form's fields in plain words: label, help, an example in the empty field, and what to fill in for you
const PARAM_UI = {
  'escrow.buyer': { label: "Buyer's public key", help: 'Gets a refund; can release the money to the seller.', ph: 'Paste a public key: 66 characters, starts with 02 or 03' },
  'escrow.seller': { label: "Seller's public key", help: 'Gets the money when it is released; can refund the buyer.', ph: 'Paste a public key: 66 characters, starts with 02 or 03' },
  'escrow.arbiter': { label: "Arbiter's public key", help: 'Settles a dispute: can release or refund. Never paid.', ph: 'Paste a public key: 66 characters, starts with 02 or 03' },
  'escrow.asset': { label: 'What it holds', help: 'ZP, or a token (its contract hash).' },
  'escrow.timeout_block': { label: 'Refund to the buyer from block', help: 'From this block on, anyone can return the money to the buyer.', kind: 'block', prefill: 'block' },
  'swap.owner': { label: 'Your public key (the owner)', help: 'Receives every payment; only this key can take the stock back.', ph: 'Paste a public key, or use yours below', prefill: 'mine-key' },
  'swap.pay_asset': { label: 'Buyers pay with', help: 'ZP, or a token (its contract hash).' },
  'swap.sell_asset': { label: 'You sell', help: "A token (its contract hash), or ZP.", ph: 'A token: its contract hash (64 characters)' },
  'swap.price_num': { label: 'Price: buyers get…', help: 'Units of what you sell.', ph: 'e.g. 3' },
  'swap.price_den': { label: '…for every', help: 'Units they pay. Example: 3 and 2 means buyers get 3 for every 2 they pay.', ph: 'e.g. 2' },
  'timelock-vault.owner': { label: 'Owner (who gets the money)', help: 'Withdrawals go only to this address. Filled with yours.', prefill: 'mine-hash' },
  'timelock-vault.unlock_block': { label: 'Unlock at block', help: 'From this block on, the owner can withdraw.', kind: 'block', prefill: 'block' },
  'vote.question': { label: 'Question', help: 'As voters will read it.', ph: 'e.g. Keep accepting V0 activations after the fork?' },
  'vote.options': { label: 'Choices', help: '2 to 8, separated by commas.', ph: 'e.g. yes, no, abstain' },
  'vote.vote_asset': { label: 'Holders vote with', help: 'ZP, or a token (its contract hash).' },
  'vote.close_block': { label: 'Voting closes at block', help: 'Votes are accepted before this block; tokens come back from it.', kind: 'block', prefill: 'block' },
};
const paramUI = (fid, n, p) => PARAM_UI[fid + '.' + n] || { label: n.replace(/_/g, ' ').replace(/^./, x => x.toUpperCase()), help: p.description || '', ph: p.example != null ? 'e.g. ' + p.example : '', kind: /_block$/.test(n) ? 'block' : '' };
// what an asset field offers: ZP, then the tokens the active wallet holds (name or short id, and the balance)
function assetOptions() {
  const a = active(), st = a && S.data.get(a.id)?.state;
  const toks = (st?.assets || []).filter(x => x.asset !== '00' && x.spendable + x.maturing > 0n).map(x => {
    let v; try { v = engineAsset(x.asset); } catch { return null; }
    return { v, label: S.assetNames[x.asset] || 'Token ' + x.asset.slice(8, 16) + '…', bal: (x.spendable + x.maturing).toLocaleString('en-US') };
  }).filter(Boolean);
  return [{ v: 'zp', label: 'ZP' }, ...toks];
}
const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
// a QR code read by the camera (BarcodeDetector): the first public key in it goes into the field
async function startScan() {
  const m = S.modal, video = $app.querySelector('#qr-video'); if (!m || m.type !== 'scan' || !video) return;
  try {
    S.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = S.scanStream; await video.play();
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    while (S.modal === m) {
      const codes = await det.detect(video).catch(() => []);
      const key = codes.map(c => String(c.rawValue).match(/0[23][0-9a-fA-F]{64}/)?.[0]).find(Boolean);
      if (key) { stopScan(); const i = $app.querySelector(`input[name="p_${m.field}"]`); if (i) i.value = key.toLowerCase(); S.modal = null; S.error = ''; return render(); }
      if (codes.length) { const e = $app.querySelector('#qr-msg'); if (e) e.textContent = 'This code holds no public key (66 characters, starting with 02 or 03).'; }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch { stopScan(); if (S.modal === m) { S.modal = null; fail(new Error('The camera could not be opened: allow it in the browser, or paste the key')); } }
}
function stopScan() { S.scanStream?.getTracks().forEach(t => t.stop()); S.scanStream = null; }
const BLOCK_MINUTES = 4;   // about 4 minutes a block, mainnet and testnet
function syncBlockHint(i) { const h = i?.dataset.block && $app.querySelector(`[data-hint="${i.name}"]`); if (h) h.textContent = blockHint(i.value); }
function blockHint(v) {
  const b = Number(String(v).trim()); if (!S.tip || !/^\d+$/.test(String(v).trim())) return S.tip ? `The chain is at block ${S.tip.toLocaleString('en-US')}.` : '';
  const d = b - S.tip; if (d <= 0) return `That block has passed: the chain is at ${S.tip.toLocaleString('en-US')}.`;
  const m = d * BLOCK_MINUTES, t = m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 6) / 10} hours` : `${Math.round(m / 144) / 10} days`;
  return `About ${t} from now (the chain is at block ${S.tip.toLocaleString('en-US')}).`;
}
const famName = f => FAMILY_UI[f?.id]?.[2] || f?.title || f?.id || 'Contract';
const famIcon = d => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const chevron = '<svg class="fam-go" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
function createCard() {
  const E = S.engine, A = E?.ask, askOff = !A || A.enabled === false || A.left === 0;
  const fams = E?.families ? E.families.map(f => {
    const ui = FAMILY_UI[f.id], line = ui?.[1] || String(f.description || '').split(/(?<=\.)\s/)[0];
    return `<button class="fam" data-act="cc-family" data-id="${esc(f.id)}"><span class="fam-ic">${famIcon(ui?.[0] || '<path d="M6 3h9l3 3v15H6z"/><path d="M9 12h6M9 16h6"/>')}</span>
      <span class="fam-txt"><b>${esc(famName(f))}</b><span>${esc(line)}</span></span>${chevron}</button>`;
  }).join('') + `<button class="fam fam-ask" data-act="cc-ask" ${askOff ? 'disabled' : ''}><span class="fam-ic">${famIcon('<path d="M4 20l4-1 11-11-3-3L5 16z"/>')}</span>
      <span class="fam-txt"><b>Describe it… <span class="pill soon">${askOff ? 'Not available yet' : 'experimental'}</span></b><span>${askOff ? 'Say what it should do and a model writes it: coming soon on this network' : `Say what it should do; a model writes it. Read its tests before you activate.${A?.perDay != null ? ` ${Number(A.left ?? 0)} of ${Number(A.perDay)} left today.` : ''}`}</span></span>${askOff ? '' : chevron}</button>` : '';
  return `<div class="card"><h2>Create a contract</h2>
    <p class="muted small">Start from a ready contract. Each one is checked the way a node checks it, and tested, before you sign anything.</p>
    ${!E ? '<p class="muted small">Loading…</p>' : E.error ? `<p class="muted small">${esc(E.error)}</p>` : `<div class="fams" data-s="mt10">${fams}</div>`}
    ${S.cc && ['job', 'result', 'try', 'activate'].includes(S.cc.step) ? `<button class="btn" data-s="mt10" data-act="cc-open">${S.cc.step === 'job' ? 'Your contract is being made…' : 'Back to your last contract'}</button>` : ''}</div>`;
}
const ccStatus = j => !j ? 'Sending…' : j.status === 'queued' ? `Waiting in line${j.position ? ' (' + j.position + ' ahead)' : ''}…` : j.status === 'running' ? (j.kind === 'ask' ? `Writing and checking the contract${j.rounds?.length ? ' (round ' + j.rounds.length + ')' : ''}…` : 'Building, testing and checking the contract…') : '';
function createView() {
  const c = S.cc || {}, back = backBar(c.kind === 'ask' ? 'Describe a contract' : (c.family ? (c.step === 'result' && c.job?.ok ? 'Your ' + famName(c.family).toLowerCase() : famName(c.family)) : 'Create a contract'), 'contracts');
  if (c.step === 'form') {
    const f = c.family, mine = active() && S.open.get(active().id) && canSpend(S.open.get(active().id)) ? signerOf(S.open.get(active().id)) : null;
    const how = FAMILY_HOW[f.id], params = Object.entries(f.params || {});
    const val = (n, p, ui) => c.values?.[n] ?? (ui.prefill === 'mine-hash' && mine ? hex(mine.pkHash) : ui.prefill === 'mine-key' && mine ? hex(mine.publicKey) : ui.prefill === 'block' && S.tip ? String(S.tip + 30) : p.default ?? '');
    const field = ([n, p]) => {
      const ui = paramUI(f.id, n, p), v = val(n, p, ui), isBlock = ui.kind === 'block';
      if (p.type === 'asset') {
        const opts = assetOptions(), other = c.assetOther?.[n] || (v && !opts.some(o => o.v === v));
        return `<div class="pfield"><div class="field">${esc(ui.label)}</div>
          <div class="wrapchips" role="group" aria-label="${esc(ui.label)}">${opts.map(o => `<button type="button" class="chip ${!other && o.v === v ? 'on' : ''}" aria-pressed="${!other && o.v === v}" data-act="cc-asset" data-name="${esc(n)}" data-v="${esc(o.v)}">${esc(o.label)}${o.bal ? ` <span class="muted">· ${esc(o.bal)}</span>` : ''}</button>`).join('')}
            <button type="button" class="chip ${other ? 'on' : ''}" aria-pressed="${!!other}" data-act="cc-asset-other" data-name="${esc(n)}">Other token…</button></div>
          <input id="p_${esc(n)}" name="p_${esc(n)}" class="mono" ${other ? '' : 'hidden'} autocomplete="off" spellcheck="false" placeholder="The token's contract hash (64 characters)" value="${esc(v)}" data-s="mt8">
          ${ui.help ? `<p class="muted small" data-s="mt4">${esc(other ? "Paste the token's contract hash: 64 characters (0-9, a-f)." : ui.help)}</p>` : ''}</div>`;
      }
      return `<div class="pfield"><label class="field" for="p_${esc(n)}">${esc(ui.label)}</label>
        <input id="p_${esc(n)}" name="p_${esc(n)}" autocomplete="off" autocapitalize="off" spellcheck="false" class="${['hash', 'publickey'].includes(p.type) ? 'mono' : ''}" ${isBlock ? 'inputmode="numeric" data-block="1"' : ''} placeholder="${esc(ui.ph || '')}" value="${esc(v)}">
        ${isBlock ? `<div class="small hint" data-hint="p_${esc(n)}">${esc(blockHint(v))}</div>` : ''}
        ${ui.help ? `<p class="muted small" data-s="mt4">${esc(ui.help)}</p>` : ''}
        ${p.type === 'publickey' ? `<div class="wrapchips">${mine ? `<button type="button" class="chip" data-act="cc-fill" data-name="${esc(n)}" data-v="${hex(mine.publicKey)}" title="The key of ${esc(active().name)}">Use my key</button>` : ''}
          <button type="button" class="chip" data-act="cc-paste" data-name="${esc(n)}">Paste</button>${canScan() ? `<button type="button" class="chip" data-act="cc-scan" data-name="${esc(n)}">Scan QR</button>` : ''}</div>` : ''}
        ${mine && p.type === 'hash' ? `<div class="wrapchips"><button type="button" class="chip" data-act="cc-fill" data-name="${esc(n)}" data-v="${hex(mine.pkHash)}" title="The address of ${esc(active().name)}">Use my address</button></div>` : ''}
        ${isBlock && S.tip ? `<div class="wrapchips">${[[15, 'in 1 hour'], [360, 'in 1 day'], [2520, 'in 1 week']].map(([b, l]) => `<button type="button" class="chip" data-act="cc-fill" data-name="${esc(n)}" data-v="${S.tip + b}">${l}</button>`).join('')}</div>` : ''}</div>`;
    };
    return `${back}<form data-form="cc-make" class="screen">
      <div class="card"><h2>What it does</h2>${how ? `<ul class="how-list">${how.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="small">${esc(String(f.description || '').split(/(?<=\.)\s/)[0])}</p>`}</div>
      ${params.length ? `<div class="card"><h2>Fill in</h2>${params.map(field).join('')}</div>`
        : '<div class="card"><p class="small">Nothing to fill in: the contract is ready to make. You can try it before you activate it.</p></div>'}
      ${f.description ? `<details class="how"><summary>Technical description</summary><p class="muted small">${esc(f.description)}</p></details>` : ''}
      ${errBox()}<button class="btn primary big">Make the contract</button>
      <p class="muted small center">Nothing is signed or sent yet: the engine writes and tests it, then you review it.</p></form>${nav('contracts')}`;
  }
  if (c.step === 'ask') return `${back}<form data-form="cc-ask" class="screen">
      <div class="warn">Experimental: an AI model writes the contract and its tests. The engine holds them to the same checks and gas as any contract, but the tests are the model's own: read them before you activate anything.</div>
      <label class="field">What should the contract do?<textarea name="text" rows="5" placeholder="A vault that pays the owner after block 2500" required>${esc(c.text || '')}</textarea></label>
      ${errBox()}<button class="btn primary big">Write the contract</button></form>${nav('contracts')}`;
  if (c.step === 'job') {
    const st = c.job?.status, ask = c.kind === 'ask', step = (n, t, sub) => `<div class="bstep"><span class="bdot ${n}"></span><div><b class="${n === 'todo' ? 'muted' : ''}">${t}</b>${sub ? `<div class="muted small">${sub}</div>` : ''}</div></div>`;
    return `${back}<div class="screen"><div class="card bsteps">
      ${step(st === 'queued' || !st ? 'run' : 'done', st === 'queued' ? `Waiting in line${c.job?.position ? ` (${c.job.position} ahead)` : ''}` : ask ? 'Written by the model' : 'Made from the template', ask ? 'A model writes the contract and its tests.' : '')}
      ${step(st === 'running' ? 'run' : 'todo', 'Checked like a node, and its tests run', 'The same build every node runs; each call on its gas.')}
      ${step('todo', 'Ready to review', '')}</div>
      <p class="muted small">This takes up to a minute${ask ? ' or a few' : ''}. You can leave this screen; the contract waits for you under Contracts for a day.</p>${errBox()}</div>${nav('contracts')}`;
  }
  if (c.step === 'result') return `${back}<div class="screen">${resultHtml(c)}</div>${nav('contracts')}`;
  if (c.step === 'try' && c.try) return tryView();
  if (c.step === 'activate') return activateView();
  if (c.step === 'active' && c.done) return activeView();
  return `${back}<div class="screen"><p class="muted">Nothing to show.</p></div>${nav('contracts')}`;
}
function resultHtml(c) {
  const j = c.job || {};
  if (!j.ok) {
    const why = j.error || j.report?.error || (j.check?.refusal ? j.check.refusal.title : '') || 'The contract could not be made.';
    return `<div class="card"><h2 class="bad">Not made</h2><p class="small">${esc(why)}</p>${j.report?.stage ? `<p class="muted small">Stopped at: ${esc(j.report.stage)}</p>` : ''}${j.check ? refusalHtml(j.check) : ''}
      <button class="btn" data-act="cc-again">Change and try again</button></div>${errBox()}`;
  }
  const src = c.source, id = v1ContractId(src), chk = c.check || j.check || {}, v1h = chk.activation?.v1Height, early = v1h && S.tip != null && S.tip + 1 < v1h;
  const sameAsReport = id.slice(8) === String(j.report?.contractId || '').replace(/^00000001/, '');
  const checked = !c.edited || (c.check && c.checkedSource === src && c.check.verdict === 'accepted');
  const tests = Array.isArray(j.tests) ? j.tests : [], costs = tests.map(t => Number(t.expect?.declaredCost)).filter(n => Number.isFinite(n) && n > 0);
  const canTry = commandsOf(c.family).length && checked && chk.verdict !== 'refused', view = c.view || 'tests';
  const pill = (ok, text) => `<span class="spill ${ok ? 'ok' : ''}"><span class="dot ${ok ? 'ok' : 'bad'}"></span>${esc(text)}</span>`;
  return `<div class="pills">${c.edited && !c.check ? pill(false, 'Your changes are not checked yet') : pill(chk.verdict === 'accepted', chk.verdict === 'accepted' ? 'Made and checked: a node accepts it' : chk.verdict === 'refused' ? 'A node refuses it' : 'Not checked')}
      ${pill(true, `${tests.length} of ${tests.length} tests pass${c.edited ? " (the engine's version)" : ''}`)}</div>
    <div class="card"><div class="kv"><span class="muted">Contract id</span><span class="ok small">${sameAsReport || c.edited ? '✓ computed in your wallet' : ''}</span></div>
      <div class="mono small" data-s="wrap">${esc(id)}</div>
      ${costs.length ? `<div class="kv"><span class="muted">Each call</span><span>${esc(Math.min(...costs) === Math.max(...costs) ? Math.min(...costs).toLocaleString('en-US') : Math.min(...costs).toLocaleString('en-US') + '–' + Math.max(...costs).toLocaleString('en-US'))} gas · no fee required</span></div>` : ''}
      <div class="kv"><span class="muted">To activate</span><span>${src.length.toLocaleString('en-US')} kalapas per block</span></div>
      ${!sameAsReport && !c.edited ? '<p class="bad small">The id of this source differs from the engine\'s report: do not use it.</p>' : ''}</div>
    ${c.kind === 'ask' ? `<div class="warn">Written by an AI model${Array.isArray(j.rounds) ? ` in ${j.rounds.length} round${j.rounds.length === 1 ? '' : 's'}` : ''}. Its tests are its own: read them, and the source, before activating.</div>` : ''}
    <div class="seg" role="tablist"><button class="chip ${view === 'tests' ? 'on' : ''}" role="tab" aria-selected="${view === 'tests'}" data-act="cc-view" data-v="tests">Tests</button><button class="chip ${view === 'source' ? 'on' : ''}" role="tab" aria-selected="${view === 'source'}" data-act="cc-view" data-v="source">Source${c.edited ? ' · edited' : ''}</button></div>
    ${view === 'tests' ? `<div class="card"><div class="list">${tests.map(t => `<div class="item"><div class="tline"><span class="ok">✓</span><span>${esc(t.name || t.command || 'test')}<span class="muted small"> · expects ${t.expect?.ok === false ? 'a refusal' : 'success'}</span></span></div></div>`).join('') || '<p class="muted small">None.</p>'}</div></div>`
    : `<div class="card">${c.editing ? `<form data-form="cc-check" class="screen" data-s="flush"><textarea name="source" rows="16" class="mono" spellcheck="false">${esc(src)}</textarea>
          <div class="row"><button class="btn">Check my changes</button><button type="button" class="btn" data-act="cc-reset">Undo changes</button></div></form>`
        : `<pre class="src">${esc(src)}</pre><button class="btn small" data-act="cc-edit">Edit</button>`}
      ${c.check && c.edited ? (c.check.verdict === 'accepted' ? '<p class="ok small">✓ A node accepts the changed source.</p>' : refusalHtml(c.check)) : ''}</div>`}
    ${errBox()}
    ${early ? `<p class="muted small">V1 contracts open at block ${Number(v1h).toLocaleString('en-US')}; the node is at ${Number(S.tip).toLocaleString('en-US')}.</p>` : !checked ? '<p class="muted small">Check the changed source before activating it.</p>' : ''}
    <div class="row bottom">${canTry ? '<button class="btn" data-act="cc-try-open">Try it</button>' : ''}<button class="btn primary" data-act="cc-activate-open" ${early || !checked ? 'disabled' : ''}>Activate…</button></div>`;
}
// ---- activating: how long, what it costs, the balance; signed here
const DURATIONS = [[2520, '1 week'], [10800, '1 month'], [131400, '1 year']];   // at about 4 minutes a block
function activateView() {
  const c = S.cc, a = active(), w = a && S.open.get(a.id), d = a && S.data.get(a.id);
  const blocks = Number(c.blocks || 10800), custom = !DURATIONS.some(([b]) => b === blocks) || c.customBlocks;
  const cost = activationCost(c.source, Number.isSafeInteger(blocks) && blocks > 0 ? blocks : 0), zp = d?.state?.assets?.find(x => x.asset === '00');
  const bal = zp ? zp.spendable : null, short = bal !== null && bal < cost;
  const id = v1ContractId(c.source), expect = String(c.edited ? c.check?.contractId : c.job?.report?.contractId || '').replace(/^00000001/, '');
  const afford = bal !== null && c.source.length ? Number(bal / BigInt(c.source.length)) : 0;
  return `${backBarAct('Activate', 'cc-activate-back')}<form data-form="cc-activate" class="screen">
    <div class="small muted">Keep it active for</div>
    <div class="tabs4">${DURATIONS.map(([b, l]) => `<button type="button" class="chip ${!custom && blocks === b ? 'on' : ''}" data-act="cc-blocks" data-v="${b}">${l}</button>`).join('')}<button type="button" class="chip ${custom ? 'on' : ''}" data-act="cc-blocks" data-v="custom">Blocks…</button></div>
    ${custom ? `<label class="field">Blocks<input name="blocks" inputmode="numeric" autocomplete="off" value="${esc(String(blocks))}"></label>` : `<input type="hidden" name="blocks" value="${blocks}">`}
    <p class="muted small">${blocks.toLocaleString('en-US')} blocks${dateAfter(blocks) ? `, until around ${dateAfter(blocks)}` : ''}. You can extend it later.</p>
    <div class="card"><div class="kv"><span class="muted">Activation</span><span>${formatZP(cost)} ZP</span></div>
      <div class="kv"><span class="muted">Network fee</span><span>None</span></div>
      <div class="kv"><b>Total</b><b>${formatZP(cost)} ZP</b></div>
      <div class="kv"><span class="muted">Your balance (${esc(a?.name || '–')})</span><span class="${short ? 'bad' : 'ok'}">${bal === null ? '–' : formatZP(bal) + ' ZP' + (short ? '' : ' · enough')}</span></div></div>
    <p class="muted small">${c.source.length.toLocaleString('en-US')} characters × ${blocks.toLocaleString('en-US')} blocks × 1 kalapa.</p>
    ${short ? `<div class="err" role="alert"><span class="err-ic" aria-hidden="true">!</span><div><b>Not enough ZP</b><div class="err-more">You need about ${formatZP(cost - bal)} ZP more to activate it for this long. Activate it for fewer blocks, or add ZP to this wallet first.</div></div></div>
      <div class="row">${afford > 0 ? `<button type="button" class="btn" data-act="cc-blocks" data-v="${afford}">Fewer blocks</button>` : ''}<button type="button" class="btn" data-go="receive">Receive ZP</button></div>
      <p class="muted small">The contract stays here, made and checked, for a day.</p>` : ''}
    <div class="card small"><div class="tline"><span class="ok">✓</span><span>${expect === id.slice(8) ? `The id matches the source you reviewed (${esc(id.slice(8, 16))}…${esc(id.slice(-8))})` : 'The wallet computed the id from the source you reviewed'}</span></div>
      <div class="tline"><span class="ok">✓</span><span>You sign here, with your key. Nothing goes through the engine service.</span></div></div>
    ${errBox()}<button class="btn primary big" ${short || !w || !canSpend(w) ? 'disabled' : ''} ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and activate'}</button></form>${nav('contracts')}`;
}
// ---- after activation: the address to share, its QR, how it is used
function activeView() {
  const c = S.cc, x = c.done, f = c.family, cmds = commandsOf(f);
  const q = qrcode(0, 'M'); q.addData(x.address); q.make();
  const live = S.contracts?.find(k => k.address === x.address), until = live ? Number(live.expire) : x.until;
  return `${backBarAct(x.name, 'cc-active-done')}<div class="screen">
    <div class="bigcheck">${icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>')}</div>
    <h2>${live ? `Your ${esc(x.name.toLowerCase())} is active` : `Your ${esc(x.name.toLowerCase())} is sent`}</h2>
    <p class="muted small">${live ? '' : 'It becomes active with the next block (about 4 minutes). '}Active until block ${until ? Number(until).toLocaleString('en-US') : '–'}${until && S.tip && dateAfter(until - S.tip) ? `, around ${dateAfter(until - S.tip)}` : ''}.</p>
    <div class="card"><div class="muted small">Address (send to it, share it)</div><div class="mono small" data-s="wrap">${esc(x.address)}</div>
      <div class="muted small" data-s="mt10">Contract id</div><div class="mono small" data-s="wrap">${esc(x.id)}</div></div>
    <div class="row"><button class="btn" data-act="cc-share" data-text="${esc(x.address)}">Share</button><button class="btn" data-act="cc-qr">${c.showQr ? 'Hide QR' : 'Show QR'}</button></div>
    ${c.showQr ? `<div class="qr">${q.createSvgTag({ cellSize: 5, margin: 2, scalable: false })}</div>` : ''}
    ${cmds.length ? `<div class="card"><h2>How it is used</h2><div class="list">${cmds.map(m => `<div class="item"><span><b>${esc(m.name[0].toUpperCase() + m.name.slice(1))}</b>${m.description ? `: ${esc(m.description.replace(/\.$/, ''))}` : ''}</span><span class="muted small" data-s="right">${esc(m.signedBy.length ? m.signedBy.join(', ') : 'anyone')}</span></div>`).join('')}</div>
      ${cmds.some(m => m.signedBy.length) ? '<p class="muted small">Share the address with the others named here: they call it from their own wallets.</p>' : ''}</div>` : ''}
    <button class="btn primary big" data-act="cc-active-done">Done</button></div>${nav('contracts')}`;
}
const backBarAct = (title, act) => `<div class="back"><button class="iconbtn" data-act="${act}" aria-label="Back">${I.back}</button><h1>${esc(title)}</h1></div>`;
// ---- the contracts this wallet activated (kept by address), and one made but not activated yet
function myContractsCard() {
  const mine = Object.entries(myContracts()), tip = S.tip || 0, c = S.cc;
  const made = c && c.job?.ok && ['result', 'try', 'activate'].includes(c.step) && !c.activated;
  if (!mine.length && !made) return '';
  const rows = mine.reverse().map(([addr, x]) => {
    const live = S.contracts?.find(k => k.address === addr), until = live ? Number(live.expire) : x.until, left = until ? until - tip : null;
    const ended = !live && until && tip > until, soon = live && left < 720, waiting = !live && !ended;
    const status = ended ? `<span class="muted small">Ended at block ${until.toLocaleString('en-US')}</span>` : waiting ? '<span class="muted small">Waiting for its block</span>'
      : soon ? `<span class="small lvl-warn">Ends in ${dateIn(left)}</span>` : '<span class="small"><span class="dot ok"></span> Active</span>';
    const i = S.contracts?.findIndex(k => k.address === addr) ?? -1;
    return `<div class="mc ${soon ? 'warn-line' : ''}"><div class="between"><b>${esc(x.name)}</b>${status}</div>
      <div class="muted small">${ended ? 'No longer runs. Extending it starts it again.' : until ? `Until block ${until.toLocaleString('en-US')}${left > 0 && dateIn(left) ? `, about ${dateIn(left)}` : ''}` : ''}</div>
      ${ended ? '' : `<div class="row"><button class="btn small" data-act="cc-open-mine" data-addr="${esc(addr)}">Open</button>${i >= 0 ? `<button class="btn small ${soon ? 'accent' : ''}" data-act="extend" data-i="${i}">Extend</button>` : ''}</div>`}</div>`;
  }).join('');
  return `<div class="card"><h2>My contracts</h2><div class="mcs">${made ? `<div class="mc"><div class="between"><b>${esc(c.family ? famName(c.family) : 'Described contract')}</b><span class="muted small">Made, not active</span></div>
      <div class="muted small">Checked and tested · kept for a day</div><div class="row"><button class="btn small" data-act="cc-open">Review</button><button class="btn small primary" data-act="cc-activate-open">Activate</button></div></div>` : ''}${rows}</div></div>`;
}
const dateIn = blocks => { const m = blocks * BLOCK_MINUTES; return m < 90 ? `${Math.max(1, Math.round(m))} min` : m < 2880 ? `${Math.round(m / 60)} hours` : m < 60 * 24 * 60 ? `${Math.round(m / 1440)} days` : `${Math.round(m / 43200)} months`; };
function refusalHtml(chk) {
  if (chk.verdict === 'environment') return '<div class="warn"><b>Couldn\'t check it right now</b><br>The checking service had a problem of its own. This says nothing about your contract: try again later.</div>';
  const r = chk.refusal; if (!r) return chk.nodeMessage ? `<p class="bad small">${esc(chk.nodeMessage)}</p>` : '';
  return `<div class="card" data-s="mt10"><p class="bad"><b>A node would refuse it: ${esc(r.title || r.rule || '')}</b>${r.line ? ` · line ${esc(r.line)}` : ''}</p>
    ${r.code ? `<pre class="src">${esc(r.code)}</pre>` : ''}${r.why ? `<p class="small">${esc(r.why)}</p>` : ''}${r.fix ? `<p class="small"><b>Fix:</b> ${esc(r.fix)}</p>` : ''}${r.hint ? `<p class="muted small">${esc(r.hint)}</p>` : ''}
    ${r.right ? `<p class="muted small">For example: <code>${esc(r.right)}</code></p>` : ''}</div>`;
}
// run a job on the engine and show it here while it runs
async function ccRun(kind, start) {
  const e = engine(); if (!e) throw new Error('No contract engine on this network');
  const res = await start(e);
  S.cc = { ...S.cc, step: 'job', kind, jobId: res.job, job: null }; S.error = ''; render();
  saveCc({ kind, jobId: res.job, familyId: S.cc.family?.id, values: S.cc.values, text: S.cc.text, at: Date.now() });
  if (kind === 'ask' && S.engine?.ask?.left > 0) S.engine.ask.left--;
  await ccFollow(res.job);
}
async function ccFollow(id) {
  const e = engine(); let j;
  try { j = await e.wait(id, x => { if (S.cc?.jobId === id) { S.cc.job = x; if (S.screen === 'create' && S.cc.step === 'job') render(); } }, { stopped: () => S.cc?.jobId !== id }); }
  catch (err) {
    if (err.status === 404) { saveCc(null); if (S.cc?.jobId === id) S.cc = { ...S.cc, step: 'result', job: { ok: false, error: 'The engine no longer has this contract (results are kept for a day). Make it again.' } }; return render(); }
    if (S.cc?.jobId === id) { S.cc = { ...S.cc, step: 'result', job: { ok: false, error: err.message } }; render(); } return;
  }
  if (!j || S.cc?.jobId !== id) return;
  if (j.status !== 'done') { S.cc = { ...S.cc, step: 'result', job: { ok: false, error: j.error || (j.status === 'timeout' ? 'The engine took too long.' : 'The engine could not run.') } }; return render(); }
  S.cc = { ...S.cc, step: 'result', job: j, source: typeof j.source === 'string' ? j.source : '', edited: false, check: null, editing: false, try: null };
  if (j.ok && !S.cc.source) S.cc.job = { ok: false, error: 'The engine returned no source.' };
  render();
}

// ---------------------------------------------------------------- trying calls (no real money: the engine runs the call as a node would)
const keyRoles = c => Object.fromEntries(Object.entries(c.family?.params || {}).filter(([n, p]) => p.type === 'publickey' && /^0[23][0-9a-f]{64}$/i.test(String(c.values?.[n] || ''))).map(([n]) => [n, String(c.values[n]).toLowerCase()]));
const ccAsset = c => String(c.values?.asset || c.family?.params?.asset?.default || 'zp').toLowerCase();
function whoLabel(w) {
  if (!w || typeof w !== 'object') return 'someone';
  if (w.self) return 'this contract';
  if (w.role) return 'the ' + w.role;
  if (w.kind === 'fee') return 'the fee'; if (w.kind === 'destroy') return 'destroyed'; if (w.kind === 'mint') return 'newly minted';
  const h = String(w.hash || ''); return (w.kind === 'contract' ? 'contract ' : 'key ') + (h ? h.slice(0, 8) + '…' : '');
}
const ccHash = c => (c.tryId || v1ContractId(c.source)).replace(/^00000001/, '');
const myKey = () => { const a = active(), w = a && S.open.get(a.id); return w && canSpend(w) ? signerOf(w) : null; };
const choicesOf = (c, cmd) => Object.fromEntries(cmd.body.filter(([, f]) => f.type === 'choice' && f.of).map(([n, f]) => [n, String(c.values?.[f.of] || '').split(',').map(x => x.trim()).filter(Boolean)]));
const WINDOW_TEXT = { from: b => `Works from block ${b} on.`, until: b => `Works only before block ${b}.`, anyoneFrom: b => `From block ${b} on, anyone can call it.` };
function tryView() {
  const c = S.cc, T = c.try, cmds = commandsOf(c.family), cmd = cmds.find(x => x.name === T.cmd) || cmds[0];
  const roles = keyRoles(c), held = holdings(T.session.wallet), L = T.last, me = myKey();
  const wins = cmd ? windowsOf(cmd, c.values) : [], open = !cmd?.signedBy.length;
  const signers = [...Object.keys(roles).map(r => [r, 'the ' + r + (open || cmd.signedBy.includes(r) ? '' : wins.some(w => w.kind === 'anyoneFrom') ? ' (only after the timeout)' : ' (not allowed)')]), ['', open ? 'anyone (unsigned)' : 'nobody (unsigned)']];
  const sel = T.signer ?? (open ? '' : cmd?.signedBy.find(r => r in roles) ?? '');
  const asset = cmd ? sendsAsset(cmd, c.values, c.family, ccHash(c)) : null, choices = cmd ? choicesOf(c, cmd) : {};
  const block = T.block ?? (S.tip || 0) + 1;
  const field = ([n, f]) => {
    const val = T.values['t_' + n] ?? (f.type === 'address' && me ? hex(me.pkHash) : '');
    const input = f.type === 'choice' && choices[n]?.length
      ? `<select name="t_${esc(n)}">${choices[n].map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input name="t_${esc(n)}" autocomplete="off" spellcheck="false" class="${f.type === 'address' ? 'mono' : ''}" placeholder="${f.type === 'amount' ? (asset && asset !== 'zp' ? 'units' : '2.5 ZP') : ''}" value="${esc(val)}">`;
    return `<label class="field">${esc(n)}${input}</label>${f.description ? `<p class="muted small" data-s="mt4">${esc(f.description)}${f.type === 'address' && me ? ' (your address by default)' : ''}</p>` : ''}`;
  };
  const out = !L ? '' : L.check ? `<div class="card">${refusalHtml(L.check)}</div>` : `<div class="card"><div class="between"><h2>What happens</h2><span class="pill ${L.ok ? 'ok' : 'bad'}">${L.ok ? 'OK' : 'Refused'}</span></div>
      ${L.ok ? (L.moves.length ? `<div class="list">${L.moves.map(m => { const n = BigInt(String(m.change)); return `<div class="item"><div>${esc(whoLabel(m.who))} ${n < 0n ? 'pays' : 'gets'} <b>${esc(formatAmount(n < 0n ? -n : n, m.asset))}</b></div></div>`; }).join('')}</div>` : '<p class="muted small">Nothing moves.</p>')
        : `<p class="bad small">${esc(L.error || 'The contract refused the call.')}</p><p class="muted small">Nothing moves.</p>`}
      <div class="kv"><span class="muted">Gas</span><span>${esc(L.declared ?? '–')} declared · ${esc(L.used ?? '–')} used</span></div>
      <div class="kv"><span class="muted">At block</span><span>${esc(Number(L.block).toLocaleString('en-US'))}</span></div>
      ${L.ok && (L.inputs.length || L.outputs.length) ? `<details class="how"><summary>Details</summary>
        <p class="muted small"><b>In</b></p>${L.inputs.map(x => `<p class="small">${esc(whoLabel(x.who))} · ${esc(formatAmount(x.amount, x.asset))}</p>`).join('') || '<p class="muted small">none</p>'}
        <p class="muted small"><b>Out</b></p>${L.outputs.map(x => `<p class="small">${esc(whoLabel(x.who))} · ${esc(formatAmount(x.amount, x.asset))}</p>`).join('') || '<p class="muted small">none</p>'}</details>` : ''}</div>`;
  return `<div class="back"><button class="iconbtn" data-act="cc-try-back" aria-label="Back">${I.back}</button><h1>${esc('Try ' + (c.family ? famName(c.family) : 'the contract'))}</h1></div><div class="screen">
    <p class="muted small">No real money: the engine runs each call as a node would. Calls in a row build on each other.</p>
    <div class="wrapchips">${cmds.map(x => `<button class="chip ${x.name === cmd?.name ? 'on' : ''}" aria-pressed="${x.name === cmd?.name}" data-act="cc-cmd" data-name="${esc(x.name)}">${esc(x.name)}</button>`).join('')}</div>
    ${cmd ? `<form data-form="cc-try" class="card">${cmd.description ? `<p class="muted small">${esc(cmd.description)}</p>` : ''}
      <label class="field">Signed by<select name="signer">${signers.map(([v, t]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      ${asset ? `<label class="field">Sends in (${esc(asset === 'zp' ? 'ZP' : cmd.sends === 'self' ? 'its own token' : assetLabel(tryAsset(asset)))})<input name="spend" autocomplete="off" inputmode="decimal" placeholder="${asset === 'zp' ? '2.5 ZP' : 'units'}" value="${esc(T.values.spend ?? '')}"></label>` : ''}
      ${cmd.body.map(field).join('')}
      <label class="field">At block<input name="block" inputmode="numeric" autocomplete="off" value="${esc(block)}"></label>
      ${wins.length ? `<p class="muted small">${wins.map(w => esc(WINDOW_TEXT[w.kind](w.block.toLocaleString('en-US')))).join(' ')}</p>
        <div class="wrapchips">${wins.flatMap(w => [w.block - 1, w.block]).filter((b, i, a) => b >= 1 && a.indexOf(b) === i).map(b => `<button type="button" class="chip mini ${b === Number(block) ? 'on' : ''}" data-act="cc-block" data-v="${b}">block ${b.toLocaleString('en-US')}</button>`).join('')}<button type="button" class="chip mini" data-act="cc-block" data-v="${(S.tip || 0) + 1}">next block</button></div>` : ''}
      <p class="muted small">${held.length ? 'The contract holds ' + held.map(h => esc(formatAmount(h.amount, h.asset))).join(', ') + ' in this session.' : 'The contract holds nothing yet in this session.'}</p>
      ${errBox()}${T.running ? `<p><span class="spin"></span> Running the call…</p>` : `<div class="row"><button class="btn primary">${L ? 'Run' : 'Run the call'}</button>${T.runs ? '<button type="button" class="btn" data-act="cc-try-reset">Start over</button>' : ''}</div>`}</form>` : '<p class="muted">The engine lists no commands for this contract.</p>'}
    ${out}</div>${nav('contracts')}`;
}
async function ccTry(v) {
  const c = S.cc, T = c.try, cmds = commandsOf(c.family), cmd = cmds.find(x => x.name === T.cmd) || cmds[0], roles = keyRoles(c);
  T.values = { ...v }; T.signer = v.signer ?? '';
  const blk = String(v.block ?? '').trim(); if (!/^\d+$/.test(blk) || +blk < 1 || +blk > 4294967295) throw new Error('At block: a block number'); T.block = +blk;
  const call = { command: cmd.name, wallet: T.session.wallet, ...(T.session.state != null ? { state: T.session.state } : {}), context: { blockNumber: T.block, timestamp: String(Date.now()) } };
  if (T.signer) { if (!roles[T.signer]) throw new Error('Fill in that key first'); call.sender = { publicKey: roles[T.signer] }; }
  const asset = sendsAsset(cmd, c.values, c.family, ccHash(c)), sp = String(v.spend || '').trim();
  if (asset && sp) call.spend = [{ asset: tryAsset(asset), amount: asset === 'zp' ? kalapasOf(sp, 'Sends in') : /^\d+$/.test(sp) ? sp : (() => { throw new Error('Sends in: a whole number of units'); })() }];
  const bh = bodyHexOf(cmd.body, Object.fromEntries(cmd.body.map(([n]) => [n, v['t_' + n]])), { choices: choicesOf(c, cmd) }); if (bh) call.bodyHex = bh;
  const e = engine(), sourceId = c.edited ? c.check?.contractId : (c.tryId || c.job?.report?.contractId);
  T.running = true; S.error = ''; render();
  try {
    const res = await e.try({ source: c.source, sourceId: sourceId ? (String(sourceId).length === 64 ? '00000001' + sourceId : String(sourceId)) : null, call, roles });
    const j = await e.wait(res.job, null, { stopped: () => S.cc !== c });
    if (!j || S.cc !== c) return;
    if (j.status !== 'done') throw new Error(j.error || 'The engine could not run the call: try again');
    if (j.check && !j.try) { T.last = { check: j.check }; T.runs++; return; }
    const t = j.try || {}, r = t.result || {};
    if (typeof t.contract === 'string') c.tryId = t.contract;
    T.last = { ok: !!r.ok, error: r.error, declared: r.declaredCost, used: r.gasUsed, block: T.block, moves: Array.isArray(t.moves) ? t.moves : [], inputs: Array.isArray(r.inputs) ? r.inputs : [], outputs: Array.isArray(r.outputs) ? r.outputs : [] };
    if (t.next && typeof t.next === 'object') T.session = { wallet: Array.isArray(t.next.wallet) ? t.next.wallet : [], state: t.next.state ?? null };
    T.runs++;
  } finally { T.running = false; render(); }
}

function fail(e) {
  S.error = e?.message || String(e); S.errField = e?.field || null; S.busy = false; render();
  const box = $app.querySelector('.modal .err, .err'); box?.scrollIntoView?.({ block: 'center' }); box?.focus?.({ preventScroll: true });
}   // the message may sit below the button that was pressed

// ---------------------------------------------------------------- views
const top = () => `<div class="top"><span class="brand">ZP Wallet</span>
  <span class="row" data-s="fixed gap6">${net() === 'test' ? '<span class="pill test">TESTNET</span>' : ''}
  <span class="pill" title="${esc(S.settings.nodes[net()])}"><span class="dot ${S.nodeOk === true ? 'ok' : S.nodeOk === false ? 'bad' : ''}"></span>${S.nodeOk === false ? 'Node offline' : S.tip ? 'Block ' + esc(S.tip.toLocaleString('en-US')) : 'Connecting…'}</span></span></div>`;
const backBar = (title, to = 'home') => `<div class="back"><button class="iconbtn" data-go="${to}" aria-label="Back">${I.back}</button><h1>${esc(title)}</h1></div>`;
// an error is a box that cannot be missed: an icon, its first part in bold ("Use a new Bitcoin address for each line"),
// the details under it; the field it is about is marked too (S.errField, from an Error's .field)
const errBox = () => {
  if (!S.error) return '';
  const i = S.error.indexOf(': '), head = i > 0 && i < 80 ? S.error.slice(0, i) : S.error, rest = i > 0 && i < 80 ? S.error.slice(i + 2) : '';
  return `<div class="err" role="alert" tabindex="-1"><span class="err-ic" aria-hidden="true">!</span><div><b>${esc(head)}</b>${rest ? `<div class="err-more">${esc(rest)}</div>` : ''}</div></div>`;
};
const fieldError = (message, field) => Object.assign(new Error(message), { field });
const nav = cur => `<nav class="nav">${[['home', 'Wallet', I.home], ['markets', 'Markets', I.chart], ['vote', 'Vote', I.vote], ['contracts', 'Contracts', I.doc], ['settings', 'Settings', I.gear]]
  .map(([k, l, i]) => `<button data-go="${k}" class="${cur === k ? 'on' : ''}">${i}${l}</button>`).join('')}</nav>`;

// password field with a Show/Hide button; the type is switched in place so nothing typed is lost
const pwField = (label, name, ac, extra = '') => `<label class="field">${label}<span class="pwrow"><input type="password" name="${name}" autocomplete="${ac}" ${extra}><button type="button" class="pwtoggle" data-act="toggle-pw" aria-pressed="false" aria-label="Show password">Show</button></span></label>`;

const views = {
  welcome: () => `<div class="screen" data-s="center">
    <h1 data-s="title">ZP Wallet</h1>
    <p class="muted">A wallet for the ZP network. Your recovery phrase and keys stay on this device, encrypted with a password you choose. Nobody, including the node, ever sees them.</p>
    <form data-form="create-vault" class="screen" data-s="flush">
      ${pwField('Choose a password for this device (at least 8 characters)', 'p1', 'new-password', 'required minlength="8"')}
      ${pwField('Repeat it', 'p2', 'new-password', 'required minlength="8"')}
      <div class="warn">The password only unlocks this browser. It cannot recover your coins: keep your 24 words on paper.</div>
      ${errBox()}<button class="btn primary big" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Continue'}</button>
    </form></div>`,

  unlock: () => `<div class="screen" data-s="center">
    <h1 data-s="title">ZP Wallet</h1><p class="muted">Locked. Enter your password.</p>
    <form data-form="unlock" class="screen" data-s="flush">
      ${pwField('Password', 'p', 'current-password', 'required autofocus')}
      ${errBox()}<button class="btn primary big" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Unlock'}</button>
    </form>
    <button class="btn danger" data-act="reset">Forgot password: remove wallets from this browser</button></div>`,

  add: () => {
    const t = S.tab, importing = t !== 'new', subs = [['phrase', 'Recovery phrase'], ['key', 'Private key'], ['watch', 'Watch only']];
    let body = '';
    if (t === 'new') {
      S.draft.words ||= newMnemonic().split(' ');
      body = `<p class="muted small">Write these 24 words on paper, in order. They are the only backup of this wallet.</p>
        <div class="words">${S.draft.words.map((w, i) => `<div><span>${i + 1}</span>${esc(w)}</div>`).join('')}</div>
        <label class="row small" data-s="gap10"><input type="checkbox" name="saved" required data-s="check"> I wrote the words down</label>`;
    } else if (t === 'phrase') body = `<label class="field">Recovery phrase (24 words, any wallet for the ZP network)<textarea name="words" autocomplete="off" spellcheck="false" required></textarea></label>`;
    else if (t === 'key') body = `<label class="field">Private key (64 hex characters or an extended key)<textarea name="key" autocomplete="off" spellcheck="false" required></textarea></label>`;
    else body = `<label class="field">Address to watch (balance only, no spending)<input name="addr" class="mono" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" required></label>`;
    return `${backBar('Add a wallet', walletsHere().length ? 'home' : 'add')}<form data-form="add-wallet" class="screen">
      <div class="seg" role="tablist">
        <button type="button" class="chip big ${!importing ? 'on' : ''}" data-tab="new" role="tab" aria-selected="${!importing}"><b>New wallet</b><span>Create a fresh wallet</span></button>
        <button type="button" class="chip big ${importing ? 'on' : ''}" data-tab="${importing ? t : 'phrase'}" role="tab" aria-selected="${importing}"><b>Import existing</b><span>I already have a wallet</span></button></div>
      ${importing ? `<p class="muted small">What do you have?</p><div class="tabs3">${subs.map(([k, l]) => `<button type="button" class="chip ${k === t ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>` : ''}
      <label class="field">Name<input name="name" maxlength="40" value="${esc(S.draft.name || ['Main', 'Mining', 'Savings', 'Test'][walletsHere().length] || 'Wallet ' + (walletsHere().length + 1))}"></label>
      ${body}
      ${t !== 'watch' && t !== 'new' ? '<div class="warn">Only type your words or key on your own device. Nobody from the community will ever ask for them.</div>' : ''}
      <p class="muted small">Network: <b>${net() === 'main' ? 'Mainnet' : 'Testnet'}</b> (change in Settings).</p>
      ${errBox()}<button class="btn primary big" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : importing ? 'Import wallet' : 'Create wallet'}</button></form>`;
  },

  home: () => {
    const ws = walletsHere(), a = active();
    if (!a) return `${top()}<div class="screen"><p class="muted">No ${net() === 'test' ? 'testnet ' : ''}wallet yet.</p><button class="btn primary big" data-go="add">Add a wallet</button></div>${nav('home')}`;
    const d = S.data.get(a.id) || {}, zp = d.state?.assets.find(x => x.asset === '00');
    const total = ws.reduce((s, w) => s + (S.data.get(w.id)?.state?.assets.find(x => x.asset === '00')?.spendable || 0n)
      + (S.data.get(w.id)?.state?.assets.find(x => x.asset === '00')?.maturing || 0n), 0n);
    const others = (d.state?.assets || []).filter(x => x.asset !== '00');
    const c = cgpInfo();
    return `${top()}<div class="screen">
      <div class="wallets" role="tablist">${ws.map(w => `<button class="chip ${w.id === a.id ? 'on' : ''}" data-wallet="${esc(w.id)}" role="tab">${esc(w.name)}${w.kind === 'watch' ? ' 👁' : ''}</button>`).join('')}
        <button class="chip" data-go="add" aria-label="Add a wallet">+ Add</button></div>
      <div><div class="muted small">${esc(a.name)}${ws.length > 1 ? ` · all wallets ${formatZP(total)} ZP` : ''}</div>
        <div class="balance">${d.state ? formatZP(zp?.spendable || 0n) : '…'} <small>ZP</small></div>
        ${zp?.maturing ? `<div class="muted small">${formatZP(zp.maturing)} ZP mining rewards maturing · spendable from block ${zp.maturesAt.toLocaleString('en-US')}</div>` : ''}
        ${d.error ? `<div class="err small">${esc(d.error)}</div>` : ''}</div>
      <div class="actions">
        <button class="btn primary" data-go="send" ${canSpend(S.open.get(a.id)) ? '' : 'disabled'}>${I.send}Send</button>
        <button class="btn" data-go="receive">${I.recv}Receive</button>
        <button class="btn" data-go="vote">${I.vote}Vote</button></div>
      ${c ? `<button class="card cgp" data-go="vote" data-s="plain">
        <div class="row k"><span>CGP · INTERVAL ${c.community}</span><span data-s="right">${esc(c.phase)}</span></div>
        <div data-s="mt4">${esc(c.next)} in ${c.blocksLeft.toLocaleString('en-US')} blocks · around ${esc(c.eta)}</div>
        <div class="muted small">Fund ${cgpBalance()} · the fund gets ${alloc()}% of each block reward (${zpStr(c.cgpPerBlock)} ZP) · your vote weight ${formatZP(voteWeight())} ZP</div></button>` : ''}
      ${others.length ? `<div class="card"><h2>Tokens</h2><div class="list">${others.map(x => `<div class="item"><span title="${esc(x.asset)}">${S.assetNames[x.asset] ? esc(S.assetNames[x.asset]) : `<span class="mono small">${esc(x.asset.slice(0, 18))}…</span>`}</span><span class="amt">${formatZP(x.spendable + x.maturing)}</span></div>`).join('')}</div></div>` : ''}
      <div class="row"><h2>Activity</h2><button class="iconbtn" data-act="refresh" aria-label="Refresh" data-s="fixed">${S.busy ? '<span class="spin"></span>' : I.refresh}</button></div>
      <div class="list">${!d.history ? '<p class="muted small">Loading…</p>' : d.history.length === 0 ? '<p class="muted small">No transactions yet.</p>' : d.history.map(h => activityRow(h, a)).join('')}</div></div>${nav('home')}`;
  },

  send: () => {
    const a = active(), zp = S.data.get(a.id)?.state?.assets.find(x => x.asset === '00');
    return `${backBar('Send ZP')}<form data-form="send" class="screen">
      <label class="field">To address<input name="to" class="mono" autocomplete="off" spellcheck="false" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" value="${esc(S.draft.to || '')}" required></label>
      <label class="field"><span class="row" data-s="between"><span>Amount (ZP)</span><span data-s="right">Available ${formatZP(zp?.spendable || 0n)}</span></span>
        <span class="row"><input name="amount" inputmode="decimal" autocomplete="off" value="${esc(S.draft.amount || '')}" required><button type="button" class="btn" data-act="max" data-s="fixed">Max</button></span></label>
      <div class="card small"><div class="kv"><span class="muted">From</span><span>${esc(a.name)}</span></div><div class="kv"><span class="muted">Network fee</span><span>None</span></div><div class="kv"><span class="muted">Change returns to</span><span class="mono">${esc(shortAddr(receiveAddress(S.open.get(a.id))))}</span></div></div>
      <p class="muted small">Signed on this device. The node only receives the signed transaction.</p>
      ${errBox()}<button class="btn primary big">Review</button></form>`;
  },

  receive: () => {
    const a = active(), addr = receiveAddress(S.open.get(a.id));
    const q = qrcode(0, 'M'); q.addData(addr); q.make();
    return `${backBar('Receive')}<div class="screen" data-s="stretch">
      <div class="qr">${q.createSvgTag({ cellSize: 5, margin: 2, scalable: false })}</div>
      <div class="card"><div class="muted small">${esc(a.name)} · ${net() === 'main' ? 'Mainnet' : 'Testnet'}</div><div class="addr"><b>${esc(addr.slice(0, 9))}</b>${esc(addr.slice(9, -6))}<b>${esc(addr.slice(-6))}</b></div></div>
      <button class="btn primary big" data-act="copy" data-text="${esc(addr)}">${I.copy}Copy address</button>
      <p class="muted small">Check the first and last characters with the sender. Mining rewards to this address unlock after 100 blocks.</p></div>`;
  },

  vote: () => {
    const c = cgpInfo(), sel = new Set(voters().map(w => w.id)), signers = walletsHere().filter(w => w.kind !== 'watch');
    return `${top()}<div class="screen"><h1>CGP vote</h1>
      ${c ? `<div class="card cgp"><div class="row k"><span>INTERVAL ${c.community} <span class="muted">(node ${c.interval})</span></span><span data-s="right">${esc(c.phase)}</span></div>
        <div data-s="mt6">${esc(c.next)} in ${c.blocksLeft.toLocaleString('en-US')} blocks · around ${esc(c.eta)}</div>
        <div class="kv" data-s="mt6"><span class="muted">Each block reward</span><span>${zpStr(c.reward - c.cgpPerBlock)} ZP to the miner · ${zpStr(c.cgpPerBlock)} ZP to the fund</span></div>
        <div class="kv"><span class="muted">Split in force</span><span>miners ${100 - alloc()}% · CGP fund ${alloc()}%</span></div>
        <div class="kv"><span class="muted">CGP fund</span><span title="${esc(S.stats?.cgp?.balance ? 'at block ' + S.stats.cgp.balance.block : '')}">${cgpBalance()}</span></div>
        <div class="kv"><span class="muted">Snapshot block</span><span>${c.snapshot.toLocaleString('en-US')}</span></div></div>` : S.nodeOk === false ? `<div class="err" role="alert">Cannot reach the node (${esc(S.nodeError || 'no answer')}). The vote needs a node: check the address in Settings, then try again.</div><button class="btn" data-act="refresh">Try again</button>` : '<p class="muted">Loading…</p>'}
      <div class="card"><h2>Wallets that vote</h2>
        <p class="muted small">Choose one wallet or several: their balances at the snapshot block add up to one vote weight.</p>
        <div class="list">${signers.map(w => `<button class="item" data-act="vote-toggle" data-id="${esc(w.id)}" data-s="plain" aria-pressed="${sel.has(w.id)}">
          <span class="row"><span class="check ${sel.has(w.id) ? 'on' : ''}" aria-hidden="true">${sel.has(w.id) ? '✓' : ''}</span><span>${esc(w.name)}</span></span>
          <span class="amt" data-s="fixed">${formatZP(zpOf(w.id))} ZP</span></button>`).join('') || '<p class="muted small">Add a wallet with its 24 words or key to vote. Watch-only wallets cannot sign a ballot.</p>'}</div>
        ${signers.length > 1 ? `<div class="row" data-s="mt10"><button class="btn" data-act="vote-all">All</button><button class="btn" data-act="vote-none">None</button></div>` : ''}
        <div class="kv" data-s="mt10"><span>Vote weight now</span><span class="amt">${formatZP(voteWeight())} ZP</span></div></div>
      ${ballotsCard(c)}${sentCard(c)}
      <div class="card"><h2>Protocol upgrade vote</h2><p class="muted small">Inactive: the Repo voting contract has been inactive since block 233,874.</p></div></div>${nav('vote')}`;
  },

  markets: () => {
    const m = S.markets, base = siteBase(), tab = S.settings.mtab || 'oracle', loading = !m && !S.marketsError;
    const unit = (asset, v) => { const big = BigInt(v); return asset === '00' ? formatZP(big) + ' ZP' : (S.assetNames[asset] === 'zUSDC' ? (Number(big) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' zUSDC' : big.toString() + ' ' + (S.assetNames[asset] || shortAddr(asset))); };
    const tabs = [['oracle', 'Oracle'], ['dex', 'Dex'], ['swap', 'ZP ⇄ BTC']];
    const head = `<div class="tabs3 sticky" role="tablist" aria-label="Markets">${tabs.map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}" data-mtab="${k}">${l}</button>`).join('')}</div>`;
    const errCard = S.marketsError ? `<div class="card"><p class="muted small">${esc(S.marketsError)}</p></div>` : '';
    let body = '';
    if (tab === 'oracle') {
      const rows = (m?.round?.tickers || []).map((t, i) => {
        const e = m.evidence[t] || {}, names = Object.keys(e.sources || {}), dropped = e.dropped || [];
        const src = !names.length ? '1 source' : `${names.length - dropped.length} of ${names.length} sources agree`;
        const day = e.asOf && m.day && e.asOf !== m.day ? 'close ' + e.asOf : '';
        const tip = names.map(n => n + ' = ' + e.sources[n]).join('\n') + (dropped.length ? '\ndropped: ' + dropped.join(', ') : '');
        return `<div class="item" title="${esc(tip)}"><div><div><b>${esc(t)}</b></div><div class="muted small">${esc(src)}${day ? ' · ' + esc(day) : ''}</div></div><div class="amt">${esc(Number(m.round.values[i]).toLocaleString('en-US', { maximumFractionDigits: 6 }))}</div></div>`;
      }).join('');
      body = `${errCard}<div class="card"><h2>Prices in USD${m?.round ? ' <span class="muted small">· ' + esc(ago(m.round.timestamp)) + '</span>' : ''}</h2><div class="list">${loading ? '<p class="muted small">Loading…</p>' : rows || '<p class="muted small">No prices yet.</p>'}</div>
        <p class="muted small" data-s="mt10">Several sources must agree; stocks and gold are end-of-day closes.</p></div>`;
    } else if (tab === 'dex') {
      const orders = (m?.orders || []).slice(0, 20).map(o => {
        let text = '';
        try { text = `${unit(o.under_asset, o.under_amount)} for ${unit(o.pair_asset, o.pair_total)}`; } catch { text = 'order'; }
        return `<div class="item"><div><div>${esc(text)}</div><div class="muted small mono" title="${esc(o.maker || '')}">${esc(shortAddr(String(o.maker || '')))}</div></div></div>`;
      }).join('');
      body = `${errCard}<div class="card"><h2>Open orders</h2><div class="list">${loading ? '<p class="muted small">Loading…</p>' : orders || '<p class="muted small">No open orders.</p>'}</div>
        ${base ? `<p class="muted small" data-s="mt10">Trading from the wallet comes next. Today trade on <a href="${esc(base)}/dex.html" rel="noopener">the Dex page</a>.</p>` : ''}</div>`;
    } else body = swapCard();
    return `${top()}<div class="screen"><h1>Markets</h1>${head}${body}</div>${nav('markets')}`;
  },

  contracts: () => {
    const cs = S.contracts, wa = active(), mayExtend = !!(wa && S.open.get(wa.id) && canSpend(S.open.get(wa.id)));
    return `${top()}<div class="screen"><h1>Smart contracts</h1>
    ${myContractsCard()}
    ${createCard()}
    <div class="card"><h2>All active contracts</h2><div class="list">${!cs ? '<p class="muted small">Loading…</p>' : cs.length === 0 ? '<p class="muted small">None.</p>' : cs.map((k, i) => {
      const left = k.expire - (S.tip || k.expire), cls = left < 300 ? 'lvl-bad' : left < 3000 ? 'lvl-warn' : '';
      return `<div class="item"><div><div>${esc(k.name || 'Contract')}</div><div class="muted small mono" title="${esc(k.address)}">${esc(shortAddr(k.address))}</div></div>
        <div data-s="right"><div class="small">until ${Number(k.expire).toLocaleString('en-US')}</div><div class="small ${cls}">${left.toLocaleString('en-US')} blocks left</div>${dateAfter(left) ? `<div class="small muted">around ${dateAfter(left)}</div>` : ''}${mayExtend ? `<button class="btn small" data-act="extend" data-i="${i}">Extend</button>` : ''}</div></div>`;
    }).join('')}</div></div>
    <div class="card"><p class="muted small">Tokens issued by contracts appear on the Wallet screen. Extending a contract keeps it running past its end block: it costs ZP from the active wallet.</p></div></div>${nav('contracts')}`;
  },

  create: () => createView(),

  settings: () => `${top()}<div class="screen"><h1>Settings</h1>
    <div class="card"><h2>Network</h2><div class="tabs" data-s="two mt10">
      <button class="chip ${net() === 'main' ? 'on' : ''}" data-net="main">Mainnet</button><button class="chip ${net() === 'test' ? 'on' : ''}" data-net="test">Testnet</button></div>
      ${net() === 'test' ? '<p class="small" data-s="amber">Testnet coins have no value. Testnet wallets are kept apart from mainnet wallets.</p>' : ''}</div>
    <form class="card" data-form="node"><h2>Node</h2>
      <label class="field" data-s="mt10">Node address for ${net() === 'main' ? 'mainnet' : 'testnet'}
        <input name="url" class="mono" value="${esc(S.settings.nodes[net()])}" placeholder="https://… or http://localhost:11567"></label>
      <div class="row" data-s="mt10"><button class="btn primary">Save and test</button><button type="button" class="btn" data-act="node-default">Default</button></div>
      <p class="muted small">${esc(defaultNode(net()) ? 'Default: ' + defaultNode(net()) : 'No public testnet node yet: run your own or enter one.')}</p></form>
    <div class="card"><h2>Wallets on ${net() === 'main' ? 'mainnet' : 'testnet'}</h2><div class="list">${walletsHere().map(w => `<div class="item"><div><div>${esc(w.name)}</div><div class="muted small">${{ mnemonic: '24 words', key: 'Private key', watch: 'Watch only' }[w.kind]}</div></div>
      <span class="row" data-s="fixed">${w.kind !== 'watch' ? `<button class="btn" data-act="reveal" data-id="${esc(w.id)}">Backup</button>` : ''}<button class="btn danger" data-act="remove" data-id="${esc(w.id)}">Remove</button></span></div>`).join('') || '<p class="muted small">None.</p>'}</div></div>
    <button class="btn big" data-act="lock">Lock now</button>
    <p class="muted small">ZP Wallet ${esc(WALLET_VERSION)} · open source and community-run. Not affiliated with Zen Protocol Ltd.</p></div>${nav('settings')}`,
};

const alloc = () => { const a = S.cgp?.allocation; return Number.isInteger(a) && a >= 0 && a <= 100 ? a : 90; };

// CGP cycle seen from the next block (the one a ballot sent now would land in); intervals per network from cgp.js
function cgpInfo() {
  if (!S.tip) return null;
  const p = CGP_PARAMS[net()], tip = S.tip, ph = phaseAt(p, tip + 1), interval = ph.interval, snap = snapshotBlock(p, interval);
  const [phase, next, at] = ph.phase === 'before' ? ['Before snapshot', 'Balance snapshot', snap] : ph.phase === 'Nomination' ? ['Nomination', 'Voting opens', ph.closes] : ['Voting', 'Voting closes', ph.closes];
  const eta = new Date(Date.now() + (at - tip) * 236682).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const reward = 50 / 2 ** Math.floor(Math.max(0, tip - 2) / 800000);       // ZP per block, halving every 800,000 blocks
  // wallets and the explorer number intervals from the CGP launch (node interval 106 = interval 82)
  return { interval, community: net() === 'test' ? interval : interval - 24, phase, next, blocksLeft: at - tip, eta, snapshot: snap, reward, cgpPerBlock: reward * alloc() / 100 };
}
const cgpBalance = (withBlock = false) => {
  const b = S.stats?.cgp?.balance;
  return b && Number.isFinite(b.zp) ? zpStr(b.zp) + ' ZP' + (withBlock ? ` <span class="muted small">at block ${Number(b.block).toLocaleString('en-US')}</span>` : '') : 'not available (the node has no address index)';
};

// ---------------------------------------------------------------- activity: who sent, who received
// The address index gives only the amount per transaction. The other side comes from the transaction itself
// (/blockchain/transaction): for a payment out, its outputs to addresses that are not ours; for a payment in, the owner
// of the output that its first input spends. Looked up in the background for the rows on screen, kept per transaction.
S.txInfo = new Map();
const lockAddr = l => { if (!l || typeof l !== 'object') return null; const k = Object.keys(l)[0], v = l[k]; return v && typeof v.address === 'string' ? { kind: k, address: v.address, id: v.id } : { kind: k }; };
const knownContract = id => id === VOTING_CONTRACT[net()] ? 'the CGP vote' : id === CGP_CONTRACT[net()] ? 'the CGP fund' : null;
async function txInfo(hash, w) {
  if (S.txInfo.has(hash)) return S.txInfo.get(hash);
  S.txInfo.set(hash, null);
  const n = node(); if (!n) return null;
  try {
    const t = await n.request('/blockchain/transaction?hash=' + hash), tx = t && t.tx;
    if (!tx || !Array.isArray(tx.outputs)) return null;
    const mine = new Set(addresses(S.open.get(w.id)));
    const outs = tx.outputs.map(o => lockAddr(o.lock)).filter(Boolean);
    const vote = outs.find(o => o.kind === 'Contract' && o.id && knownContract(o.id) === 'the CGP vote');
    const to = outs.find(o => o.address && !mine.has(o.address) && o.kind !== 'Fee');
    let from = null;
    const op = (tx.inputs || []).map(i => i && i.outpoint).find(Boolean);
    if (op && /^[0-9a-f]{64}$/.test(op.txHash)) {
      const p = await n.request('/blockchain/transaction?hash=' + op.txHash).catch(() => null);
      const o = p && p.tx && Array.isArray(p.tx.outputs) ? lockAddr(p.tx.outputs[op.index]?.lock) : null;
      if (o && o.address) from = o;
    }
    const info = { vote: !!vote, to: to || null, from };
    S.txInfo.set(hash, info);
    return info;
  } catch { return null; }
}
let txInfoBusy = false;
async function loadTxInfo(w, rows) {
  if (txInfoBusy) return; txInfoBusy = true;
  try { let any = false; for (const h of rows.slice(0, 20)) if (h.txHash && !S.txInfo.has(h.txHash)) { await txInfo(h.txHash, w); any = true; } if (any && !S.modal && S.screen === 'home') render(); }
  finally { txInfoBusy = false; }
}
function activityRow(h, w) {
  const amt = BigInt(h.amount), inn = amt > 0n, info = h.txHash ? S.txInfo.get(h.txHash) : null;
  const mineVote = (S.myVotes ||= loadVotes()).find(v => v.hash === h.txHash);
  let what = h.lock?.Coinbase ? 'Mining reward' : inn ? 'Received' : 'Sent', who = '', back = '';
  if (!h.lock?.Coinbase && info) {
    // a ballot costs 1 kalapa and pays nobody: votes from another device are recognised by that too
    if (!inn && (info.vote || mineVote || (amt === -1n && !info.to))) { what = 'CGP ballot'; who = mineVote ? esc(mineVote.kind + ': ' + mineVote.label) : 'vote fee (1 kalapa)'; }
    else {
      const o = inn ? info.from : info.to, name = o && o.kind === 'Contract' && o.id ? knownContract(o.id) : null;
      if (o && o.address) {
        what = inn ? 'Received from' : 'Sent to';
        who = name ? esc(name.replace(/^the /, 'The ')) : `<span class="mono" title="${esc(o.address)}">${esc(shortAddr(o.address))}</span>`;
        const copy = `<button type="button" class="chip mini" data-act="copy" data-text="${esc(o.address)}">Copy</button>`;
        back = (inn && o.kind !== 'Contract' ? `<button type="button" class="chip mini" data-act="send-back" data-to="${esc(o.address)}">Send back</button>` : !inn && o.kind !== 'Contract' ? `<button type="button" class="chip mini" data-act="send-back" data-to="${esc(o.address)}">Send again</button>` : '') + (o.kind !== 'Contract' ? copy : '');
      }
    }
  } else if (mineVote && !inn) { what = 'CGP ballot'; who = esc(mineVote.kind + ': ' + mineVote.label); }
  else if (!info && h.txHash && !h.lock?.Coinbase) who = '<span class="muted">…</span>';
  return `<div class="item act"><div class="act-main"><div>${what}${who ? ` <span class="act-who">${who}</span>` : ''}</div>
      <div class="muted small">${h.timestamp ? ago(h.timestamp) : 'pending'} · ${h.confirmations ? esc(h.confirmations.toLocaleString('en-US')) + ' conf.' : 'unconfirmed'}</div>
      ${back ? `<div class="row" data-s="mt4">${back}</div>` : ''}</div>
    <div class="amt ${inn ? 'in' : ''}">${inn ? '+' : '−'}${h.asset === '00' ? formatZP(inn ? amt : -amt) + ' ZP' : esc(String(inn ? amt : -amt))}</div></div>`;
}

// ---------------------------------------------------------------- CGP ballots
function ballotsCard(c) {
  if (!c) return '';
  const ph = phaseAt(CGP_PARAMS[net()], (S.tip || 0) + 1), none = !voters().length;
  const note = none ? '<p class="muted small">Select at least one wallet that can sign above.</p>' : '';
  if (ph.phase === 'before') return `<div class="card"><h2>Casting ballots</h2><p class="muted small">Ballots open after the snapshot block (${c.snapshot.toLocaleString('en-US')}). Your balance at that block is your weight for this interval.</p></div>`;
  const cur = alloc(), r = allocationRange(CGP_PARAMS[net()], cur), many = r.max - r.min > 5;
  const pAlloc = priorVote('Allocation', ph.interval, ph.phase), pNom = priorVote('Nomination', ph.interval, ph.phase), pPay = priorVote('Payout', ph.interval, ph.phase);
  // each form says whether it is open now and, when closed, when it opens; a closed form cannot be filled in (disabled fieldset)
  const p = CGP_PARAMS[net()], snap = snapshotBlock(p, ph.interval), n0 = snap + 1, n1 = snap + phasesOf(p, ph.interval).nomination, v0 = n1 + 1, v1 = ph.interval * p.intervalLength;
  const nextSnap = snapshotBlock(p, ph.interval + 1), num = i => (net() === 'test' ? i : i - 24), blk = b => b.toLocaleString('en-US');
  const left = b => { const k = b - (S.tip || 0); return k > 0 ? ` · ${k} block${k === 1 ? '' : 's'} left` : ''; };
  const openNom = ph.phase === 'Nomination', openVote = ph.phase === 'Vote';
  const status = (open, text) => `<p class="small phase ${open ? 'open' : 'closed'}" role="status">${open ? '● Open now' : '○ Closed'} · ${text}</p>`;
  const nomStatus = openNom ? status(true, `nominations in blocks ${blk(n0)}–${blk(n1)}${left(n1)}`)
    : status(false, `nominations for interval ${num(ph.interval)} were blocks ${blk(n0)}–${blk(n1)}. Next: blocks ${blk(nextSnap + 1)}–${blk(nextSnap + phasesOf(p, ph.interval + 1).nomination)} (interval ${num(ph.interval + 1)})`);
  const voteStatus = openVote ? status(true, `voting until block ${blk(v1)}${left(v1)}`) : status(false, `voting opens at block ${blk(v0)} and runs to ${blk(v1)}`);
  const values = many ? [...new Set([r.min, cur, r.max])] : Array.from({ length: r.max - r.min + 1 }, (_, i) => r.min + i);
  const pct0 = S.draft.pct || String(cur);
  const allocForm = `<form data-form="vote-alloc" class="screen" data-s="flush"><h2>Allocation vote</h2>${voteStatus}
      <fieldset class="phasebox" ${openVote ? '' : 'disabled'}><p class="muted small">Share of each block reward paid to the CGP fund; the miners get the rest. Counted in the voting phase. With ${cur}% in force the valid votes are ${r.min}% to ${r.max}%: anything else is ignored.</p>
      <div class="cmp"><div><div class="k">Now in force</div><div class="v">CGP ${cur}%</div><div class="muted small">miners ${100 - cur}%</div></div>
        <div class="arrow" aria-hidden="true">→</div>
        <div><div class="k">Your vote</div><div class="v" id="alloc-v">CGP ${esc(pct0)}%</div><div class="muted small" id="alloc-m"></div></div></div>
      <div class="tabs3" role="group" aria-label="Choose a value">${values.map(v => `<button type="button" class="chip ${String(v) === pct0 ? 'on' : ''}" data-act="alloc-pick" data-v="${v}">${v}%${v === cur ? '<br><span class="muted small">keep</span>' : ''}</button>`).join('')}</div>
      ${many ? `<input type="range" class="slider" name="pctr" min="${r.min}" max="${r.max}" step="1" value="${esc(pct0)}" aria-label="Allocation (%)">` : ''}
      <label class="field">Allocation (%)<input name="pct" inputmode="numeric" autocomplete="off" value="${esc(pct0)}" data-min="${r.min}" data-max="${r.max}" data-cur="${cur}" required></label>
      <div class="small" id="alloc-note" aria-live="polite"></div>
      ${openVote ? (pAlloc ? votedBox(pAlloc) : `<button class="btn primary" id="alloc-go" ${none ? 'disabled' : ''}>Review</button>`) : ''}</fieldset></form>`;
  const fundZp = S.stats?.cgp?.balance && Number.isFinite(S.stats.cgp.balance.zp) ? S.stats.cgp.balance.zp : null;
  const mine = walletsHere().map(w => ({ name: w.name, addr: receiveAddress(S.open.get(w.id)) })).filter(x => x.addr);
  const nom = `<form data-form="vote-nom" class="screen" data-s="flush"><h2>Payout nomination</h2>${nomStatus}
      <fieldset class="phasebox" ${openNom ? '' : 'disabled'}><p class="muted small">Propose that the CGP fund pays an amount of ZP to an address. Needs 3% of all ZP behind it to become a candidate.</p>
      <label class="field">Recipient address<input name="to" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" value="${esc(S.draft.nto || '')}" required></label>
      <div class="row wrapchips"><button type="button" class="chip" data-act="paste-to">Paste</button>${mine.map(x => `<button type="button" class="chip" data-act="use-addr" data-addr="${esc(x.addr)}" title="${esc(x.addr)}">${esc(x.name)}</button>`).join('')}</div>
      <div class="small" id="to-note" aria-live="polite"></div>
      <label class="field">Amount (ZP)<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(S.draft.namount || '')}" data-fund="${fundZp === null ? '' : fundZp}" required></label>
      <div class="small muted" id="amt-note" aria-live="polite">${fundZp === null ? '' : `The CGP fund holds ${zpStr(fundZp)} ZP: a larger request cannot be paid.`}</div>
      ${openNom ? (pNom ? votedBox(pNom) : `<button class="btn primary" ${none ? 'disabled' : ''}>Review</button>`) : ''}</fieldset></form>`;
  const cands = S.cands ? (S.cands.length ? S.cands.map((x, i) => `<button class="item" data-act="vote-cand" data-i="${i}" data-s="plain" ${ph.phase === 'Vote' && !none && !pPay ? '' : 'disabled'}>
      <span class="mono small" data-s="wrap">${esc(x.recipient)}</span><span class="amt">${x.spendlist.map(s => s.asset === '00' ? formatZP(BigInt(s.amount)) + ' ZP' : 'asset ' + esc(s.asset.slice(0, 8)) + '…').join(' + ')}</span></button>`).join('') : '<p class="muted small">No candidates in this interval.</p>')
    : `<button class="btn" data-act="load-cands">Show candidates</button>`;
  return `<div class="card"><h2>Casting ballots</h2>
    <p class="muted small">Signed on this device by the selected wallets; each sends one transaction with a 1 kalapa fee. Only the first vote of each key counts in a phase.</p>${note}
    <div class="card">${allocForm}</div><div class="card">${nom}</div>
    <div class="card"><h2>Payout vote</h2>${voteStatus}<p class="muted small">Pick a candidate. Counted in the voting phase.</p>${pPay ? votedBox(pPay) : ''}<div class="list">${cands}</div></div>${errBox()}</div>`;
}
async function reviewVote(kind, command, ballotHex, label, rows = []) {
  const sel = voters(); if (!sel.length) throw new Error('Select at least one wallet that can sign');
  const ph0 = phaseAt(CGP_PARAMS[net()], (S.tip || 0) + 1), prior = priorVote(command, ph0.interval, ph0.phase);
  if (prior) throw new Error(votedText(prior));
  const need = command === 'Nomination' ? 'Nomination' : 'Vote';
  if (ph0.phase !== need) throw new Error(need === 'Nomination' ? 'Nominations are closed now: they open after the next snapshot block.' : 'Voting is closed now: it opens after the nomination phase.');
  const funder = S.open.get(active().id) && canSpend(S.open.get(active().id)) && sel.some(w => w.id === active().id) ? active() : sel[0];
  await refreshWallet(funder.id);
  const d = S.data.get(funder.id); if (!d?.state) throw new Error('Could not read the balance from the node');
  const voterKeys = sel.flatMap(w => [...S.open.get(w.id).keys.values()]);
  // an output spent by a vote that is not in a block yet still shows as unspent: do not use it twice
  const now = Date.now(), here = new Set(d.state.utxos.map(u => hex(u.outpoint.txHash) + ':' + u.outpoint.index));
  S.pendingVotes = (S.pendingVotes || []).filter(p => now - p.at < 30 * 60 * 1000 && here.has(p.spent));
  const exclude = S.pendingVotes.map(p => p.spent);
  let prepared;
  try { prepared = await prepareVote({ w: S.open.get(funder.id), state: d.state, node: node(), votingContractId: VOTING_CONTRACT[net()], command, ballotHex, voterKeys, exclude }); }
  catch (e) {
    if (exclude.length && /little ZP/.test(e.message)) throw new Error('Your last vote is still waiting for its block (about 4 minutes). Wait for it, then send the next one.');
    throw e;
  }
  S.modal = { type: 'confirm-vote', kind, command, label, rows, prepared, weight: voteWeight(), voters: sel.map(w => w.id) }; S.error = ''; render();
}

// ---------------------------------------------------------------- modal
function modalHtml() {
  if (S.modal?.type === 'scan') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Scan a public key</h2>
    <video id="qr-video" class="qr-video" playsinline muted></video><p id="qr-msg" class="muted small" aria-live="polite">Point the camera at the QR code of the key.</p>
    <button class="btn" data-act="close">Cancel</button></div></div>`;
  const m = S.modal; if (!m) return '';
  if (m.type === 'confirm-send') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm transfer</h2>
    <div class="card"><div class="kv"><span class="muted">Send</span><span class="amt">${formatZP(m.amount)} ZP</span></div>
    <div class="kv"><span class="muted">To</span><span class="mono small">${esc(m.to)}</span></div>
    <div class="kv"><span class="muted">From</span><span>${esc(active().name)}</span></div>
    <div class="kv"><span class="muted">Fee</span><span>None</span></div></div>
    <p class="muted small">Transfers cannot be reversed. Check the address.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-send" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'confirm-vote') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm ${esc(m.kind)}</h2>
    <div class="card"><div class="kv"><span class="muted">Ballot</span><span>${esc(m.label)}</span></div>
    ${(m.rows || []).map(([k, v, mono]) => `<div class="kv"><span class="muted">${esc(k)}</span><span class="${mono ? 'mono small' : ''}">${esc(v)}</span></div>`).join('')}
    <div class="kv"><span class="muted">Signing keys</span><span>${m.prepared.signers}</span></div>
    <div class="kv"><span class="muted">Weight (balance at snapshot)</span><span>about ${formatZP(m.weight)} ZP</span></div>
    <div class="kv"><span class="muted">Fee</span><span>1 kalapa</span></div></div>
    <p class="muted small">Interval ${m.prepared.phase.interval}, ${esc(m.prepared.phase.phase)} phase. A vote cannot be changed after it is sent.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-vote" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'voted') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Broadcast successfully</h2>
    <p>The node accepted your ${esc(m.kind)}: <b>${esc(m.label)}</b>.</p>
    <p class="muted small">It counts once it is in a block of this phase (about 4 minutes). Its status is under “Your ballots” on this screen.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'extend') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Extend ${esc(m.name || 'contract')}</h2>
    <form data-form="extend" class="screen" data-s="flush">
    <div class="card"><div class="kv"><span class="muted">Ends at block</span><span>${m.expire.toLocaleString('en-US')}</span></div>
    <div class="kv"><span class="muted">Blocks left</span><span>${Math.max(0, m.expire - (S.tip || m.expire)).toLocaleString('en-US')}${dateAfter(m.expire - (S.tip || m.expire)) ? ' · around ' + dateAfter(m.expire - (S.tip || m.expire)) : ''}</span></div>
    <div class="kv"><span class="muted">Price</span><span>${m.code.length.toLocaleString('en-US')} kalapas per block</span></div>
    <div class="kv"><span class="muted">Your balance</span><span>${m.balance === null ? '–' : formatZP(m.balance) + ' ZP'}</span></div></div>
    <label class="field">Extend by (blocks)<input name="blocks" inputmode="numeric" autocomplete="off" value="${esc(m.blocks || '')}" required></label>
    <div class="wrapchips">${extendPresets().map(([b, t]) => `<button type="button" class="chip" data-act="ext-pick" data-v="${b}" title="${formatZP(extendCost(m.code, b))} ZP">${esc(t)} · ${zpStr(Number(extendCost(m.code, b)) / 1e8)} ZP</button>`).join('')}</div>
    <div class="card"><div class="kv"><span class="muted">Cost</span><span id="ext-cost">–</span></div>
    <div class="kv"><span class="muted">New end block</span><span id="ext-new">–</span></div></div>
    <p id="ext-note" class="small muted"></p>${errBox()}
    <div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" id="ext-go" disabled>Review</button></div></form></div></div>`;
  if (m.type === 'confirm-extend') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm extension</h2>
    <div class="card"><div class="kv"><span class="muted">Contract</span><span>${esc(m.name || 'Contract')}</span></div>
    ${CONTRACT_ROLE[m.name] ? `<div class="kv"><span class="muted">What it does</span><span>${esc(CONTRACT_ROLE[m.name])}</span></div>` : ''}
    <div class="kv"><span class="muted">Contract ID</span><span class="mono">${esc(m.id.slice(0, 12))}…${esc(m.id.slice(-8))}</span></div>
    <div class="kv"><span class="muted">Extend by</span><span>${m.blocks.toLocaleString('en-US')} blocks${net() === 'main' ? ` (${m.blocks < 365 ? 'less than a day' : 'about ' + (m.blocks / 365).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' days'})` : ''}</span></div>
    <div class="kv"><span class="muted">Cost</span><span class="amt">${formatZP(m.prepared.cost)} ZP</span></div>
    <div class="kv"><span class="muted">New end block</span><span>${(m.expire + m.blocks - 1).toLocaleString('en-US')}${dateAfter(m.expire + m.blocks - 1 - (S.tip || m.expire)) ? ' · around ' + dateAfter(m.expire + m.blocks - 1 - (S.tip || m.expire)) : ''}</span></div>
    <div class="kv"><span class="muted">From</span><span>${esc(active().name)}</span></div></div>
    ${m.prepared.cost >= EXTEND_WARN ? `<p class="bad small">This is a large payment: ${formatZP(m.prepared.cost)} ZP. Each block costs ${m.code.length.toLocaleString('en-US')} kalapas because this contract's code is that long. Check that this is the contract you meant.</p>` : ''}
    <p class="muted small">The ZP is spent for good: it is not returned if the contract is not used.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-extend" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'extended') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Broadcast successfully</h2>
    <p>The node accepted the extension of <b>${esc(m.name || 'the contract')}</b> by ${m.blocks.toLocaleString('en-US')} blocks.</p>
    <p class="muted small">It takes effect when the transaction is in a block (about 4 minutes). The new end block then shows on this screen.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'offer') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>New offer</h2>
    <form data-form="offer" class="screen" data-s="flush">
    <label class="field">ZP to sell<input name="zp" inputmode="decimal" autocomplete="off" value="${esc(m.zp || '')}" required></label>
    <p class="muted small">From ${esc(active().name)}: ${m.balance === null ? '–' : formatZP(m.balance) + ' ZP'} spendable.</p>
    <div class="small">Price</div>
    <div class="tabs3" role="group" aria-label="How to give the price">${[['usd', '$ per ZP'], ['total', 'Total in BTC'], ['sat', 'sat per ZP']].map(([k, l]) =>
      `<button type="button" class="chip ${(m.mode || 'total') === k ? 'on' : ''}" data-act="price-mode" data-v="${k}" ${k === 'usd' && !btcUsd() ? 'disabled title="No Bitcoin price from the oracle right now"' : ''}>${l}</button>`).join('')}</div>
    ${(m.mode || 'total') === 'total'
      ? `<label class="field">Total price (BTC, for all of it)<input name="btc" inputmode="decimal" autocomplete="off" placeholder="0.0005" value="${esc(m.btc || '')}" required></label>`
      : `<label class="field">${m.mode === 'usd' ? 'Price per ZP ($)' : 'Price per ZP (satoshis)'}<input name="per" inputmode="decimal" autocomplete="off" placeholder="${m.mode === 'usd' ? '1.25' : '1250'}" value="${esc(m.per || '')}" required></label>`}
    <div class="small muted" id="offer-rate" aria-live="polite"></div>
    ${m.mode === 'usd' ? `<p class="muted small">At the oracle's Bitcoin price, $${esc(btcUsd()?.toLocaleString('en-US'))}. The offer keeps the total in BTC: if Bitcoin moves, the dollar price per ZP moves with it.</p>` : ''}
    <label class="field">Your Bitcoin addresses, one per line (1 to ${MAX_SCRIPTS})<textarea name="addrs" rows="4" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${S.swap?.btcNet === 'test' ? 'tb1q…' : 'bc1q…'}" required>${esc(m.addrs || '')}</textarea></label>
    <p class="muted small">The buyer pays to one of these: each reservation uses the next one, so a late payment can never be taken by the next buyer. <b>Each line must be a new address that never received bitcoin</b>: in your Bitcoin wallet, make a new receive address for each line (most wallets show the same one until it is paid). A wallet with a single fixed address, or an exchange deposit address, is not suitable: give one address per offer at most. When all are used, take the offer back and make a new one.</p>
    ${errBox()}<div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Review</button></div></form></div></div>`;
  if (m.type === 'confirm-offer') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm offer</h2>
    <div class="card"><div class="kv"><span class="muted">Sell</span><span class="amt">${formatZP(m.amount)} ZP</span></div>
    <div class="kv"><span class="muted">For (total)</span><span class="amt">${esc(formatBTC(m.sats))} BTC${btcUsd() ? ` <span class="muted small">≈ $${(Number(m.sats) / 1e8 * btcUsd()).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : ''}</span></div>
    <div class="kv"><span class="muted">Price per ZP</span><span>${esc(rateText(m.sats, m.amount))}</span></div>
    ${m.addrs.map((a, i) => `<div class="kv"><span class="muted">Bitcoin address ${i + 1}</span><span class="mono small" data-s="wrap">${esc(a)}</span></div>`).join('')}
    <div class="kv"><span class="muted">From</span><span>${esc(active().name)}</span></div>
    <div class="kv"><span class="muted">Fee</span><span>1 kalapa</span></div></div>
    ${m.unchecked ? '<div class="warn">Bitcoin could not be asked right now whether these addresses were used before. Make sure each one is new.</div>' : ''}
    <p class="muted small">The ZP is locked in the swap contract until a buyer pays or you take the offer back (possible while it is not reserved, and from 10 blocks after a reservation ends). Check the Bitcoin addresses: the bitcoin goes there and nowhere else.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-offer" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'confirm-cancel') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Take the offer back</h2>
    <div class="card"><div class="kv"><span class="muted">Offer</span><span>${esc(formatZP(m.amount))} ZP for ${esc(formatBTC(m.sats))} BTC</span></div>
    <div class="kv"><span class="muted">The ZP goes back to</span><span>${esc(m.wallet)}</span></div>
    <div class="kv"><span class="muted">Fee</span><span>1 kalapa</span></div></div>
    <p class="muted small">If a buyer reserves it before this transaction is in a block, the contract refuses it and nothing changes.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Keep it</button><button class="btn primary" data-act="confirm-cancel" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'swap-sent') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Broadcast successfully</h2>
    <p>${esc(m.text)}</p><p class="muted small">It takes effect in the next block (about 4 minutes); Markets follows it until then.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'confirm-activate') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Activate the contract</h2>
    <div class="card"><div class="kv"><span class="muted">Contract</span><span>${esc(m.name)}</span></div>
    <div class="kv"><span class="muted">Contract id</span><span class="mono small">${esc(m.prepared.contractId.slice(0, 14))}…${esc(m.prepared.contractId.slice(-8))}</span></div>
    <div class="kv"><span class="muted">Active for</span><span>${m.prepared.blocks.toLocaleString('en-US')} blocks</span></div>
    <div class="kv"><span class="muted">Cost</span><span class="amt">${formatZP(m.prepared.cost)} ZP</span></div>
    <div class="kv"><span class="muted">From</span><span>${esc(active().name)}</span></div></div>
    <p class="muted small">The wallet computed the contract id from the source you saw; it matches the engine's. The ZP is spent for good. Anyone can use the contract once it is active.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-activate" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'activated') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Broadcast successfully</h2>
    <p>The contract becomes active when the transaction is in a block (about 4 minutes), for ${m.blocks.toLocaleString('en-US')} blocks.</p>
    <div class="card small"><div class="muted">Contract address</div><div class="mono" data-s="wrap">${esc(m.address)}</div><div class="muted" data-s="mt10">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <div class="row"><button class="btn" data-act="copy" data-text="${esc(m.address)}">${I.copy}Copy address</button><button class="btn primary" data-act="close">Done</button></div></div></div>`;
  if (m.type === 'sent') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">Sent</h2>
    <p>${formatZP(m.amount)} ZP is on its way. It appears in the next block, about 4 minutes.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'reveal') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Backup · ${esc(m.name)}</h2>
    ${m.secret ? `${m.kind === 'mnemonic' ? `<div class="words">${m.secret.split(' ').map((w, i) => `<div><span>${i + 1}</span>${esc(w)}</div>`).join('')}</div>` : `<div class="card mono small" data-s="wrap">${esc(m.secret)}</div>`}
      <div class="warn">Anyone with this can take the coins. Never send it to anyone or share it in a screenshot.</div>`
    : `<form data-form="reveal" class="screen" data-s="flush">${pwField('Password', 'p', 'current-password', 'required autofocus')}${errBox()}<button class="btn primary">Show</button></form>`}
    <button class="btn" data-act="close">Close</button></div></div>`;
  if (m.type === 'confirm') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>${esc(m.title)}</h2><p>${esc(m.text)}</p>
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn danger" data-act="${esc(m.act)}" data-id="${esc(m.id || '')}">${esc(m.ok)}</button></div></div></div>`;
  return '';
}

// Background refreshes re-render the page: what the person has typed (password, 24 words, an amount) must survive that.
let freshScreen = true;
const fieldKey = el => (el.form?.dataset.form || '') + '/' + el.name;
function snapshotFields() {
  return [...$app.querySelectorAll('form[data-form] input, form[data-form] textarea')].filter(el => el.name && el.type !== 'hidden')
    .map(el => ({ key: fieldKey(el), box: el.type === 'checkbox', value: el.type === 'checkbox' ? el.checked : el.value, focus: el === document.activeElement,
                  from: el.selectionStart, to: el.selectionEnd, type: el.type }));
}
function render() {
  const saved = freshScreen ? [] : snapshotFields();
  freshScreen = false;
  const v = views[S.screen] || views.welcome;
  $app.innerHTML = v() + modalHtml();
  const f = $app.querySelector('[autofocus]'); if (f) f.focus();
  if (S.screen === 'vote') { const p = $app.querySelector('input[name=pct]'); if (p) syncAlloc(p.value, 'field'); syncTo(); syncAmt(); }
  if (S.screen === 'vote' && S.error && !S.modal) $app.querySelector('.err')?.scrollIntoView({ block: 'center' });   // the message sits below three forms: a phone screen would not show it
  for (const s of saved) {
    const el = [...$app.querySelectorAll('form[data-form] input, form[data-form] textarea')].find(e => e.name && fieldKey(e) === s.key);
    if (!el) continue;
    if (s.box) el.checked = s.value; else if (el.value !== s.value) el.value = s.value;
    if (s.focus) { el.focus(); try { el.setSelectionRange(s.from, s.to); } catch { /* checkbox */ } }
  }
  if (S.modal?.type === 'offer') syncOffer();   // the price line after any re-render (an error, a mode change)
  if (S.error && S.errField) { const el = $app.querySelector(`form[data-form] [name="${S.errField}"]`); if (el) { el.classList.add('invalid'); el.setAttribute('aria-invalid', 'true'); } }
}

// ---------------------------------------------------------------- data
async function refreshNode() {
  const n = node();
  if (!n) { S.nodeOk = false; S.tip = null; return; }
  // A node that is busy (it serves the chain indexer too) can miss one request: ask up to 3 times before saying "offline".
  // A wrong network or a bad answer is not retried.
  for (let i = 0; i < 3; i++) {
    try { const info = checkInfo(await n.info(), net()); S.tip = info.blocks; S.nodeOk = true; S.nodeError = ''; S.cgp = await n.cgp().catch(() => null); break; }
    catch (e) {
      S.nodeOk = false; S.nodeError = e.message;
      if (!(e instanceof NodeError) || i === 2) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  refreshExtras().then(render);        // names, stats and contracts are shown when they arrive: the balance does not wait for them
}
async function loadCgpFund(n) {
  try {
    const id = Uint8Array.from(CGP_CONTRACT[net()].match(/../g).map(h => parseInt(h, 16)));
    const rows = await n.balance([encodeAddress(id, net(), true)]);
    const zp = (Array.isArray(rows) ? rows : []).filter(x => x && x.asset === '00').reduce((a, x) => a + BigInt(x.balance), 0n);
    S.stats = { ...(S.stats || {}), cgp: { ...(S.stats?.cgp || {}), balance: { zp: Number(zp) / 1e8, block: S.tip } } };
    render();
  } catch { /* the node has no address index: the fund stays "not available" */ }
}
async function refreshExtras() {
  const n = node(); if (!n) return;
  // the community site publishes stats.json next to /node/ (CGP fund balance, named contracts)
  S.stats = null;
  try {
    const u = new URL(S.settings.nodes[net()]);
    if (/\/node$/.test(u.pathname)) {
      const r = await fetch(u.origin + '/stats.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); if (j && typeof j === 'object') S.stats = j; }
      const ra = await fetch(u.origin + '/assets.json', { cache: 'no-cache' });
      if (ra.ok) {
        const j = await ra.json(), names = {};
        for (const x of Array.isArray(j?.assets) ? j.assets : []) if (typeof x?.asset === 'string' && typeof x?.name === 'string') names[x.asset] = x.name.slice(0, 40);
        S.assetNames = names;
      }
    }
  } catch { /* optional */ }
  // no stats.json (the testnet site, or a node of your own): ask the node's address index for the CGP contract's ZP.
  // On mainnet the contract has a long history and this can take minutes, so it runs in the background and only when needed.
  if (!(S.stats?.cgp?.balance && Number.isFinite(S.stats.cgp.balance.zp))) loadCgpFund(n);
  const list = Array.isArray(S.stats?.contracts) ? S.stats.contracts : await n.activeContracts().catch(() => null);
  S.contracts = Array.isArray(list) ? list
    .map(c => ({ id: String(c.id ?? c.contractId ?? ''), address: String(c.address ?? ''), expire: Number(c.expire) }))
    .filter(c => Number.isSafeInteger(c.expire) && /^c(zen|tzn)1[0-9a-z]+$/.test(c.address))
    .map(c => ({ ...c, name: nameOf(c.id, c.address) }))
    .sort((x, y) => x.expire - y.expire) : null;
}
async function refreshWallet(id, full, onState) {
  const n = node(), w = S.open.get(id); if (!n || !w) return;
  const d = S.data.get(id) || {};
  try {
    if (full || !d.discovered) { await discover(w, n); d.discovered = true; }
    d.state = await readState(w, n); d.error = '';
    S.data.set(id, d); if (onState) onState();                   // balance first: the history follows
    d.history = await readHistory(w, n);
    loadTxInfo(S.vault.wallets.find(x => x.id === id) || active(), d.history);
  } catch (e) { d.error = e.message; d.history ||= []; }
  S.data.set(id, d);
}
async function refreshAll(full = false) {
  S.busy = true; render();
  const nodeP = refreshNode(), a = active();                     // node status and the active wallet are asked at the same time
  if (a) await refreshWallet(a.id, full, () => { S.busy = false; render(); });
  await nodeP;
  if (a && S.nodeOk) for (const w of walletsHere()) if (w.id !== a.id) refreshWallet(w.id, full).then(render);
  S.busy = false; render();
}

async function openAll() {
  S.open.clear(); S.data.clear();
  for (const r of S.vault.wallets) S.open.set(r.id, openWallet(r, r.kind === 'watch' ? null : await open(S.key, r.box)));
}
function lock() {
  for (const w of S.open.values()) { for (const k of w.keys.values()) k.privateKey?.fill?.(0); w.account?.wipePrivateData?.(); }
  S.key = null; S.draft = {}; S.open.clear(); S.data.clear(); S.modal = null; go('unlock'); }

// ---------------------------------------------------------------- ballots sent from this browser, and the live parts of the vote forms
const VOTES_KEY = 'zp-wallet.votes.v1';
function loadVotes() {
  try { const v = JSON.parse(localStorage.getItem(VOTES_KEY)); return Array.isArray(v) ? v.filter(x => x && /^[0-9a-f]{64}$/.test(x.hash)).slice(-40) : []; } catch { return []; }
}
const saveVotes = () => { try { localStorage.setItem(VOTES_KEY, JSON.stringify((S.myVotes || []).slice(-40))); } catch { /* private mode */ } };
function rememberVote(v) { (S.myVotes ||= loadVotes()).push({ ...v, net: net(), at: Date.now(), state: 'pending' }); saveVotes(); }
// ask the node where each ballot of this browser is: not found yet, in the mempool, or in a block
async function refreshVotes() {
  const n = node(); if (!n || S.screen !== 'vote') return;
  let changed = false;
  // follow the chain: when a new phase opens (nominations, voting) the forms open without leaving the screen
  try {
    const before = S.tip ? phaseAt(CGP_PARAMS[net()], S.tip + 1) : null;
    const info = checkInfo(await n.info(), net());
    if (info.blocks !== S.tip) {
      S.tip = info.blocks; S.nodeOk = true;
      const after = phaseAt(CGP_PARAMS[net()], S.tip + 1);
      if (!before || before.phase !== after.phase || before.interval !== after.interval) {
        S.cgp = await n.cgp().catch(() => S.cgp); S.cands = null;   // candidates belong to one interval: ask again
        changed = true; phaseTurned = true;
      } else if (!document.activeElement?.closest?.('form[data-form]') && !S.modal) render();   // block count and "blocks left"
    }
  } catch { /* the next round tries again */ }
  for (const v of (S.myVotes ||= loadVotes()).filter(x => x.net === net() && x.state !== 'block')) {
    try {
      const t = await n.request('/blockchain/transaction?hash=' + v.hash), bn = t && (t.blockNumber ?? t.block);
      const st = (t && Number.isSafeInteger(t.confirmations) && t.confirmations > 0) || Number.isSafeInteger(bn) ? 'block' : 'mempool';
      if (st !== v.state) { v.state = st; if (Number.isSafeInteger(bn)) v.block = bn; changed = true; }
    } catch { /* not known to the node (yet) */ }
  }
  if (changed) { saveVotes(); if (!S.modal && (phaseTurned || !document.activeElement?.closest?.('form[data-form]'))) render(); }
  phaseTurned = false;
}
let phaseTurned = false;
// A ballot already sent from this browser for the same command, interval and phase by one of the selected wallets.
// Only the first ballot of each key counts in a phase (Tally_Handler), so a second one would only cost a fee.
const COMMAND_OF = { 'allocation vote': 'Allocation', 'payout vote': 'Payout', nomination: 'Nomination' };
function priorVote(command, interval, phase) {
  const sel = new Set(voters().map(w => w.id));
  const v = (S.myVotes ||= loadVotes()).find(x => x.net === net() && x.interval === interval && x.phase === phase
    && (x.command || COMMAND_OF[x.kind]) === command && x.state !== 'failed'
    && (!Array.isArray(x.voters) || x.voters.some(id => sel.has(id))));   // older records do not name the wallets: assume they apply
  if (!v) return null;
  const names = Array.isArray(v.voters) ? walletsHere().filter(w => v.voters.includes(w.id) && sel.has(w.id)).map(w => w.name) : [];
  return { v, names };
}
function votedText({ v, names }) {
  const who = names.length ? (names.length === 1 ? `Wallet “${names[0]}”` : `Wallets ${names.map(n => `“${n}”`).join(', ')}`) : 'This browser';
  return `${who} already sent a ${v.kind} in this phase (${v.label}). Only the first vote of a wallet counts and it cannot be changed${names.length ? '; to vote with other wallets, select only those' : ''}.`;
}
const votedBox = p => `<div class="card" data-s="flush"><p class="ok small">✓ ${esc(votedText(p))}</p></div>`;
function sentCard(c) {
  const list = (S.myVotes ||= loadVotes()).filter(v => v.net === net() && c && v.interval === c.interval).reverse();
  if (!list.length) return '';
  const badge = v => v.state === 'block' ? `<span class="ok nb">✓ In a block${v.block ? ' (' + Number(v.block).toLocaleString('en-US') + ')' : ''}</span>`
    : v.state === 'mempool' ? '<span class="warnc">Accepted, waiting for a block</span>' : '<span class="muted">Sent, waiting for the node</span>';
  return `<div class="card"><h2>Your ballots</h2><p class="muted small">Sent from this browser in interval ${c.community}. A ballot counts once it is in a block of its phase.</p>
    ${list.map(v => `<div class="kv"><span>${esc(v.kind)}: ${esc(v.label)}${v.to ? `<br><span class="mono small muted">${esc(shortAddr(v.to))}</span>` : ''}</span><span>${badge(v)}</span></div>`).join('')}</div>`;
}
// these parts change while typing: they are updated in place (a re-render would put the old field values back)
function syncAlloc(raw, from) {
  const inp = $app.querySelector('input[name=pct]'); if (!inp) return;
  const min = +inp.dataset.min, max = +inp.dataset.max, cur = +inp.dataset.cur, t = String(raw).trim(), n = Number(t);
  if (from !== 'field') inp.value = t;
  const okv = /^\d{1,3}$/.test(t) && n >= min && n <= max;
  const slider = $app.querySelector('input[name=pctr]'); if (slider && okv) slider.value = n;
  // the green part of the slider (style.css .slider): fraction of the allowed range, set through the CSSOM (the CSP forbids inline styles)
  if (slider) { const lo = +slider.min, hi = +slider.max, v = +slider.value; slider.style.setProperty('--f', hi > lo ? String((v - lo) / (hi - lo)) : '1'); }
  $app.querySelectorAll('[data-act=alloc-pick]').forEach(b => b.classList.toggle('on', b.dataset.v === t));
  const v = $app.querySelector('#alloc-v'), m = $app.querySelector('#alloc-m'), note = $app.querySelector('#alloc-note'), go = $app.querySelector('#alloc-go');
  if (v) v.textContent = okv ? `CGP ${n}%` : 'CGP ?';
  if (m) m.textContent = okv ? `miners ${100 - n}%` : '';
  if (note) {
    note.className = 'small ' + (okv || !t ? 'muted' : 'bad');
    const d = Math.abs(n - cur);
    note.textContent = !t ? '' : !okv ? `Only ${min}% to ${max}% counts` : n === cur ? 'Same as now: you vote to keep the split' : `${n > cur ? 'Raises' : 'Lowers'} the CGP share by ${d} point${d === 1 ? '' : 's'} (miners ${n > cur ? 'lose' : 'gain'} ${d})`;
  }
  if (go) go.disabled = !okv || !voters().length;
}
// about 4 minutes per block on mainnet: 365 blocks a day. The testnet pace varies, so only blocks are named there
// the date a block number is reached at the mainnet pace of about 4 minutes (the testnet pace varies, so no date there)
function dateAfter(blocks) {
  if (net() !== 'main' || !Number.isFinite(blocks) || blocks < 0) return '';
  return new Date(Date.now() + blocks * 240000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function extendPresets() {
  return net() === 'main' ? [[10950, '30 days'], [32850, '90 days'], [65700, '180 days'], [131400, '1 year']] : [[1000, '1,000'], [10000, '10,000'], [100000, '100,000']];
}
function syncExtend() {
  const m = S.modal, inp = $app.querySelector('input[name=blocks]'); if (!m || m.type !== 'extend' || !inp) return;
  const t = inp.value.trim(), n = Number(t), okn = /^\d{1,8}$/.test(t) && n >= 1 && n <= MAX_EXTEND_BLOCKS;
  $app.querySelectorAll('[data-act=ext-pick]').forEach(b => b.classList.toggle('on', b.dataset.v === t));
  const cost = $app.querySelector('#ext-cost'), nw = $app.querySelector('#ext-new'), note = $app.querySelector('#ext-note'), go = $app.querySelector('#ext-go');
  const price = okn ? extendCost(m.code, n) : null, short = price !== null && m.balance !== null && price > m.balance;
  cost.textContent = price === null ? '–' : formatZP(price) + ' ZP'; nw.textContent = okn ? (m.expire + n - 1).toLocaleString('en-US') + (dateAfter(m.expire + n - 1 - (S.tip || m.expire)) ? ' · around ' + dateAfter(m.expire + n - 1 - (S.tip || m.expire)) : '') : '–';
  note.className = 'small ' + (!t || (okn && !short) ? 'muted' : 'bad');
  note.textContent = !t ? '' : !okn ? `Enter a whole number of blocks, from 1 to ${MAX_EXTEND_BLOCKS.toLocaleString('en-US')}` : short ? 'Not enough ZP in this wallet' : (net() === 'main' ? (n < 365 ? 'Less than a day' : `About ${(n / 365).toLocaleString('en-US', { maximumFractionDigits: 1 })} days`) : '');
  go.disabled = !okn || short;
}
// the offer's total in satoshis from the form, whichever way the price is given
function offerTotal(f, kalapas) {
  const mode = S.modal?.mode || 'total';
  return mode === 'total' ? parseBTC(f.btc.value) : totalFromPerZp(f.per.value, kalapas, mode, btcUsd());
}
function syncOffer() {
  const f = $app.querySelector('form[data-form=offer]'), note = $app.querySelector('#offer-rate'); if (!f || !note) return;
  let z = null, b = null, err = ''; try { z = parseZP(f.zp.value.trim()); } catch { /* not yet */ }
  const typed = (f.btc || f.per)?.value.trim();
  if (z && z > 0n && typed) { try { b = offerTotal(f, z); } catch (e) { err = e.message; } }
  note.className = 'small ' + (err ? 'bad' : 'muted');
  note.textContent = err || (z && b ? ((S.modal?.mode || 'total') === 'total' ? '' : `Total ${formatBTC(b)} BTC · `) + rateText(b, z) : '');
}
// outputs spent by a transaction that is not in a block yet still show as unspent: do not use them twice
function pendingSpent(d) {
  const now = Date.now(), here = new Set(d.state.utxos.map(u => hex(u.outpoint.txHash) + ':' + u.outpoint.index));
  S.pendingVotes = (S.pendingVotes || []).filter(p => now - p.at < 30 * 60 * 1000 && here.has(p.spent));
  return S.pendingVotes.map(p => p.spent);
}
async function waitingFirst(exclude, fn) {
  try { return await fn(exclude); }
  catch (e) { if (exclude.length && /little ZP|Not enough/.test(e.message)) throw new Error('Your last transaction is still waiting for its block (about 4 minutes). Wait for it, then try again.'); throw e; }
}
function syncTo() {
  const inp = $app.querySelector('input[name=to]'), note = $app.querySelector('#to-note'); if (!inp || !note) return;
  const a = inp.value.replace(/\s+/g, ''); if (a !== inp.value) inp.value = a;
  if (!a) { note.textContent = ''; note.className = 'small'; return; }
  let msg, good = false;
  try {
    const d = decodeAddress(a), name = d.chain === 'main' ? 'mainnet' : 'testnet';
    if (d.chain !== net()) msg = `✗ This is a ${name} address, but this wallet is on ${net() === 'main' ? 'mainnet' : 'testnet'}`;
    else { good = true; const own = walletsHere().find(w => receiveAddress(S.open.get(w.id)) === a); msg = `✓ Valid ${name} ${d.contract ? 'contract ' : ''}address${own ? ` (your wallet “${own.name}”)` : ''}`; }
  } catch { msg = '✗ Not a valid address: check that every character was copied'; }
  note.textContent = msg; note.className = 'small ' + (good ? 'ok' : 'bad');
}
function syncAmt() {
  const inp = $app.querySelector('input[name=amount]'), note = $app.querySelector('#amt-note'); if (!inp || !note || !inp.closest('[data-form=vote-nom]')) return;
  const fund = inp.dataset.fund === '' ? null : Number(inp.dataset.fund), raw = inp.value.trim(); if (!raw) return;
  let amt = null; try { amt = parseZP(raw); } catch { /* invalid */ }
  const fundText = fund === null ? '' : `The CGP fund holds ${zpStr(fund)} ZP`;
  if (amt === null || amt <= 0n) { note.className = 'small bad'; note.textContent = 'Enter a positive amount, for example 1.5'; }
  else if (fund !== null && Number(amt) / 1e8 > fund) { note.className = 'small bad'; note.textContent = `${fundText}: ask for less`; }
  else { note.className = 'small muted'; note.textContent = fundText; }
}

// ---------------------------------------------------------------- events
$app.addEventListener('click', async e => {
  S.lastActivity = Date.now();
  const t = e.target.closest('button,[data-go]'); if (!t) return;
  if (t.dataset.go) {
    if (t.dataset.go === 'add') { S.draft = {}; S.tab = 'new'; }
    if (t.dataset.go === 'send') S.draft = {};
    return go(t.dataset.go);
  }
  if (t.dataset.tab) { S.tab = t.dataset.tab; S.error = ''; return render(); }
  if (t.dataset.mtab) { S.settings.mtab = t.dataset.mtab; saveSettings(); S.error = ''; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.wallet) { S.settings.active = t.dataset.wallet; saveSettings(); render(); if (!S.data.get(t.dataset.wallet)?.state) { await refreshWallet(t.dataset.wallet); render(); } return; }
  if (t.dataset.net) { S.settings.network = t.dataset.net; saveSettings(); S.tip = null; S.nodeOk = null; render(); return refreshAll(); }
  const act = t.dataset.act; if (!act) return;
  try {
    if (act === 'refresh') return refreshAll(true);
    if (act === 'vote-toggle' || act === 'vote-all' || act === 'vote-none') {
      const all = walletsHere().filter(w => w.kind !== 'watch').map(w => w.id);
      let sel = voters().map(w => w.id);
      if (act === 'vote-all') sel = all; else if (act === 'vote-none') sel = [];
      else sel = sel.includes(t.dataset.id) ? sel.filter(x => x !== t.dataset.id) : [...sel, t.dataset.id];
      S.settings.voteWallets[net()] = sel.length === all.length ? null : sel; saveSettings(); return render();
    }
    if (act === 'alloc-pick') return syncAlloc(t.dataset.v);
    if (act === 'use-addr') { const i = $app.querySelector('input[name=to]'); i.value = t.dataset.addr; return syncTo(); }
    if (act === 'paste-to') {
      const i = $app.querySelector('input[name=to]'), note = $app.querySelector('#to-note');
      try { i.value = (await navigator.clipboard.readText()).trim(); syncTo(); }
      catch { note.className = 'small bad'; note.textContent = 'This browser did not allow reading the clipboard: press and hold in the field, then choose Paste'; }
      return;
    }
    if (act === 'extend') {
      const k = S.contracts[+t.dataset.i], a = active(); if (!k || !a) return;
      const list = await node().activeContracts(), c = Array.isArray(list) ? list.find(x => x && (x.contractId === k.id || x.address === k.address)) : null;
      if (!c || typeof c.code !== 'string' || !c.code) throw new Error('The node did not return this contract’s code');
      await refreshWallet(a.id);
      const zp = S.data.get(a.id)?.state?.assets.find(x => x.asset === '00');
      S.modal = { type: 'extend', id: c.contractId, name: k.name, code: c.code, expire: Number(c.expire ?? c.expiry ?? k.expire), balance: S.data.get(a.id)?.state ? (zp?.spendable ?? 0n) : null, blocks: '' };
      S.error = ''; render(); return syncExtend();
    }
    if (act === 'ext-pick') { $app.querySelector('input[name=blocks]').value = t.dataset.v; return syncExtend(); }
    if (act === 'confirm-extend') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      S.busy = false; S.modal = { type: 'extended', hash, name: m.name, blocks: m.blocks }; render(); setTimeout(() => { refreshAll(); }, 5000); return;
    }
    if (act === 'cc-family') { const f = S.engine?.families?.find(x => x.id === t.dataset.id); if (!f) return; S.cc = { step: 'form', kind: 'make', family: f, values: {} }; return go('create'); }
    if (act === 'cc-open') return go('create');
    if (act === 'cc-ask') { S.cc = { step: 'ask', kind: 'ask', text: '' }; return go('create'); }
    if (act === 'cc-fill') { const i = $app.querySelector(`input[name="p_${t.dataset.name}"]`); if (i) { i.value = t.dataset.v; i.classList.remove('invalid'); syncBlockHint(i); } return; }
    if (act === 'cc-again') { S.cc = { ...S.cc, step: S.cc.kind === 'ask' ? 'ask' : 'form' }; S.error = ''; return render(); }
    if (act === 'cc-edit') { S.cc.editing = true; return render(); }
    if (act === 'cc-try-open') { const k = S.cc.try; S.cc.try = k && k.source === S.cc.source ? k : { source: S.cc.source, cmd: commandsOf(S.cc.family)[0]?.name, values: {}, signer: null, session: { wallet: [], state: null }, last: null, runs: 0 }; S.cc.step = 'try'; S.error = ''; render(); return window.scrollTo(0, 0); }
    if (act === 'cc-block') { if (S.cc?.try && !S.cc.try.running) { const f = $app.querySelector('form[data-form=cc-try]'), i = f?.querySelector('input[name=block]'); if (i) i.value = t.dataset.v; S.cc.try.block = Number(t.dataset.v);
      f?.querySelectorAll('[data-act=cc-block]').forEach(b => b.classList.toggle('on', b === t)); } return; }
    if (act === 'cc-view') { if (S.cc) { S.cc.view = t.dataset.v; render(); } return; }
    if (act === 'cc-activate-open') { if (!S.cc) return; S.cc.step = 'activate'; S.cc.blocks ||= 10800; S.error = ''; S.screen === 'create' ? render() : go('create'); window.scrollTo(0, 0); const a = active(); if (a) { await refreshWallet(a.id); render(); } return; }
    if (act === 'cc-activate-back') { if (S.cc) { S.cc.step = 'result'; S.error = ''; render(); } return; }
    if (act === 'cc-blocks') { if (!S.cc) return; if (t.dataset.v === 'custom') S.cc.customBlocks = true; else { S.cc.blocks = Number(t.dataset.v); S.cc.customBlocks = !DURATIONS.some(([b]) => b === S.cc.blocks); } S.error = ''; freshScreen = true; return render(); }
    if (act === 'cc-qr') { if (S.cc) { S.cc.showQr = !S.cc.showQr; render(); } return; }
    if (act === 'cc-share') { const text = t.dataset.text; try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); t.textContent = 'Copied'; } } catch { /* cancelled */ } return; }
    if (act === 'cc-active-done') return go('contracts');
    if (act === 'cc-open-mine') {
      const x = myContracts()[t.dataset.addr]; if (!x) return;
      const family = S.engine?.families?.find(f => f.id === x.family) || null;
      S.cc = { step: 'active', kind: 'make', family, activated: true, done: { name: x.name, address: t.dataset.addr, id: x.id || '', until: x.until } }; return go('create');
    }
    if (act === 'cc-try-back') { if (S.cc) { S.cc.step = 'result'; S.error = ''; render(); window.scrollTo(0, 0); } return; }
    if (act === 'cc-cmd') { if (S.cc?.try && !S.cc.try.running) { S.cc.try.cmd = t.dataset.name; S.cc.try.signer = null; S.cc.try.values = {}; S.error = ''; render(); } return; }
    if (act === 'cc-try-reset') { if (S.cc?.try && !S.cc.try.running) { Object.assign(S.cc.try, { session: { wallet: [], state: null }, last: null, runs: 0, block: null }); S.error = ''; render(); } return; }
    if (act === 'cc-reset') { S.cc = { ...S.cc, source: S.cc.job.source, edited: false, editing: false, check: null }; return render(); }
    if (act === 'confirm-activate') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      for (const sp of m.prepared.spent || []) (S.pendingVotes ||= []).push({ spent: sp, at: Date.now() });
      S.busy = false; S.modal = { type: 'activated', hash, address: m.prepared.address, blocks: m.prepared.blocks }; render(); setTimeout(() => refreshAll(), 30000); return;
    }
    if (act === 'swap-new') {
      const a = active(); await refreshWallet(a.id);
      const z = S.data.get(a.id)?.state?.assets.find(x => x.asset === '00');
      S.modal = { type: 'offer', mode: btcUsd() ? 'usd' : 'total', balance: S.data.get(a.id)?.state ? (z?.spendable ?? 0n) : null }; S.error = ''; render(); return syncOffer();
    }
    if (act === 'confirm-offer' || act === 'confirm-cancel') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      for (const sp of m.prepared.spent) (S.pendingVotes ||= []).push({ spent: sp, at: Date.now() });
      if (act === 'confirm-cancel' && m.id) (S.takingBack ||= {})[m.id] = Date.now();
      if (act === 'confirm-offer' && m.scripts) rememberScripts(m.scripts);
      if (act === 'confirm-offer' && m.id) addPendingOffer({ id: m.id, amount: String(m.amount), sats: Number(m.sats), at: Date.now(), net: net(), swapId: S.swap?.swapId });
      S.busy = false; S.modal = { type: 'swap-sent', hash, text: act === 'confirm-offer' ? `Your offer of ${formatZP(m.amount)} ZP for ${formatBTC(m.sats)} BTC was sent. It shows under Your offers right away, marked as waiting for the next block.` : 'The offer is being taken back: the ZP returns to your wallet.' };
      render(); setTimeout(() => { loadSwap(); refreshAll(); }, 30000); return;
    }
    if (act === 'price-mode') {
      const f = $app.querySelector('form[data-form=offer]'), m = S.modal;
      Object.assign(m, { zp: f.zp.value, addrs: f.addrs.value, btc: f.btc?.value ?? m.btc, per: f.per?.value ?? m.per, mode: t.dataset.v });
      if (m.mode !== 'total') m.per = '';   // a number typed in $ is not a number in sat
      freshScreen = true; render(); return syncOffer();
    }
    if (act === 'swap-cancel') {
      const o = S.swap?.offers.find(x => x.id === t.dataset.id), w = o && mySellers().get(o.seller); if (!o || !w) return;
      await refreshWallet(w.id);
      const d = S.data.get(w.id); if (!d?.state) throw new Error('Could not read the balance from the node');
      const prepared = await waitingFirst(pendingSpent(d), ex => prepareCancel({ w: S.open.get(w.id), state: d.state, node: node(), swapContractId: S.swap.swapId, id: o.id, amount: BigInt(o.amount), exclude: ex }));
      S.modal = { type: 'confirm-cancel', id: o.id, prepared, amount: BigInt(o.amount), sats: o.sats, wallet: w.name }; S.error = ''; return render();
    }
    if (act === 'close') { stopScan(); S.modal = null; S.error = ''; return render(); }
    if (act === 'cc-scan') { S.modal = { type: 'scan', field: t.dataset.name }; S.error = ''; render(); return startScan(); }
    if (act === 'cc-paste') {
      const i = $app.querySelector(`input[name="p_${t.dataset.name}"]`); if (!i) return;
      let txt = ''; try { txt = await navigator.clipboard.readText(); } catch { i.focus(); throw fieldError('The browser did not allow pasting from here: long-press (or right-click) the field and paste', 'p_' + t.dataset.name); }
      i.value = (txt.match(/0[23][0-9a-fA-F]{64}/)?.[0] || txt.trim()).toLowerCase(); i.classList.remove('invalid'); return;
    }
    if (act === 'cc-asset' || act === 'cc-asset-other') {
      const i = $app.querySelector(`input[name="p_${t.dataset.name}"]`); if (!i || !S.cc) return;
      (S.cc.assetOther ||= {})[t.dataset.name] = act === 'cc-asset-other';
      const f = $app.querySelector('form[data-form=cc-make]'); if (f) S.cc.values = { ...S.cc.values, ...Object.fromEntries([...new FormData(f)].map(([k, v]) => [k.replace(/^p_/, ''), v])) };
      S.cc.values[t.dataset.name] = act === 'cc-asset' ? t.dataset.v : ''; freshScreen = true; render();
      if (act === 'cc-asset-other') $app.querySelector(`input[name="p_${t.dataset.name}"]`)?.focus();
      return;
    }
    if (act === 'lock') return lock();
    if (act === 'toggle-pw') { const inp = t.parentElement.querySelector('input'), show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; t.textContent = show ? 'Hide' : 'Show'; t.setAttribute('aria-pressed', String(show)); t.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); return; }
    if (act === 'send-back') { S.draft = { ...S.draft, to: t.dataset.to }; return go('send'); }
    if (act === 'copy') { await navigator.clipboard.writeText(t.dataset.text); t.innerHTML = I.copy + 'Copied'; return; }
    if (act === 'max') { const zp = S.data.get(active().id)?.state?.assets.find(x => x.asset === '00'); $app.querySelector('[name=amount]').value = formatZP(zp?.spendable || 0n).replace(/,/g, ''); return; }
    if (act === 'node-default') { S.settings.nodes[net()] = defaultNode(net()); saveSettings(); render(); return refreshAll(); }
    if (act === 'reveal') { const r = S.vault.wallets.find(w => w.id === t.dataset.id); S.modal = { type: 'reveal', id: r.id, name: r.name, kind: r.kind }; S.error = ''; return render(); }
    if (act === 'remove') { const r = S.vault.wallets.find(w => w.id === t.dataset.id); S.modal = { type: 'confirm', title: `Remove ${r.name}?`, text: 'It is deleted from this browser. Without its 24 words or key you cannot get it back.', ok: 'Remove', act: 'do-remove', id: r.id }; return render(); }
    if (act === 'do-remove') { S.vault.wallets = S.vault.wallets.filter(w => w.id !== t.dataset.id); storage.save(S.vault); S.open.delete(t.dataset.id); S.modal = null; return render(); }
    if (act === 'reset') { S.modal = { type: 'confirm', title: 'Remove all wallets from this browser?', text: 'Only do this if you have the 24 words or keys of every wallet. Then add them again with a new password.', ok: 'Remove all', act: 'do-reset' }; return render(); }
    if (act === 'do-reset') { storage.clear(); S.vault = null; S.modal = null; return go('welcome'); }
    if (act === 'load-cands') { S.cands = await node().candidates(); if (!Array.isArray(S.cands)) S.cands = []; return render(); }
    if (act === 'vote-cand') { const x = S.cands[+t.dataset.i]; return await reviewVote('payout vote', 'Payout', candidateBallot(x), `Pay ${x.spendlist.map(s => s.asset === '00' ? formatZP(BigInt(s.amount)) + ' ZP' : 'asset').join(' + ')}`, [['To', x.recipient, true]]); }
    if (act === 'confirm-vote') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      (S.pendingVotes ||= []).push({ spent: m.prepared.spent, at: Date.now() });
      rememberVote({ hash, kind: m.kind, command: m.command, voters: m.voters, label: m.label, to: (m.rows || []).find(r => r[0] === 'To')?.[1] || '', interval: m.prepared.phase.interval, phase: m.prepared.phase.phase });
      S.busy = false; S.modal = { type: 'voted', hash, kind: m.kind, label: m.label }; render(); setTimeout(refreshVotes, 5000); return;
    }
    if (act === 'confirm-send') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      S.busy = false; S.modal = { type: 'sent', amount: m.amount, hash }; S.draft = {};
      S.screen = 'home'; render(); setTimeout(() => refreshAll(), 1500); return;
    }
  } catch (err) { fail(err); }
});

$app.addEventListener('input', e => {
  const t = e.target; S.lastActivity = Date.now();
  if (t.name === 'pct') syncAlloc(t.value, 'field');
  else if (t.name === 'pctr') syncAlloc(t.value, 'slider');
  else if (t.name === 'to' && t.closest('[data-form=vote-nom]')) syncTo();
  else if (t.name === 'amount') syncAmt();
  else if (t.name === 'blocks') syncExtend();
  else if (t.name === 'zp' || t.name === 'btc' || t.name === 'per') syncOffer();
  else if (t.dataset?.block) syncBlockHint(t);
  if (t.classList?.contains('invalid')) { t.classList.remove('invalid'); t.removeAttribute('aria-invalid'); }
});

$app.addEventListener('submit', async e => {
  e.preventDefault(); S.lastActivity = Date.now();
  const f = e.target, v = Object.fromEntries(new FormData(f));
  try {
    switch (f.dataset.form) {
      case 'create-vault': {
        if (v.p1 !== v.p2) throw new Error('The passwords differ');
        S.busy = true; render();
        const { vault, key } = await createVault(v.p1);
        S.vault = vault; S.key = key; storage.save(vault); S.busy = false; S.draft = {}; S.tab = 'new'; return go('add');
      }
      case 'unlock': {
        S.busy = true; render();
        S.key = await unlockVault(S.vault, v.p); await openAll(); S.busy = false;
        go('home'); return refreshAll();
      }
      case 'add-wallet': {
        const rec = { id: crypto.randomUUID(), name: (v.name || 'Wallet').trim().slice(0, 40), network: net(), createdAt: Date.now() };
        let secret = null;
        if (S.tab === 'new') { rec.kind = 'mnemonic'; secret = S.draft.words.join(' '); }
        else if (S.tab === 'phrase') { secret = v.words.trim().toLowerCase().split(/\s+/).join(' '); if (!checkMnemonic(secret)) throw new Error('These words are not a valid recovery phrase. Check spelling and order.'); rec.kind = 'mnemonic'; }
        else if (S.tab === 'key') { rec.kind = 'key'; secret = v.key.trim(); }
        else { const a = v.addr.trim(); if (!isValidAddress(a, net())) throw new Error(`Not a valid ${net() === 'main' ? 'mainnet' : 'testnet'} address`); rec.kind = 'watch'; rec.addresses = [a]; }
        const opened = openWallet(rec, secret);               // validates the key before saving
        if (secret) rec.box = await seal(S.key, secret);
        S.vault.wallets.push(rec); storage.save(S.vault); S.open.set(rec.id, opened);
        S.settings.active = rec.id; saveSettings(); S.draft = {};
        go('home'); return refreshAll(true);
      }
      case 'send': {
        const to = v.to.trim(); S.draft = { to, amount: v.amount };
        if (!isValidAddress(to, net())) { decodeAddress(to); throw new Error('Not a valid address for this network'); }
        const raw = v.amount.trim();
        const amount = parseZP(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw);   // only thousands separators; "1,5" is refused
        if (amount <= 0n) throw new Error('Enter an amount');
        const a = active(); await refreshWallet(a.id);
        const d = S.data.get(a.id);
        if (!d?.state || d.error) throw new Error('Could not read the balance from the node' + (d?.error ? ': ' + d.error : ''));
        const prepared = prepareSend(S.open.get(a.id), S.data.get(a.id).state, to, amount);
        S.modal = { type: 'confirm-send', to, amount, prepared }; S.error = ''; return render();
      }
      case 'vote-alloc': {
        S.draft.pct = v.pct; const pct = Number(v.pct.trim());
        const r = allocationRange(CGP_PARAMS[net()], alloc());
        if (!(pct >= r.min && pct <= r.max)) throw new Error(`With ${alloc()}% in force, only ${r.min}% to ${r.max}% counts`);
        return await reviewVote('allocation vote', 'Allocation', allocationBallot(pct), `${pct}% of block rewards to the CGP`, [['Now in force', `${alloc()}%`]]);
      }
      case 'vote-nom': {
        S.draft.nto = v.to; S.draft.namount = v.amount;
        const to = v.to.trim(); let ok = false; try { ok = decodeAddress(to).chain === net(); } catch { /* invalid */ }
        if (!ok) throw new Error('Not a valid address for this network');
        const amount = parseZP(v.amount.trim()); if (amount <= 0n) throw new Error('Enter an amount');
        const fund = S.stats?.cgp?.balance?.zp; if (Number.isFinite(fund) && Number(amount) / 1e8 > fund) throw new Error(`The CGP fund holds ${zpStr(fund)} ZP: ask for less`);
        return await reviewVote('nomination', 'Nomination', payoutBallot(to, [{ asset: ZP, amount }]), `Pay ${formatZP(amount)} ZP`, [['To', to, true]]);
      }
      case 'extend': {
        const m = S.modal, blocks = Number(v.blocks.trim()), a = active(); m.blocks = v.blocks;
        await refreshWallet(a.id);
        const d = S.data.get(a.id); if (!d?.state || d.error) throw new Error('Could not read the balance from the node');
        const prepared = prepareExtend(S.open.get(a.id), d.state, m.id, m.code, blocks);
        S.modal = { ...m, type: 'confirm-extend', blocks, prepared }; S.error = ''; return render();
      }
      case 'offer': {
        const m = S.modal; Object.assign(m, { zp: v.zp, btc: v.btc, per: v.per, addrs: v.addrs });
        const raw = v.zp.trim(), amount = parseZP(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw);
        if (amount <= 0n) throw new Error('Enter the ZP to sell');
        const sats = offerTotal(f, amount);
        const addrs = v.addrs.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
        if (!addrs.length || addrs.length > MAX_SCRIPTS) throw fieldError(`Give 1 to ${MAX_SCRIPTS} Bitcoin addresses`, 'addrs');
        const scripts = addrs.map((x, i) => { try { return btcScript(x, S.swap?.btcNet === 'test' ? 'test' : 'main'); } catch (e) { throw fieldError(`Bitcoin address ${i + 1}: ${e.message}`, 'addrs'); } });
        if (new Set(scripts).size !== scripts.length) throw fieldError('Each Bitcoin address must be different', 'addrs');
        if (!S.swap?.swapId) throw new Error('The swap contract is not running on this network');
        const market = S.swap.offers.flatMap(o => Array.isArray(o.scriptList) ? o.scriptList : []);
        const fresh = await checkFresh(scripts, addrs, { known: usedScripts(), market, api: BTC_API[S.swap?.btcNet === 'test' ? 'test' : 'main'] });
        if (fresh.bad.length) throw fieldError('Use a new Bitcoin address for each line: ' + fresh.bad.join('; ') + '.', 'addrs');
        const a = active(); await refreshWallet(a.id);
        const d = S.data.get(a.id); if (!d?.state || d.error) throw new Error('Could not read the balance from the node');
        const offerId = newOfferId();
        const prepared = await waitingFirst(pendingSpent(d), ex => prepareOffer({ w: S.open.get(a.id), state: d.state, node: node(), swapContractId: S.swap.swapId, id: offerId, amount, sats, scripts, exclude: ex }));
        S.modal = { type: 'confirm-offer', id: offerId, prepared, amount, sats, addrs, scripts, unchecked: !fresh.checked }; S.error = ''; return render();
      }
      case 'cc-make': {
        const c = S.cc, params = {}; c.values = {};
        for (const [n, p] of Object.entries(c.family.params)) {
          c.values[n] = v['p_' + n] ?? '';
          let x; try { x = checkParam(n, p, c.values[n]); } catch (e) { throw fieldError(e.message.replace(n + ':', paramUI(c.family.id, n, p).label + ':'), 'p_' + n); }
          if (x !== null) params[n] = x;
        }
        return await ccRun('make', e => e.make(c.family.id, params));
      }
      case 'cc-ask': {
        S.cc.text = v.text.trim(); if (S.cc.text.length < 10) throw new Error('Say a little more about what the contract should do');
        return await ccRun('ask', e => e.ask(S.cc.text));
      }
      case 'cc-try': { if (S.cc?.try?.running) return; return await ccTry(v); }
      case 'cc-check': {
        const src = v.source; if (src === S.cc.source && !S.cc.edited) { S.cc.editing = false; return render(); }
        v1ContractId(src);   // size and text rules first
        S.cc = { ...S.cc, source: src, edited: src !== S.cc.job.source, check: null };
        if (!S.cc.edited) { S.cc.editing = false; return render(); }
        const e = engine(), res = await e.check(src); S.busy = true; render();
        const j = await e.wait(res.job, null, { stopped: () => S.screen !== 'create' });
        S.busy = false; if (!j) return;
        if (j.status !== 'done' || !j.check) throw new Error(j.error || 'The engine could not check it: try again later');
        S.cc = { ...S.cc, check: j.check, checkedSource: src, editing: j.check.verdict !== 'accepted' }; S.error = ''; return render();
      }
      case 'cc-activate': {
        const c = S.cc, blocks = Number(String(v.blocks ?? c.blocks).trim()), a = active();
        if (!Number.isSafeInteger(blocks) || blocks < 1) throw fieldError('Blocks: a whole number from 1', 'blocks');
        c.blocks = blocks;
        if (!a || !canSpend(S.open.get(a.id))) throw new Error('Choose a wallet that can sign');
        await refreshWallet(a.id); const d = S.data.get(a.id); if (!d?.state || d.error) throw new Error('Could not read the balance from the node');
        // the id the wallet signs for: the engine's report for its own source, the engine's check for an edited one
        const expect = c.edited ? c.check?.contractId : c.job.report?.contractId;
        const prepared = prepareActivateV1(S.open.get(a.id), d.state, c.source, blocks, expect);
        S.busy = true; render();
        try {
          const hash = await publish(node(), prepared);
          for (const sp of prepared.spent || []) (S.pendingVotes ||= []).push({ spent: sp, at: Date.now() });
          const name = c.family ? famName(c.family) : 'Described contract', until = (S.tip || 0) + 1 + blocks;
          rememberContract(prepared.address, { name, family: c.family?.id || null, id: prepared.contractId, until, at: Date.now() });
          S.cc = { ...c, step: 'active', activated: true, done: { name, address: prepared.address, id: prepared.contractId, until, hash } }; saveCc(null);
          S.error = ''; window.scrollTo(0, 0); setTimeout(() => refreshAll(), 30000);
        } finally { S.busy = false; render(); }
        return;
      }
      case 'node': {
        const url = v.url.trim().replace(/\/+$/, '');
        let u = null; try { u = url && new URL(url); } catch { /* invalid */ }
        if (url && !(u && (u.protocol === 'https:' || (u.protocol === 'http:' && (['localhost', '127.0.0.1'].includes(u.hostname) || u.origin === location.origin))) && !u.username && !u.password))
          throw new Error('Use https://, or http://localhost for a node on this computer (or the address of the site that serves this wallet)');
        S.settings.nodes[net()] = url; saveSettings(); S.error = '';
        await refreshAll(); if (!S.nodeOk) throw new Error('Saved, but ' + (S.nodeError || 'the node does not answer'));
        return;
      }
      case 'reveal': {
        await unlockVault(S.vault, v.p);
        const r = S.vault.wallets.find(w => w.id === S.modal.id);
        S.modal.secret = await open(S.key, r.box); S.error = ''; return render();
      }
    }
  } catch (err) { fail(err); }
});

// auto-lock after inactivity; refresh balances every 2 minutes
setInterval(() => { if (S.key && Date.now() - S.lastActivity > LOCK_AFTER_MS) lock(); }, 30000);
setInterval(() => { if (S.key && S.screen === 'home' && !S.modal) refreshAll(); }, 120000);
setInterval(() => { if (S.key && S.screen === 'vote' && !S.modal) refreshVotes(); }, 20000);
// the ZP ⇄ BTC tab follows the market as the site's page does (reservations, payments, a sent offer, a take-back)
setInterval(() => { if (S.key && S.screen === 'markets' && (S.settings.mtab || 'oracle') === 'swap' && !S.modal && !document.hidden) loadSwap(); }, 30000);
['keydown', 'pointerdown'].forEach(ev => addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));

(async () => {
  try {
    const r = await fetch('config.json', { cache: 'no-cache' });
    const j = r.ok ? await r.json() : null;
    if (typeof j?.testNode === 'string' && /^https?:\/\//.test(j.testNode) && new URL(j.testNode).origin === location.origin || (typeof j?.testNode === 'string' && j.testNode.startsWith('https://'))) {
      S.siteDefaults = { test: j.testNode.replace(/\/+$/, '') };
      if (!S.settings.nodes.test) { S.settings.nodes.test = S.siteDefaults.test; saveSettings(); }
    }
  } catch { /* no config: nothing to default */ }
  go(S.vault ? 'unlock' : 'welcome');
  refreshNode().then(render);
})();

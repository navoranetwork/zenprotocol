// ZP Wallet - user interface. Plain DOM, no framework; every value shown that comes from a user
// or a node goes through esc(). Secrets live in memory only while unlocked.
import qrcode from 'qrcode-generator';
import { newMnemonic, checkMnemonic, isValidAddress, decodeAddress, encodeAddress } from '../src/keys.js';
import { NodeClient, NodeError, DEFAULT_NODES } from '../src/node.js';
import { createVault, unlockVault, seal, open, storage } from '../src/vault.js';
import { CGP_PARAMS, VOTING_CONTRACT, CGP_CONTRACT, allocationRange, allocationBallot, payoutBallot, candidateBallot, phaseAt, snapshotBlock, phasesOf } from '../src/cgp.js';
import { openWallet, prepareVote, checkInfo, discover, readState, readHistory, prepareSend, prepareExtend, extendCost, MAX_EXTEND_BLOCKS, publish, receiveAddress, canSpend, addresses, prepareOffer, prepareCancel, signerOf, prepareActivateV1, prepareContractCall, prepareCombine } from '../src/wallet.js';
import { orderOf, makeBody, cancelBody, takeBody, payoutFor, pkHashOf, mine as myOrder, expectTake, expectMake, expectCancel, bookRow, bookFromOrders, levels, parsePrice, limitOrder } from '../src/dex.js';
import { marketOf, marketsOf, sideAsset, bestBid, bidPrice, sellOrder, bestOffer, offerPrice, betQuote, redeemBody, redeemValue, expectRedeem } from '../src/bets.js';
import { btcScript, parseBTC, formatBTC, newOfferId, MAX_SCRIPTS, totalFromPerZp, checkFresh, BTC_API } from '../src/swap.js';
import { BLOCK_MIN, PROOF_MIN, holdOf, payOf, confsFor, afterPayMin, buyMin, payCheck, bip21, findBtcWallets, connectBtcWallet, payWithWallet, parseAccount, freshAddresses, fetchFeeRate } from '../src/btc.js';
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
const BUILTIN_NAMES = typeof __ASSET_NAMES__ === 'object' && __ASSET_NAMES__ ? __ASSET_NAMES__ : {};
// a token's amount as its users read it: zUSDC has 6 decimals (as USDC), other tokens are shown in units of 1e-8 like ZP
// zUSDC has 6 decimals; an Up or Down token counts units of its market's collateral, so it has the collateral's
const decimalsOf = asset => S.betDec?.[asset] ?? (asset !== '00' && /^zUSDC\b/.test(S.assetNames[asset] || '') ? 6 : 8);
const unitOf = asset => asset === '00' ? 'ZP' : (S.assetNames[asset] || 'Token ' + String(asset).slice(8, 16) + '…');
function fmtUnits(units, dec) {
  const v = BigInt(units), neg = v < 0n, a = neg ? -v : v, d = 10n ** BigInt(dec), whole = (a / d).toLocaleString('en-US');
  let frac = (a % d).toString().padStart(dec, '0').replace(/0+$/, ''); if (dec === 6 && frac.length < 2) frac = frac.padEnd(2, '0');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}
const tokenAmount = (asset, units) => asset === '00' ? formatZP(units) : fmtUnits(units, decimalsOf(asset));
const withUnit = (asset, units) => tokenAmount(asset, units) + ' ' + unitOf(asset);
// a token's icon where the wallet has one (zUSDC: Navora's own icon for the bridge token)
const ICONS = typeof __ICONS__ === 'object' && __ICONS__ ? __ICONS__ : {};
// the Bitcoin logo (public domain) next to BTC amounts and the Bitcoin side
const btcLogo = (n = 18) => ICONS.btc ? `<img class="ticon" src="${ICONS.btc}" alt="" width="${n}" height="${n}">` : '';
const btcAmt = (sats, n = 18) => `<span class="tname">${btcLogo(n)}${esc(formatBTC(sats))} BTC</span>`;
const zpLogo = (n = 18) => ICONS.zp ? `<img class="ticon" src="${ICONS.zp}" alt="" width="${n}" height="${n}">` : '';
const tokenIcon = (asset, size = 20) => asset === '00' ? zpLogo(size) : /^zUSDC$/.test(S.assetNames[asset] || '') && ICONS.zusdc ? `<img class="ticon" src="${ICONS.zusdc}" alt="" width="${size}" height="${size}">` : '';
// sending to the site's USDC bridge: zUSDC is a withdrawal (paid in USDC to the linked EVM address), anything else is lost
const toBridge = to => !!(S.bridge && String(to || '').trim() === S.bridge.zp);
const bridgeWait = () => `about ${S.bridge.conf * 4} to ${S.bridge.conf * 5} minutes (${S.bridge.conf} ZP blocks; longer when testnet blocks are slow)`;
// ---------------------------------------------------------------- Dex (contracts/v1/Dex.fst through src/dex.js)
// orders come from the site's index, which trails the chain by about 10 blocks; an order taken or cancelled here is
// marked at once and disappears when the Dex no longer holds it
const dexPending = new Map();   // order tx -> 'taking' | 'cancelling'
const myPub = () => { const k = signerOf(S.open.get(active().id)); return k ? hex(k.publicKey) : ''; };
function orderLine(o) {
  const price = Number(o.pairTotal) / 10 ** decimalsOf(o.pairAsset) / (Number(o.underAmount) / 10 ** decimalsOf(o.underAsset));
  return `Sells <b>${esc(withUnit(o.underAsset, o.underAmount))}</b> for ${esc(withUnit(o.pairAsset, o.pairTotal))}<div class="muted small">${esc(price.toLocaleString('en-US', { maximumSignificantDigits: 6 }))} ${esc(unitOf(o.pairAsset))} per ${esc(unitOf(o.underAsset))}</div>`;
}
// ---- the order book of ZP / zUSDC: the site's /dex/book (fresh to one block, mempool orders marked pending), or built
// here from /dex/orders on an older site. Tap a price to take its best order; Buy / Sell makes a limit order.
// an order made here shows in the book at once, marked as waiting for its block, until the site lists it (30 min at most)
const DEX_MADE_KEY = 'zp-wallet.dex-made.v1';
const dexMade = () => { try { const v = JSON.parse(localStorage.getItem(DEX_MADE_KEY)); return Array.isArray(v) ? v.filter(x => x && x.net === net() && typeof x.tx === 'string' && Date.now() - x.at < 30 * 60e3) : []; } catch { return []; } };
const dropDexMade = txs => { try { localStorage.setItem(DEX_MADE_KEY, JSON.stringify(dexMade().filter(x => !txs.includes(x.tx)))); } catch { /* private mode */ } };
const addDexMade = x => { try { localStorage.setItem(DEX_MADE_KEY, JSON.stringify([...dexMade(), x].slice(-20))); } catch { /* private mode */ } };
const quoteId = () => Object.keys(S.assetNames).find(k => S.assetNames[k] === 'zUSDC') || null;
function bookData(m) {
  const q = quoteId(); if (!q) return null;
  let asks, bids;
  if (m.book && Array.isArray(m.book.asks) && Array.isArray(m.book.bids)) {
    const norm = (list, side) => list.map(r => { try { const row = bookRow(orderOf({ ...r.order, tx: r.tx }), q); return row && row.side === side ? { ...row, pending: !!r.pending, busy: r.pendingTake ? 'taking' : r.pendingCancel ? 'cancelling' : null } : null; } catch { return null; } }).filter(Boolean);
    asks = norm(m.book.asks, 'ask').sort((a, b) => a.price - b.price); bids = norm(m.book.bids, 'bid').sort((a, b) => b.price - a.price);
  } else ({ asks, bids } = bookFromOrders((m.orders || []).map(r => { try { return orderOf(r); } catch { return null; } }).filter(Boolean), q));
  const seen = new Set([...asks, ...bids, ...(m.orders || []).map(r => ({ o: { tx: r.tx } }))].map(r => r.o.tx));
  const listed = dexMade().filter(x => seen.has(x.tx)).map(x => x.tx); if (listed.length) dropDexMade(listed);   // the site has it: the local copy is done
  for (const x of dexMade()) {
    if (seen.has(x.tx)) continue;
    try { const r = bookRow(orderOf(x), q); if (r) (r.side === 'ask' ? asks : bids).push({ ...r, pending: true, local: true }); } catch { /* not an order */ }
  }
  asks.sort((a, b) => a.price - b.price); bids.sort((a, b) => b.price - a.price);
  for (const r of [...asks, ...bids]) if (dexPending.has(r.o.tx)) r.busy = dexPending.get(r.o.tx);
  return { q, asks, bids, last: m.book?.last || null, asOf: Number(m.book?.tip) || null };
}
const zpShort = k => (Number(k) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });
function bookView(m, me, spendable) {
  const d = bookData(m); if (!d) return '';
  const la = levels(d.asks, 'ask').slice(0, 10), lb = levels(d.bids, 'bid').slice(0, 10);
  S.bookView = { asks: la, bids: lb, q: d.q };
  const max = [...la, ...lb].reduce((a, l) => l.total > a ? l.total : a, 1n);
  const row = (l, side, i) => {
    const take = l.rows.find(r => !r.pending && !r.busy && !myOrder(r.o, me)), mineL = l.rows.some(r => myOrder(r.o, me)), pend = l.rows.every(r => r.pending), busy = !pend && l.rows.every(r => r.busy || r.pending);
    const tip = [mineL ? (pend ? 'Your order, waiting for its block (about 4 min)' : 'Your order: cancel it under Your orders') : '', !mineL && pend ? 'Waiting for its block: it can be taken after that' : '', busy ? (l.rows.some(r => r.busy === 'cancelling') ? 'Being cancelled: it leaves the book with the next block (about 4 min)' : 'Being taken: it leaves the book with the next block (about 4 min)') : '', take && spendable ? `Tap to ${side === 'ask' ? 'buy' : 'sell'} at ${l.price.toFixed(4)}` : ''].filter(Boolean).join('. ');
    return `<button type="button" class="lvl ${side}${mineL ? ' mine' : ''}${pend ? ' pend' : ''}${busy ? ' busy' : ''}" data-act="dex-level" data-side="${side}" data-i="${i}" title="${esc(tip)}" ${take && spendable ? '' : 'disabled'}><span class="ld" data-w="${Number(l.total * 100n / max)}"></span><span class="lp">${l.price.toFixed(4)}${mineL ? '<i class="dot" aria-label="yours"></i>' : ''}</span><span class="ls">${zpShort(l.size)}</span><span class="lt">${zpShort(l.total)}</span></button>`;
  };
  const ba = d.asks.find(r => !r.pending), bb = d.bids.find(r => !r.pending);
  const lp = d.last && Number(d.last.price) > 0 ? Number(d.last.price) : null, mid = ba && bb ? (ba.price + bb.price) / 2 : null, big = lp ?? mid;
  const up = d.last?.side === 'buy', spreadTxt = ba && bb ? `Spread ${(ba.price - bb.price).toFixed(4)} · ${((ba.price - bb.price) / ((ba.price + bb.price) / 2) * 100).toFixed(1)}%${ba.price <= bb.price ? ' · crossed' : ''}` : 'One side is empty';
  const midRow = `<div class="midrow"><span class="midp ${lp ? (up ? 'up' : 'down') : ''}">${big ? big.toFixed(4) : '–'}${lp ? (up ? ' ↑' : ' ↓') : ''}</span><span class="mids">${lp ? 'last trade' : mid ? 'mid price' : ''}<br>${esc(spreadTxt)}</span></div>`;
  return `<div class="card book"><div class="row" data-s="between"><h2 class="tname">${zpLogo(20)}ZP / ${tokenIcon(d.q, 20)}zUSDC</h2><span class="small muted" data-s="fixed">${d.asOf ? 'block ' + d.asOf.toLocaleString('en-US') : ''}</span></div>
    <div class="bookhead"><span>Price (zUSDC)</span><span>Size (ZP)</span><span>Sum (ZP)</span></div>
    <div class="asks" aria-label="Asks: people selling ZP">${la.length ? la.map((l, i) => row(l, 'ask', i)).reverse().join('') : '<p class="muted small empty">No one is selling ZP.</p>'}</div>
    ${midRow}
    <div class="bids" aria-label="Bids: people buying ZP">${lb.length ? lb.map((l, i) => row(l, 'bid', i)).join('') : '<p class="muted small empty">No one is buying ZP.</p>'}</div>
    <p class="muted small booknote">${spendable ? 'Tap a red price to buy, a green one to sell.' : 'Open a wallet that can sign to trade.'} <i class="dot"></i> yours · faded: waiting for a block (a new order, or one being taken or cancelled)</p></div>
    ${spendable ? limitForm(d, ba, bb) : ''}${tradesCard(m)}`;
}
function limitForm(d, ba, bb) {
  const side = S.draft.dside === 'sell' ? 'sell' : 'buy', ref = side === 'buy' ? ba : bb;
  return `<form class="card" data-form="dex-limit"><div class="seg2" role="tablist" aria-label="Buy or sell">${[['buy', 'Buy ZP'], ['sell', 'Sell ZP']].map(([k, l]) => `<button type="button" class="chip ${k} ${side === k ? 'on' : ''}" role="tab" aria-selected="${side === k}" data-act="dex-side" data-v="${k}">${l}</button>`).join('')}</div>
    <label class="field">Price (zUSDC per ZP)<input name="price" inputmode="decimal" autocomplete="off" placeholder="${ref ? ref.price.toFixed(4) : '1.0000'}" value="${esc(S.draft.dprice || '')}"></label>
    <label class="field">Amount (ZP)<input name="amount" inputmode="decimal" autocomplete="off" placeholder="10" value="${esc(S.draft.damt || '')}"></label>
    <div class="small muted" id="dex-total" aria-live="polite"></div>
    <p class="muted small">A limit order: it waits in the Dex until someone takes it, and you can cancel it. To trade now, tap a price in the book. At least 1 ZP and 0.01 zUSDC.</p>
    ${S.modal ? '' : errBox()}<button class="btn primary big">Review ${side} order</button></form>`;
}
function syncLimit() {
  const f = $app.querySelector('form[data-form=dex-limit]'), out = $app.querySelector('#dex-total'); if (!f || !out) return;
  try { const o = limitOrder({ side: S.draft.dside === 'sell' ? 'sell' : 'buy', price8: parsePrice(f.price.value), amount: parseZP(f.amount.value.trim()), quote: S.bookView.q });
    out.textContent = (S.draft.dside === 'sell' ? 'You get ' : 'You pay ') + withUnit(S.bookView.q, S.draft.dside === 'sell' ? o.pairTotal : o.underAmount); } catch { out.textContent = ''; }
}
function tradesCard(m) {
  const ts = (Array.isArray(m.trades) ? m.trades : []).filter(t => Number(t.price) > 0).slice(0, 12); if (!ts.length) return '';
  const when = t => { const x = Number(t.time); return x ? new Date(x < 1e12 ? x * 1000 : x).toLocaleTimeString('en-GB') : t.pending ? 'pending' : ''; };
  return `<div class="card"><h2>Trades</h2><div class="tradehead"><span>Price (zUSDC)</span><span>Amount (ZP)</span><span>Time</span></div><div class="trades">${ts.map(t => `<div class="trade"><span class="${t.side === 'buy' ? 'bid' : 'ask'}">${Number(t.price).toFixed(4)}</span><span>${zpShort(t.size)}</span><span class="muted">${esc(when(t))}</span></div>`).join('')}</div>
    <p class="muted small booknote">Green: someone bought ZP. Red: someone sold.</p></div>`;
}
// ---------------------------------------------------------------- Up / Down bets (src/bets.js)
// A bet buys Up or Down tokens of one market on the Dex (a Take); each pays 1 zUSDC if right, nothing if not.
const closeText = ms => { const d = new Date(ms), today = new Date().toDateString() === d.toDateString(), t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const left = ms - Date.now(), h = Math.floor(left / 3600e3), mi = Math.round((left % 3600e3) / 60e3);
  return (today ? t + ' today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + t) + (left > 0 ? ` (in ${h ? h + ' h ' : ''}${mi} min)` : ''); };
const strikeText = b => b.strike.toLocaleString('en-US', { maximumFractionDigits: 3 });
const betOrders = () => (S.markets?.orders || []).map(r => { try { return { ...orderOf(r), pending: !!r.pending, busy: dexPending.has(r.tx) }; } catch { return null; } }).filter(Boolean);
const betHeld = b => { const as = S.data.get(active().id)?.state?.assets || []; const h = a => { const x = as.find(y => y.asset === a); return x ? x.spendable + x.maturing : 0n; }; return { up: h(b.bull), down: h(b.bear) }; };
const VOID_NOTE = 'If the oracle has no close price within 24 hours, every token pays 0.50.';
function betsCard(m, cat) {
  if (!m) return '';
  if (!m.bets) return `<div class="card"><h2>Up or down?</h2><p class="muted small">Bets on these prices open when the bet contract is active on this network. You will pick a market, say Up or Down, and get 1 zUSDC for each token if you are right.</p></div>`;
  const orders = betOrders(), spendable = canSpend(S.open.get(active().id));
  const open = m.bets.filter(b => tickerCat(b.ticker) === cat && b.status === 'open' && b.close > Date.now()).sort((x, y) => x.close - y.close || x.ticker.localeCompare(y.ticker) || x.strike - y.strike);
  const btn = (b, side) => { const o = bestOffer(orders, sideAsset(b, side), b.collateral), p = offerPrice(o);
    return o && spendable ? `<button type="button" class="chip ${side === 'up' ? 'buy' : 'sell'} betbtn" data-act="bet" data-id="${esc(b.bull)}" data-side="${side}">${side === 'up' ? '▲ Up' : '▼ Down'} <b>${p.toFixed(2)}</b></button>`
      : `<span class="chip ${side === 'up' ? 'buy' : 'sell'} betbtn off" aria-disabled="true">${side === 'up' ? '▲ Up' : '▼ Down'} <span class="muted">${o ? p.toFixed(2) : '–'}</span></span>`; };
  const rows = open.map(b => `<div class="bet"><div class="between"><div><b>${esc(b.ticker)}</b> at or above <b>${esc(strikeText(b))}</b></div><div class="muted small">closes ${esc(closeText(b.close))}</div></div><div class="betrow">${btn(b, 'up')}${btn(b, 'down')}</div></div>`).join('');
  return `<div class="card"><h2>Up or down?</h2><div class="list">${rows || '<p class="muted small">No open bets in this group now.</p>'}</div>
    <p class="muted small" data-s="mt10">The number is the price of one token in zUSDC. A token pays 1 zUSDC if you are right at the close, nothing if not. ${VOID_NOTE}</p></div>${yourBets(m)}`;
}
// how long an order sent from here has waited for its block (a block takes about 4 minutes; Cancel needs it in a block)
const waitText = at => { const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? 'sent just now: waiting for its block (about 4 min), then you can cancel it'
    : m < 10 ? `sent ${m} min ago: waiting for its block (about 4 min), then you can cancel it`
    : `sent ${m} min ago and not in a block yet: the network is slow now; Cancel shows once it is in a block`; };
// my own sell orders of a token: in the book, or sent from here and waiting for their block
function mySells(asset) {
  const me = myPub(), listed = betOrders().filter(o => o.underAsset === asset && myOrder(o, me)), seen = new Set(listed.map(o => o.tx));
  const waiting = dexMade().filter(x => x.under_asset === asset && !seen.has(x.tx)).map(x => { try { return { ...orderOf(x), waiting: true, at: x.at }; } catch { return null; } }).filter(Boolean);
  return [...listed, ...waiting];
}
function yourBets(m) {
  const spendable = canSpend(S.open.get(active().id));
  const rows = m.bets.map(b => {
    const h = betHeld(b), unit = b.collateral, line = side => {
      const n = h[side], sells = mySells(sideAsset(b, side)); if (!n && !sells.length) return '';
      const pay = n ? redeemValue(b, side, n) : null, key = b.bull + side, sent = S.redeemed?.[key] && Date.now() - S.redeemed[key] < 10 * 60e3, open = b.status === 'open' && b.close > Date.now();
      const right = !n ? '' : pay === null ? `<span class="muted small">${b.status === 'open' ? 'If right: ' : 'Waiting for the result · '}${esc(withUnit(unit, n))}</span>`
        : pay === 0n ? '<span class="muted small">Lost</span>'
        : sent ? '<span class="muted small"><span class="spin"></span> Collecting…</span>'
        : spendable && b.contract ? `<button class="btn primary mini" data-act="bet-redeem" data-id="${esc(b.bull)}" data-side="${side}">Collect ${esc(withUnit(unit, pay))}</button>` : `<span class="small">${esc(withUnit(unit, pay))} to collect</span>`;
      const state = b.status === 'void' ? 'void: no close price, every token pays 0.50' : b.status === 'voidable' ? 'no close price in 24 hours: being voided (0.50 per token)'
        : b.status === 'settled' ? 'closed at ' + esc(b.settlePrice == null ? '–' : b.settlePrice.toLocaleString('en-US', { maximumFractionDigits: 3 })) : b.status === 'closing' ? 'closed, waiting for the result' : 'closes ' + esc(closeText(b.close));
      const onSale = sells.map(o => { const p = dexPending.get(o.tx);
        return `<div class="muted small onsale">On sale: ${esc(tokenAmount(unit, o.underAmount))} at ${(Number(o.pairTotal) / Number(o.underAmount)).toFixed(4)} = ${esc(withUnit(unit, o.pairTotal))}${o.waiting ? `<br><span class="spin"></span> ${esc(waitText(o.at))}` : p ? ' · ' + (p === 'taking' ? 'being bought…' : 'being cancelled…') : spendable ? ` <button class="chip mini" data-act="dex-cancel" data-tx="${esc(o.tx)}">Cancel</button>` : ''}</div>`; }).join('');
      const sell = n && pay === null && open && spendable ? `<button class="btn sellbtn" data-act="bet-sell" data-id="${esc(b.bull)}" data-side="${side}">Sell ${side === 'up' ? '▲ Up' : '▼ Down'} tokens</button>` : '';
      return `<div class="betpos"><div class="item"><div><div>${side === 'up' ? '▲ Up' : '▼ Down'} · <b>${esc(b.ticker)}</b> ${esc(strikeText(b))}</div><div class="muted small">${n ? esc(tokenAmount(unit, n)) + ' tokens · ' : ''}${state}</div>${onSale}</div><div class="betright">${right}</div></div>${sell}</div>`;
    };
    return line('up') + line('down');
  }).join('');
  return rows ? `<div class="card"><h2>Your bets</h2><div class="list">${rows}</div>${S.modal ? '' : errBox()}</div>` : '';
}
function sellModal(md) {
  const b = (S.markets?.bets || []).find(x => x.bull === md.id), up = md.side === 'up';
  if (!b) return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Sell</h2><p class="muted">This market is gone.</p><button class="btn primary big" data-act="close">OK</button></div></div>`;
  const asset = sideAsset(b, md.side), n = betHeld(b)[md.side], orders = betOrders(), bid = bestBid(orders, asset, b.collateral), ask = bestOffer(orders, asset, b.collateral);
  const nowN = bid ? (n < bid.pairTotal ? n : bid.pairTotal) : 0n, nowGet = bid ? payoutFor(bid, nowN) : 0n;
  const amt = S.draft.sellAmt ?? tokenAmount(b.collateral, n).replace(/,/g, ''), price = S.draft.sellPrice ?? '';
  let get = ''; try { const o = sellOrder(price, parseUnits(amt, decimalsOf(asset))); get = o.tokens > n ? 'more than you hold' : withUnit(b.collateral, o.total); } catch { /* not yet */ }
  return `<div class="modal" role="dialog" aria-modal="true"><form class="sheet" data-form="bet-sell"><h2>Sell ${up ? '▲ Up' : '▼ Down'}: ${esc(b.ticker)} ${up ? '≥' : '<'} ${esc(strikeText(b))}</h2>
    <div class="card small">You hold <b>${esc(tokenAmount(b.collateral, n))}</b> tokens. Each pays 1 zUSDC if ${esc(b.ticker)} is ${up ? 'at or above' : 'below'} ${esc(strikeText(b))} at ${esc(closeText(b.close))}.</div>
    ${bid ? `<div class="card small"><div class="between"><span>Someone buys now at <b>${bidPrice(bid).toFixed(4)}</b></span><button type="button" class="btn primary mini" data-act="bet-sellnow" ${S.busy ? 'disabled' : ''}>Sell ${esc(tokenAmount(b.collateral, nowN))} for ${esc(withUnit(b.collateral, nowGet))}</button></div></div>` : '<p class="muted small">Nobody is buying these tokens right now: set your price, and your tokens wait in the Dex until someone buys them.</p>'}
    <label class="field">Your price per token (zUSDC)<input name="price" inputmode="decimal" autocomplete="off" placeholder="${ask ? offerPrice(ask).toFixed(2) : '0.60'}" value="${esc(price)}"></label>
    <label class="field"><span class="row" data-s="between"><span>Tokens to sell</span><span data-s="right">You hold ${esc(tokenAmount(b.collateral, n))}</span></span><span class="row"><input name="amount" inputmode="decimal" autocomplete="off" value="${esc(amt)}"><button type="button" class="btn" data-act="sell-all" data-s="fixed">All</button></span></label>
    <div class="kv"><span class="muted">You get when it sells</span><span class="amt ok" id="sell-get">${get ? esc(get) : '–'}</span></div>
    <p class="muted small">Your tokens wait in the Dex until someone buys them, and you can cancel any time under Your bets. Buyers take the cheapest offer first${ask ? `: now ${offerPrice(ask).toFixed(2)}` : ''}.</p>
    ${errBox()}<div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Review sell order'}</button></div></form></div>`;
}
function betModal(md) {
  const b = (S.markets?.bets || []).find(x => x.bull === md.id), o = b && bestOffer(betOrders(), sideAsset(b, md.side), b.collateral);
  if (!b || !o) return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Bet</h2><p class="muted">This offer is gone. Try again from the list.</p><button class="btn primary big" data-act="close">OK</button></div></div>`;
  const have = S.data.get(active().id)?.state?.assets.find(x => x.asset === b.collateral)?.spendable || 0n, v = S.draft.bstake ?? '';
  let q = null; try { q = betQuote(o, parseUnits(v, decimalsOf(b.collateral))); } catch { /* not yet */ }
  const up = md.side === 'up', cond = `${b.ticker} is ${up ? 'at or above' : 'below'} ${strikeText(b)} at ${closeText(b.close)}`;
  return `<div class="modal" role="dialog" aria-modal="true"><form class="sheet" data-form="bet"><h2>${up ? '▲ Up' : '▼ Down'}: ${esc(b.ticker)} ${up ? '≥' : '<'} ${esc(strikeText(b))}</h2>
    <div class="card small">You win if <b>${esc(cond)}</b>. Price ${offerPrice(o).toFixed(4)} zUSDC per token; each pays 1 zUSDC if you are right.</div>
    <label class="field"><span class="row" data-s="between"><span class="tname">${tokenIcon(b.collateral, 18)}Your stake (${esc(unitOf(b.collateral))})</span><span data-s="right">You have ${esc(tokenAmount(b.collateral, have))}</span></span>
      <input name="stake" inputmode="decimal" autocomplete="off" value="${esc(v)}" placeholder="up to ${esc(tokenAmount(b.collateral, o.pairTotal < have ? o.pairTotal : have))}"></label>
    <div class="kv"><span class="muted">If right you get</span><span class="amt ok" id="bet-win">${q ? esc(withUnit(b.collateral, q.payout)) + ' (+' + esc(tokenAmount(b.collateral, q.profit)) + ')' : '–'}</span></div>
    <div class="kv"><span class="muted">If not</span><span class="amt">0</span></div>
    <p class="muted small">At most ${esc(withUnit(b.collateral, o.pairTotal))} at this price. You can sell the tokens before the close on the Dex. ${VOID_NOTE}</p>
    ${errBox()}<div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Review'}</button></div></form></div>`;
}
async function betRedeem(b, side) {
  const a = active(), w = S.open.get(a.id); await refreshWallet(a.id);
  const d = S.data.get(a.id); if (!d?.state) throw new Error('Could not read the balance from the node');
  const asset = sideAsset(b, side), n = betHeld(b)[side]; if (!n) throw new Error('No tokens of this side in this wallet');
  const pay = redeemValue(b, side, n); if (!pay) throw new Error('Nothing to collect for this side');
  // signed: the contract pays the holder's key (docs/BETS.md); the payout is checked before signing
  const signer = signerOf(w), myHash = pkHashOf(hex(signer.publicKey));
  const prepared = await prepareContractCall({ w, state: d.state, node: node(), contractId: b.contract, command: 'Redeem', body: redeemBody(b.event, side), spends: [{ asset, amount: n }], signer, expect: expectRedeem(b.collateral, pay, myHash) });
  S.modal = { type: 'dex-confirm', kind: 'redeem', key: b.bull + side, prepared, lines: [[b.status === 'void' ? 'Tokens (void market)' : 'Winning tokens', tokenAmount(b.collateral, n)], ['You get', withUnit(b.collateral, pay)], b.status === 'void' ? ['Why', 'No close price within 24 hours: 0.50 per token'] : ['Close price', b.settlePrice == null ? '–' : b.settlePrice.toLocaleString('en-US', { maximumFractionDigits: 3 })]] }; S.error = ''; render();
}

function dexView(m, base, loading) {
  if (!m?.dex) return `<div class="card"><p class="muted small">${loading ? 'Loading…' : 'This site has no Dex.'}</p></div>`;
  const me = myPub(), spendable = canSpend(S.open.get(active().id));
  const list = (m.orders || []).map(r => { try { return orderOf(r); } catch { return null; } }).filter(Boolean);
  const rows = list.map(o => {
    const p = dexPending.get(o.tx), mineO = myOrder(o, me), who = mineO ? 'Your order' : (() => { const n = contractNames[encodeAddress(Uint8Array.from(pkHashOf(o.maker).match(/../g).map(h => parseInt(h, 16))), net())]; return n ? esc(n) : 'Another trader'; })();
    const btn = p ? `<span class="muted small">${p === 'taking' ? 'Being taken…' : 'Being cancelled…'}</span>` : !spendable ? '' : mineO
      ? `<button class="chip mini" data-act="dex-cancel" data-tx="${esc(o.tx)}">Cancel</button>` : `<button class="btn primary mini" data-act="dex-take" data-tx="${esc(o.tx)}">Take</button>`;
    return `<div class="item"><div class="tname">${tokenIcon(o.underAsset) || ''}<div><div>${orderLine(o)}</div><div class="muted small">${who}</div></div></div><div>${btn}</div></div>`;
  }).join('');
  const assets = (S.data.get(active().id)?.state?.assets || []).filter(x => x.asset === '00' || x.spendable > 0n);
  const known = [...new Set(['00', ...assets.map(x => x.asset), ...list.flatMap(o => [o.underAsset, o.pairAsset])])];
  const give = S.draft.dgive && known.includes(S.draft.dgive) ? S.draft.dgive : '00';
  const want = S.draft.dwant && known.includes(S.draft.dwant) && S.draft.dwant !== give ? S.draft.dwant : known.find(a => a !== give) || '';
  const pick = (name, sel) => `<div class="tokpick">${known.filter(a => name === 'dwant' ? a !== give : true).map(a => `<button type="button" class="chip tokchip ${a === sel ? 'on' : ''}" aria-checked="${a === sel}" role="radio" data-act="dex-pick" data-name="${name}" data-asset="${esc(a)}">${a === '00' && !ICONS.zp ? '<span class="zpdot">ZP</span>' : tokenIcon(a, 22)}<span><b>${esc(unitOf(a))}</b></span></button>`).join('')}</div>`;
  const has = assets.find(x => x.asset === give);
  const listed = new Set(list.map(o => o.tx)), waitingMine = dexMade().filter(x => !listed.has(x.tx)).map(x => { try { return orderOf(x); } catch { return null; } }).filter(Boolean)
    .map(o => `<div class="item"><div class="tname">${tokenIcon(o.underAsset) || ''}<div>${orderLine(o)}<div class="muted small"><span class="spin"></span> Waiting for its block (about 4 min)</div></div></div></div>`).join('');
  const mineRows = waitingMine + list.filter(o => myOrder(o, me)).map(o => { const p = dexPending.get(o.tx); return `<div class="item"><div class="tname">${tokenIcon(o.underAsset) || ''}<div>${orderLine(o)}</div></div><div>${p ? `<span class="muted small">${p === 'taking' ? 'Being taken…' : 'Being cancelled…'}</span>` : spendable ? `<button class="chip mini" data-act="dex-cancel" data-tx="${esc(o.tx)}">Cancel</button>` : ''}</div></div>`; }).join('');
  return `${loading ? '<div class="card"><p class="muted small">Loading…</p></div>' : bookView(m, me, spendable)}
    ${mineRows ? `<div class="card"><h2>Your orders</h2><div class="list">${mineRows}</div></div>` : ''}
    <details class="card how" data-keep="dexall" ${S.keep?.dexall ? 'open' : ''}><summary>All orders and other pairs</summary><div class="list" data-s="mt10">${rows || '<p class="muted small">No open orders.</p>'}</div>
      <p class="muted small" data-s="mt10">Taking needs no signature from the maker; you can take part of an order.</p>
    ${spendable && want ? `<form data-form="dex-make" data-s="mt10"><h2>Any pair</h2>
      <div class="field"><span>You give</span>${pick('dgive', give)}<input name="give" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(S.draft.dgamt || '')}"><span class="muted small">Available ${esc(tokenAmount(give, has?.spendable || 0n))} ${esc(unitOf(give))}</span></div>
      <div class="field"><span>You want</span>${pick('dwant', want)}<input name="want" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(S.draft.dwamt || '')}"></div>
      <p class="muted small">Your ${esc(unitOf(give))} waits in the Dex until someone takes the order or you cancel it. Signed with this wallet's key.</p>
      <button class="btn primary big">Review order</button></form>` : ''}</details>`;
}
async function dexPrepare(kind, o, extra = {}) {
  const a = active(), w = S.open.get(a.id); await refreshWallet(a.id);
  const d = S.data.get(a.id); if (!d?.state) throw new Error('Could not read the balance from the node');
  const signer = signerOf(w), me = hex(signer.publicKey), dex = S.markets.dex, myHash = hex(decodeAddress(receiveAddress(w)).hash);
  let prepared, lines;
  if (kind === 'take' || kind === 'bet') {
    // the book's newest rows are hints: the order must still be open on the chain before anything is signed
    const live = await fetch(siteBase() + '/explorer/api/dex/orders', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (live && Array.isArray(live.orders) && !live.orders.some(r => r.tx === o.tx && !r.pending)) { loadMarkets(); throw new Error('Someone took it first: this order is no longer open. The book is refreshed: tap the next price'); }
    const { body, payout } = takeBody(o, extra.provided, decodeAddress(receiveAddress(w)).hash);
    prepared = await prepareContractCall({ w, state: d.state, node: node(), contractId: dex, command: 'Take', body, spends: [{ asset: o.pairAsset, amount: extra.provided }], expect: expectTake(o, extra.provided, payout, myHash) });
    lines = extra.lines ? extra.lines(payout) : [['You give', withUnit(o.pairAsset, extra.provided)], ['You get', withUnit(o.underAsset, payout)], ...(extra.provided < o.pairTotal ? [['Left in the order', withUnit(o.underAsset, o.underAmount - payout) + ' for ' + withUnit(o.pairAsset, o.pairTotal - extra.provided)]] : [])];
  } else if (kind === 'make') {
    prepared = await prepareContractCall({ w, state: d.state, node: node(), contractId: dex, command: 'Make', body: makeBody({ ...o, maker: me }), spends: [{ asset: o.underAsset, amount: o.underAmount }], signer, expect: expectMake(o) });
    lines = extra.lines ? extra.lines() : [['You give', withUnit(o.underAsset, o.underAmount)], ['You want', withUnit(o.pairAsset, o.pairTotal)]];
  } else {
    prepared = await prepareContractCall({ w, state: d.state, node: node(), contractId: dex, command: 'Cancel', body: cancelBody(o), signer, expect: expectCancel(o, pkHashOf(o.maker)) });
    lines = [['Back to you', withUnit(o.underAsset, o.underAmount)]];
  }
  S.modal = { type: 'dex-confirm', kind, o, prepared, lines, warn: extra.warn || [] }; S.error = ''; render();
}

function bridgeNote(to, asset) {
  const named = contractNames[String(to || '').trim()];
  if (!toBridge(to) && typeof named === 'string') return `<div class="card small">This is the <b>${esc(named)}</b>, not the USDC bridge: nothing sent here is paid out as USDC.</div>`;
  if (!toBridge(to)) return '';
  return asset === S.bridge.asset
    ? `<div class="card small"><b>Withdrawal to USDC.</b> This is the USDC bridge: it destroys the zUSDC and pays the same amount of USDC to the EVM address linked to this wallet's address, by itself, ${bridgeWait()}. Follow it on <a href="/bridge.html" rel="noopener">the bridge page</a>.</div>`
    : `<div class="warn"><b>This is the USDC bridge.</b> It takes only zUSDC; ${esc(unitOf(asset))} sent here is not paid back.</div>`;
}
function parseUnits(text, dec) {   // "1,234.5" with thousands separators only; at most `dec` decimals
  const raw = String(text).trim(), t = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw;
  const m = t.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${dec}}))?$`)); if (!m) throw new Error(`Invalid amount (at most ${dec} decimals)`);
  return BigInt(m[1]) * 10n ** BigInt(dec) + BigInt((m[2] || '').padEnd(dec, '0'));
}
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
  screen: null, tab: 'new', assetNames: { ...BUILTIN_NAMES }, draft: {}, error: '', busy: false, modal: null, nodeOk: null, tip: null, cgp: null,
  settings: loadSettings(), lastActivity: Date.now(),
};
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* default */ }
  return { mtab: ['oracle', 'dex', 'swap'].includes(s.mtab) ? s.mtab : 'oracle', stab: s.stab === 'sell' ? 'sell' : 'buy', afilter: typeof s.afilter === 'string' ? s.afilter : 'all', ocat: typeof s.ocat === 'string' ? s.ocat : 'crypto', btcApi: typeof s.btcApi === 'string' && /^https?:\/\//.test(s.btcApi) ? s.btcApi : '', network: s.network === 'test' ? 'test' : 'main', nodes: { main: s.nodes?.main || DEFAULT_NODES.main[0], test: s.nodes?.test || '' }, active: s.active || null,
           voteWallets: { main: Array.isArray(s.voteWallets?.main) ? s.voteWallets.main : null, test: Array.isArray(s.voteWallets?.test) ? s.voteWallets.test : null } };
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch { /* private mode */ } }
const net = () => S.settings.network;
// a site that hosts this wallet next to its own node can name it in config.json ({ "testNode": "http://host/node" }), so its testnet works at once
const defaultNode = n => DEFAULT_NODES[n][0] || S.siteDefaults?.[n] || '';
// A busy node (one slow request holds all the others) gets a second chance; meanwhile the header says so.
const busyNow = () => S.nodeBusyAt && Date.now() - S.nodeBusyAt < 35000;
const nodeBusy = () => { S.nodeBusyAt = Date.now(); render(); };
const node = () => S.settings.nodes[net()] ? new NodeClient(S.settings.nodes[net()], { onRetry: nodeBusy, onRecover: () => { S.nodeBusyAt = 0; render(); } }) : null;
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
// oracle tickers by market, and their names (a ticker not listed goes under Other)
const ORACLE_CATS = [['crypto', 'Crypto'], ['forex', 'Forex'], ['stocks', 'Stocks'], ['commodities', 'Commodities'], ['other', 'Other']];
const TICKER_CAT = { BTC: 'crypto', ETH: 'crypto', SOL: 'crypto', EUR: 'forex', GBP: 'forex', JPY: 'forex', CHF: 'forex', AUD: 'forex', CAD: 'forex', CNY: 'forex', ILS: 'forex',
  SPY: 'stocks', QQQ: 'stocks', AAPL: 'stocks', MSFT: 'stocks', NVDA: 'stocks', GOOGL: 'stocks', AMZN: 'stocks', TSLA: 'stocks', XAU: 'commodities', GOLD: 'commodities', XAG: 'commodities', OIL: 'commodities', WTI: 'commodities' };
const TICKER_NAMES = { BTC: 'Bitcoin', ETH: 'Ether', EUR: 'Euro', GBP: 'British pound', JPY: 'Japanese yen', CHF: 'Swiss franc', AUD: 'Australian dollar', CAD: 'Canadian dollar', ILS: 'Israeli shekel',
  SPY: 'S&P 500 ETF', QQQ: 'Nasdaq-100 ETF', AAPL: 'Apple', MSFT: 'Microsoft', NVDA: 'Nvidia', XAU: 'Gold, troy ounce', GOLD: 'Gold', XAG: 'Silver, troy ounce' };
const tickerCat = t => TICKER_CAT[t] || 'other';
// the large balance: two decimals, cut (never rounded up past what is there); the exact amount on hover and in Send
const balShort = k => { const n = BigInt(k), c = n / 1000000n * 1000000n, f = formatZP(c); return (f.includes('.') ? f.replace(/(\.\d)$/, '$10') : f + '.00'); };
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
    const dj = await get('/explorer/api/dex/orders').catch(() => null), orders = Array.isArray(dj?.orders) ? dj.orders : [];
    const q = quoteId(), [book, tj] = q ? await Promise.all([get(`/explorer/api/dex/book?base=00&quote=${q}&qdec=6&pending=1`).catch(() => null), get(`/explorer/api/dex/trades?base=00&quote=${q}&limit=20`).catch(() => null)]) : [null, null];
    const bets = marketsOf(await get('/explorer/api/bets/markets').catch(() => null));
    nameBets(bets);
    S.markets = { bets, round, evidence, orders, dex: typeof dj?.dex === 'string' && /^[0-9a-f]{72}$/.test(dj.dex) ? dj.dex : null, day: new Date(round.timestamp).toISOString().slice(0, 10),
      book: book && Array.isArray(book.asks) ? book : null, trades: Array.isArray(tj?.trades) ? tj.trades : Array.isArray(tj) ? tj : [] };
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
    const b = myBuy(); if (b && !b.btcTx && !b.paid) S.feeRate = await fetchFeeRate(btcApi());   // a purchase to pay: the fee that confirms in time
    autoPay();
  } catch { S.swap = null; S.swapError = 'The ZP ⇄ BTC contract is not running on this network yet.'; }
  render();
}
// public keys of this device's wallets that can sign (an offer's seller is one of them)
const mySellers = () => new Map(walletsHere().map(w => [w, S.open.get(w.id)]).filter(([, o]) => o && canSpend(o)).map(([w, o]) => [hex(signerOf(o).publicKey), w]));
// an offer whose take-back was sent from here, or whose cancel the prover sees in the mempool, waits for its block
const takingBack = o => o.state === 'closing' || (S.takingBack?.[o.id] && Date.now() - S.takingBack[o.id] < 30 * 60e3);
const PENDING_OFFERS_KEY = 'zp-wallet.pending-offers.v1';
const pendingOffers = () => { try { const v = JSON.parse(localStorage.getItem(PENDING_OFFERS_KEY)); return Array.isArray(v) ? v.filter(p => p && typeof p.id === 'string' && Date.now() - p.at < 30 * 60e3 && p.net === net() && p.swapId === S.swap?.swapId && !S.swap?.offers.some(o => o.id === p.id)) : []; } catch { return []; } };
const addPendingOffer = p => { try { localStorage.setItem(PENDING_OFFERS_KEY, JSON.stringify([...pendingOffers(), p].slice(-20))); } catch { /* private mode */ } };
const BTC_USED_KEY = 'zp-wallet.btc-scripts.v1';
const usedScripts = () => { try { const v = JSON.parse(localStorage.getItem(BTC_USED_KEY)); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
const rememberScripts = xs => { try { localStorage.setItem(BTC_USED_KEY, JSON.stringify([...new Set([...usedScripts(), ...xs])].slice(-500))); } catch { /* private mode */ } };
const swapState = o => takingBack(o) ? 'Taking back: waits for its block (about 4 minutes)' : o.payment?.proof ? 'Paid: the ZP went to the buyer' : o.payment ? `Buyer paid, ${o.payment.confs ?? 0} of ${o.payment.need} confirmations` : o.state === 'reserved' ? `Reserved until block ${Number(o.until).toLocaleString('en-US')}` : o.state === 'expired' ? ((S.swap?.zpTip ?? 0) + 1 < backFrom(o) ? `A reservation expired: open again; you can take it back from block ${backFrom(o).toLocaleString('en-US')}` : 'A reservation expired: open again') : 'Open';
// ---------------------------------------------------------------- ZP <-> BTC, as easy as the bridge
// Two tabs (Buy ZP, Sell ZP), one action each, live steps with honest waiting times. The ZP Wallet holds no Bitcoin
// keys: a Bitcoin wallet in the browser only tells an address or sends "X sats to Y" after its own confirm screen
// (src/btc.js). Paying from a connected Bitcoin wallet is switched on at build time (BTC_WALLET_PAY=1), after Alon's
// go-ahead, and is capped per purchase; the QR code and the bitcoin: link always work.
const WALLET_PAY = typeof __BTC_WALLET_PAY__ === 'boolean' ? __BTC_WALLET_PAY__ : false;
const WALLET_PAY_CAP = 1000000;   // 0.01 BTC per purchase from a connected wallet, at first
const btcNet = () => S.swap?.btcNet === 'test' ? 'test' : 'main';
const btcApi = () => S.settings.btcApi || BTC_API[btcNet()];
const realBtc = () => btcNet() === 'main' && net() === 'test';
const hm = blocks => { const m = Math.max(0, blocks) * BLOCK_MIN; return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
const realBanner = side => realBtc() ? `<div class="warn small"><b>Real bitcoin, test ZP.</b> ${side === 'sell' ? 'Buyers pay you real bitcoin for testnet ZP, which has no value.' : 'You pay real bitcoin and receive testnet ZP, which has no value.'} Trade small amounts only.</div>` : '';
// a new offer's Bitcoin addresses: made from the account key (default), one from a connected Bitcoin wallet, or typed
const keepOffer = () => { const f = $app.querySelector('form[data-form=offer]'), m = S.modal; if (f && m) for (const k of ['zp', 'btc', 'per', 'addrs', 'xpub']) if (f[k]) m[k] = f[k].value; };
function offerAddrs(m) {
  const src = m.src || 'key', acc = btcAccount(), n = m.count || 2;
  const chips = `<div class="small tname">${btcLogo(16)}Where the bitcoin goes</div><div class="tabs3" role="group" aria-label="Bitcoin addresses">${[['key', 'Account key'], ['wallet', 'Bitcoin wallet'], ['type', 'Type addresses']].map(([k, l]) =>
    `<button type="button" class="chip ${src === k ? 'on' : ''}" data-act="addr-src" data-v="${k}">${l}</button>`).join('')}</div>`;
  if (src === 'key') return `${chips}
    ${acc && !m.newKey ? `<div class="card small"><div class="kv"><span class="muted">Account key</span><span class="mono">${esc(acc.key.slice(0, 4))}…${esc(acc.key.slice(-6))} <button type="button" class="chip mini" data-act="btc-acc-change">Change</button></span></div></div>
      <p class="muted small">Each reservation gets a new receive address from it, never one used before.</p>`
    : `<label class="field">Your Bitcoin account key (zpub, xpub or ypub)<input name="xpub" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="zpub6r…" value="${esc(m.xpub || '')}"></label>
      <p class="muted small">Your Bitcoin wallet shows it as the account public key, xpub or zpub (Sparrow, Electrum, BlueWallet, Nunchuk…). From it this device makes a new receive address for each reservation. It cannot spend your bitcoin, but it shows your Bitcoin balance and history: it stays on this device only.</p>`}
    <div class="small">Reservations</div><div class="tabs" role="group" aria-label="Reservations">${[1, 2, 3, 4].map(k => `<button type="button" class="chip ${n === k ? 'on' : ''}" data-act="addr-count" data-v="${k}">${k}</button>`).join('')}</div>
    <p class="muted small">How many buyers can reserve this offer one after another (one address each). 1 or 2 is usually enough: your Bitcoin wallet looks only 20 unused addresses ahead. Take back an offer nobody reserved and its addresses come back.</p>`;
  if (src === 'wallet') return `${chips}
    ${m.walletAddr ? `<div class="card small"><div class="kv"><span class="muted">${esc(m.walletName)}</span><span class="mono small" data-s="wrap">${esc(m.walletAddr)}</span></div></div>
      <div class="warn small">${esc(m.walletName)} gives one fixed address, so this offer can be reserved once. For more reservations, use your account key.</div>`
    : btcWallets().length ? `${btcTiles('btcw-sell')}<p class="muted small">The wallet only tells its address; it signs nothing here.</p>` : '<p class="muted small">No Bitcoin wallet found in this browser. Use your account key, or type addresses.</p>'}`;
  return `${chips}<label class="field">Your Bitcoin addresses, one per line (1 to ${MAX_SCRIPTS})<textarea name="addrs" rows="4" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${btcNet() === 'test' ? 'tb1q…' : 'bc1q…'}" required>${esc(m.addrs || '')}</textarea></label>
    <p class="muted small">Each reservation uses the next one, so a late payment can never be taken by the next buyer. <b>Each line must be a new address that never received bitcoin</b>: most wallets show the same one until it is paid. An exchange deposit address is not suitable.</p>`;
}
// one click: once the reservation is in a block, the pay screen of the chosen Bitcoin wallet opens by itself (once)
function autoPay() {
  const b = myBuy(); if (!WALLET_PAY || !b || b.prompted || b.btcTx || b.paid || S.modal || !chosenBtc()) return;
  const o = S.swap?.offers.find(x => x.id === b.id);
  if (payCheck({ offer: o, buy: b, zpTip: S.swap?.zpTip ?? 0, cap: WALLET_PAY_CAP })) return;
  setBuy({ ...b, prompted: true }); try { btcPayOpen(); } catch { /* the pay step shows why */ }
}
// pays the reservation from the chosen Bitcoin wallet, after a screen that shows it matches the reservation
function btcPayOpen() {
  const b = myBuy(), o = S.swap?.offers.find(x => x.id === b?.id);
  const why = payCheck({ offer: o, buy: b, zpTip: S.swap?.zpTip ?? 0, cap: WALLET_PAY_CAP }); if (why) throw new Error(why);
  const w = chosenBtc(); if (!w) { S.modal = { type: 'btcw' }; S.error = ''; return render(); }
  S.modal = { type: 'btc-pay', walletId: w.id, id: o.id, address: o.address, sats: o.sats }; S.error = ''; render();
}
// one list of steps for buyers and sellers: done, now (with its detail) and next, each with its expected time
const stepper = steps => `<ol class="stepper">${steps.map(s => `<li class="${s.state}"><span class="sdot" aria-hidden="true">${s.state === 'done' ? '✓' : ''}</span><div class="sbody"><div class="sl">${esc(s.label)}${s.eta ? ` <span class="badge">${esc(s.eta)}</span>` : ''}</div>${s.state === 'now' && s.detail ? `<div class="sd">${s.detail}</div>` : ''}</div></li>`).join('')}</ol>`;
const stepsAt = (labels, now) => labels.map((l, i) => ({ ...l, state: i < now ? 'done' : i === now ? 'now' : 'next' }));
const confBar = (c, need) => `<div class="bar" data-cols="${need}" aria-hidden="true">${Array.from({ length: need }, (_, i) => `<span class="${i < c ? 'on' : ''}"></span>`).join('')}</div>`;
// Bitcoin wallets in this browser, each with the icon it gives (none bundled here)
const BTC_WALLET_KEY = 'zp-wallet.btc-wallet.v1';
const btcWallets = () => findBtcWallets(window, ICONS);
const chosenBtc = () => { const ws = btcWallets(); let id = null; try { id = localStorage.getItem(BTC_WALLET_KEY); } catch { /* private mode */ } return ws.find(w => w.id === id) || (ws.length === 1 ? ws[0] : null); };
const btcIcon = (w, n = 24) => w.icon ? `<img class="wicon${w.bundled ? ' brand' : ''}" src="${esc(w.icon)}" alt="" width="${n}" height="${n}">` : `<span class="wicon blank" data-px="${n}" aria-hidden="true">${esc(w.name.charAt(0))}</span>`;
const btcTiles = act => `<div class="wtiles">${btcWallets().map(w => `<button type="button" class="chip wtile" data-act="${act}" data-id="${esc(w.id)}">${btcIcon(w, 28)}<b>${esc(w.name)}</b></button>`).join('')}</div>`;
// the Bitcoin account key (xpub/zpub) a seller shared once: new receive addresses come from it; kept on this device only
const BTC_ACCOUNT_KEY = 'zp-wallet.btc-account.v1';
const btcAccount = () => { try { const v = JSON.parse(localStorage.getItem(BTC_ACCOUNT_KEY))?.[btcNet()]; return v && typeof v.key === 'string' ? { key: v.key, lastUsed: Number.isSafeInteger(v.lastUsed) && v.lastUsed >= -1 ? v.lastUsed : -1 } : null; } catch { return null; } };
// which receive address of the account each offer address is (shown when a payment arrives), and giving back the
// addresses of an offer taken back before anyone reserved them (they never received anything)
const BTC_INDEX_KEY = 'zp-wallet.btc-index.v1';
const addrIndex = () => { try { const v = JSON.parse(localStorage.getItem(BTC_INDEX_KEY)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const rememberIndex = xs => { try { localStorage.setItem(BTC_INDEX_KEY, JSON.stringify(Object.fromEntries([...Object.entries(addrIndex()), ...xs].slice(-500)))); } catch { /* private mode */ } };
const forgetScripts = xs => { try { localStorage.setItem(BTC_USED_KEY, JSON.stringify(usedScripts().filter(x => !xs.includes(x)))); } catch { /* private mode */ } };
const setBtcAccount = v => { try { const all = JSON.parse(localStorage.getItem(BTC_ACCOUNT_KEY) || '{}') || {}; if (v) all[btcNet()] = v; else delete all[btcNet()]; localStorage.setItem(BTC_ACCOUNT_KEY, JSON.stringify(all)); } catch { /* private mode */ } };

// ---- buying: the prover reserves the offer for this wallet's address (POST /swap/reserve, it pays the fee), the buyer
// pays the offer's Bitcoin address, and the contract releases the ZP when the proof of the payment is in a block.
// Nothing to sign on ZP. One purchase at a time, kept across reloads.
const BUY_KEY = 'zp-wallet.btc-buy.v1';
const myBuy = () => { try { const b = JSON.parse(localStorage.getItem(BUY_KEY)); return b && b.net === net() && b.swapId === S.swap?.swapId && typeof b.id === 'string' ? b : null; } catch { return null; } };
const setBuy = b => { try { if (b) localStorage.setItem(BUY_KEY, JSON.stringify({ ...b, net: net(), swapId: S.swap?.swapId })); else localStorage.removeItem(BUY_KEY); } catch { /* private mode */ } };
// the payment must confirm while the reservation holds: Bitcoin's next-block fee rate, or the wallet's fastest
const feeNote = () => `<div class="fee small">${S.feeRate ? `Network fee: <b>at least ${S.feeRate} sat/vB</b>, Bitcoin's next-block rate now.` : 'Network fee: choose your wallet\'s fastest (high priority) fee.'} A slower payment can confirm after your reservation ends, and then the ZP may not be released to you.</div>`;
function payBox(o, b, left, rest) {
  const amt = formatBTC(o.sats), uri = bip21(o.address, o.sats), q = qrcode(0, 'M'); q.addData(uri); q.make();
  const qr = `<div class="qr">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: false })}</div><a class="btn ${WALLET_PAY && btcWallets().length ? '' : 'primary'} big" href="${esc(uri)}">Open in my Bitcoin wallet</a>`;
  const ws = WALLET_PAY ? btcWallets() : [], w = chosenBtc();
  let pay = '';
  if (b.btcTx) pay = `<div class="card small"><span class="spin"></span> Sent from ${esc(b.btcWallet || 'your Bitcoin wallet')}. Waiting for Bitcoin to show the payment (usually under a minute).</div>`;
  else if (ws.length && o.sats > WALLET_PAY_CAP) pay = `<p class="muted small">Paying from a connected wallet is limited to ${formatBTC(WALLET_PAY_CAP)} BTC for now: use the QR code.</p>`;
  else if (ws.length) pay = w ? `<button class="btn primary big" data-act="btc-pay">${btcIcon(w)} Pay with ${esc(w.name)}</button>${ws.length > 1 ? '<button type="button" class="linkbtn" data-act="btcw-choose">Use another Bitcoin wallet</button>' : ''}`
    : '<button class="btn primary big" data-act="btcw-choose">Pay with a Bitcoin wallet</button>';
  return `<div class="kv"><span class="muted">Exact amount</span><span class="amt">${btcAmt(o.sats)} <button type="button" class="chip mini" data-act="copy" data-text="${esc(amt)}">Copy</button></span></div>
    <div class="kv"><span class="muted">To</span><span class="mono small" data-s="wrap">${esc(o.address || '–')} <button type="button" class="chip mini" data-act="copy" data-text="${esc(o.address || '')}">Copy</button></span></div>
    <div class="countdown">⏱ Pay within <b>${hm(left - rest)}</b> <span class="muted">(held for you ${hm(left)} in all)</span></div>
    ${b.btcTx ? '' : feeNote()}
    ${pay}${pay && !b.btcTx && ws.length && o.sats <= WALLET_PAY_CAP ? `<details class="how"><summary>Pay from another wallet (QR code)</summary>${qr}</details>` : b.btcTx ? '' : qr}
    <p class="muted small">The bitcoin goes straight to the seller; this address is for your reservation only.</p>`;
}
function buyCard() {
  const b = myBuy(); if (!b) return '';
  const o = S.swap.offers.find(x => x.id === b.id), close = '<button class="btn" data-act="buy-done">Close</button>';
  const head = t => `<div class="card buy"><h2>${t}</h2>`;
  if (!o && !b.paid) return `${head('The offer is closed')}<p class="muted small">It is no longer in the market.</p>${close}</div>`;
  const ours = !!(o?.buyer && b.pk && String(o.buyer).toLowerCase() === String(b.pk).toLowerCase());
  if (o?.state === 'reserved' && ours && !b.held) { b.held = true; setBuy(b); }
  if (o && b.held && (!ours || (o.state !== 'reserved' && !o.payment))) return `${head('Your reservation expired')}<div class="warn">Do not pay now. Reserve again if the offer is still open.</div>${close}</div>`;
  const sats = o?.sats ?? b.sats, need = o?.payment?.need || o?.confs || confsFor(sats), p = o?.payment, c = Math.max(0, p?.confs ?? 0);
  if (p?.proof && !b.paid) { b.paid = true; setBuy(b); }
  const stage = !o ? 4 : !b.held ? 0 : !p ? 1 : !p.proof ? 2 : 3;
  const left = o ? Number(o.until) - (S.swap.zpTip ?? 0) : 0, rest = holdOf(sats) - payOf(sats), late = stage === 1 && left <= rest;
  const steps = stepsAt([
    { label: 'Reserved for you', eta: 'a few min', detail: '<span class="spin"></span> Waiting for the reservation to be in a ZP block. <b>Do not pay yet</b>: the payment details appear here.' },
    { label: 'Pay', eta: stage === 1 ? `within ${hm(left - rest)}` : `within ${hm(payOf(sats))}`, detail: late ? `<div class="warn"><b>Do not pay now.</b> Less than ${hm(rest)} is left on your reservation: too little for the Bitcoin confirmations. Wait until it expires and reserve again.</div>` : stage === 1 ? payBox(o, b, left, rest) : '' },
    { label: `Bitcoin confirmations ${Math.min(c, need)} of ${need}`, eta: `about ${need * 10} min`, detail: `${confBar(c, need)}<p class="muted small">${p?.block == null ? 'Waiting for the first Bitcoin block (about 10 minutes).' : `About ${(need - c) * 10} more minutes: one Bitcoin block every 10 minutes on average.`} You can close the wallet.</p>${p ? `<p class="muted small mono">Bitcoin ${esc(String(p.txid || '').slice(0, 16))}…</p>` : ''}` },
    { label: 'Proof sent to the contract', eta: 'about 4 min', detail: 'The proof was sent. The ZP arrives with the next ZP block.' },
    { label: 'ZP received', eta: '', detail: '' },
  ], stage);
  const title = ['Reserving…', `<span class="tname">Pay ${btcLogo(22)}${esc(formatBTC(sats))} BTC</span>`, 'Payment received', 'Releasing your ZP', 'You received the ZP'][stage];
  return `${head(title)}${stage === 4 ? '<p class="ok small">The contract checked your Bitcoin payment and released the ZP to this wallet.</p>' : ''}${stepper(steps)}
    ${stage === 4 ? '<button class="btn primary" data-act="buy-done">Done</button>' : stage === 0 ? '' : '<p class="muted small">This screen updates by itself.</p>'}</div>`;
}
// an offer from the side of the one looking at it: a buyer gets ZP and pays BTC, a seller sells ZP and receives BTC
const offerHead = (o, side = 'buy') => `<div class="row" data-s="between"><div><div class="olbl">${side === 'buy' ? 'You get' : 'You sell'}</div><div class="offzp tname">${zpLogo(24)}<span>${esc(formatZP(BigInt(o.amount)))} <span class="muted">ZP</span></span></div></div>
  <div data-s="fixed right"><div class="olbl">${side === 'buy' ? 'You pay' : 'You receive'}</div><div class="amt">${btcAmt(o.sats)}</div></div></div><div class="small muted" data-s="mt4">${esc(rateText(o.sats, BigInt(o.amount)))}</div>`;
function buyView() {
  const me = mySellers(), b = myBuy();
  const list = S.swap.offers.filter(o => !me.has(o.seller) && o.state !== 'closed');
  const cards = list.map(o => {
    const status = o.state === 'reserved' ? `Reserved, free again in about ${hm(Number(o.until) - (S.swap.zpTip ?? 0))}` : o.state === 'closing' ? 'Being taken back by the seller' : '';
    return `<div class="offer buy">${offerHead(o, 'buy')}
      <div class="row" data-s="between mt6"><span class="badge" data-s="fixed">⏱ about ${buyMin(o.sats)} min in all</span>
      ${b?.id === o.id ? '<span class="muted small" data-s="fixed">Yours</span>' : `<button class="btn primary mini" data-s="fixed" data-act="buy" data-id="${esc(o.id)}" ${o.canReserve && !b ? '' : 'disabled'}>Buy</button>`}</div>
      ${status ? `<div class="muted small" data-s="mt4">${esc(status)}</div>` : ''}</div>`;
  }).join('');
  return `${buyCard()}<div class="card"><h2>Buy from others</h2>${cards ? `<div class="offers">${cards}</div>` : '<p class="muted small">No offers from others right now.</p>'}
    ${b ? '<p class="muted small" data-s="mt10">Finish or close your purchase above to buy another.</p>' : '<p class="muted small" data-s="mt10">The offer is held for you while you pay: nobody else can take it and the seller cannot take it back. The ZP comes to the wallet you have open.</p>'}</div>`;
}

// ---- selling
// the contract refuses a take-back while the offer is held and in the 10 blocks after (BitZenSwap cancel)
const backFrom = o => o.until != null ? Number(o.until) + 11 : 0;
const takeBackWhy = o => {
  const tip = S.swap?.zpTip ?? 0;
  if (o.payment) return 'A buyer paid: the ZP goes to them.';
  if (o.state === 'reserved') return `Reserved: if the buyer does not pay, you can take it back from block ${backFrom(o).toLocaleString('en-US')} (about ${hm(backFrom(o) - tip - 1)}).`;
  if (tip + 1 < backFrom(o)) return `From block ${backFrom(o).toLocaleString('en-US')} (about ${hm(backFrom(o) - tip - 1)}): a late payment can still arrive until then.`;
  return null;
};
const canTakeBack = o => !takingBack(o) && !takeBackWhy(o);
function sellerSteps(o) {
  const p = o.payment, need = p?.need || o.confs || confsFor(o.sats), c = Math.max(0, p?.confs ?? 0);
  const stage = !p ? 1 : !p.proof ? 2 : 4;
  return stepper(stepsAt([
    { label: 'Reserved by a buyer', eta: '' },
    { label: 'The buyer pays you', eta: `within ${hm(Math.max(0, payOf(o.sats) - (holdOf(o.sats) - (Number(o.until) - (S.swap.zpTip ?? 0)))))}`, detail: `<span class="muted small">Held until block ${Number(o.until).toLocaleString('en-US')}.${o.address ? ` The bitcoin goes to your address ${esc(String(o.address).slice(0, 12))}…` : ''}</span>` },
    { label: `Bitcoin confirmations ${Math.min(c, need)} of ${need}`, eta: `about ${need * 10} min`, detail: confBar(c, need) },
    { label: 'The ZP goes to the buyer', eta: 'about 4 min' },
  ], stage)) + (p && o.address && addrIndex()[o.address] != null ? `<p class="muted small">If your Bitcoin wallet does not show this payment, raise its gap limit (Sparrow, Electrum: Wallet → Settings): it went to receive address #${Number(addrIndex()[o.address])} of your account (…/0/${Number(addrIndex()[o.address])}).</p>` : '');
}
function sellView() {
  const sw = S.swap, me = mySellers(), mine = sw.offers.filter(o => me.has(o.seller)), a = active(), can = !!(a && S.open.get(a.id) && canSpend(S.open.get(a.id)));
  const waiting = pendingOffers().map(p => `<div class="offer sell">${offerHead(p, 'sell')}
        <div class="muted small" data-s="mt6"><span class="spin"></span> Sent: waiting for the next block (about 4 minutes), then it is in the market</div></div>`).join('');
  const rows = mine.map(o => {
    const why = takeBackWhy(o), live = o.state === 'reserved' || o.payment;
    return `<div class="offer sell">${offerHead(o, 'sell')}
      <div class="muted small" data-s="mt6">${esc(me.get(o.seller).name)} · ${o.scripts - o.used} of ${o.scripts} reservations left</div>
      ${live && !takingBack(o) ? sellerSteps(o) : `<div class="small" data-s="mt6">${esc(o.state === 'expired' ? 'Open again: a reservation expired' : swapState(o))}</div>`}
      ${takingBack(o) ? '' : `<div class="row" data-s="mt6 between"><span class="muted small">${why ? esc(why) : ''}</span><button class="btn small" data-s="fixed" data-act="swap-cancel" data-id="${esc(o.id)}" ${why ? 'disabled' : ''}>Take back</button></div>`}</div>`;
  }).join('');
  return `<div class="card"><div class="row" data-s="between"><h2>Your sell offers</h2><button class="btn primary small" data-s="fixed" data-act="swap-new" ${can ? '' : 'disabled'}>New offer</button></div>
    ${waiting || rows ? `<div class="offers">${waiting}${rows}</div>` : '<p class="muted small">You have no offers. Sell ZP for bitcoin: the buyer pays straight to your Bitcoin address.</p>'}
    ${S.modal ? '' : errBox()}</div>
    <div class="card"><div class="kv"><span>Offers in the market</span><span class="amt">${sw.offers.length}</span></div>
      <details class="how"><summary>How a sale works</summary><p class="muted small">Your ZP waits in a contract. A buyer reserves the offer (about 80 minutes up to 0.01 BTC, 2 hours up to 0.1 BTC, 4 hours above) and pays bitcoin to a new address of yours; the contract checks the payment on Bitcoin and releases the ZP to the buyer. Each reservation needs its own new Bitcoin address: the wallet makes them from your account key. You can take an offer back while it is not reserved, and from 10 blocks after a reservation ends (a payment slow to confirm can still arrive).</p></details></div>`;
}
function swapCard() {
  if (!siteBase()) return '<div class="card"><p class="muted small">ZP ⇄ BTC needs the community node, which serves the swap next to it.</p></div>';
  if (!S.swap) return `<div class="card"><p class="muted small">${esc(S.swapError || 'Loading…')}</p></div>`;
  const tab = S.settings.stab === 'sell' ? 'sell' : 'buy';
  return `<div class="seg2" role="tablist" aria-label="Buy or sell">${[['buy', 'Buy ZP'], ['sell', 'Sell ZP']].map(([k, l]) => `<button class="chip ${k} ${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}" data-act="stab" data-v="${k}">${l}</button>`).join('')}</div>
    ${realBanner(tab)}${tab === 'buy' ? buyView() : sellView()}`;
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
    return { v, label: S.assetNames[x.asset] || 'Token ' + x.asset.slice(8, 16) + '…', bal: decimalsOf(x.asset) === 6 ? withUnit(x.asset, x.spendable + x.maturing) : (x.spendable + x.maturing).toLocaleString('en-US') };
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
  return `<div class="card" data-s="mt10"><p class="bad"><b>A node would refuse it: ${esc(r.title || r.rule || '')}</b>${r.line ? ` · ${r.lineApprox ? 'near line' : 'line'} ${esc(r.line)}` : ''}</p>
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
  const out = !L ? '' : L.check ? `<div class="card">${refusalHtml(L.check)}</div>` : `<div class="card"><div class="between"><h2>What happens</h2><span class="pill ${L.ok ? 'ok' : 'bad'}">${L.ok ? 'OK' : L.unbalanced?.length ? 'Not valid' : 'Refused'}</span></div>
      ${L.ok ? (L.moves.length ? `<div class="list">${L.moves.map(m => { const n = BigInt(String(m.change)); return `<div class="item"><div>${esc(whoLabel(m.who))} ${n < 0n ? 'pays' : 'gets'} <b>${esc(formatAmount(n < 0n ? -n : n, m.asset))}</b></div></div>`; }).join('')}</div>` : '<p class="muted small">Nothing moves.</p>')
        : L.unbalanced?.length ? `<div class="err" role="alert"><span class="err-ic" aria-hidden="true">!</span><div><b>A node would reject this transaction</b><div class="err-more">It pays out ${L.unbalanced.map(u => esc(formatAmount(u.missing, u.asset))).join(' and ')} more than goes in. The contract allows it, but the network does not: nothing would move, and this call cannot be sent as it is. The contract should refuse it.</div></div></div>`
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
    // unbalanced: the contract pays out more than goes in; a node rejects such a transaction, so it is not a success and the session does not move on
    const unbalanced = Array.isArray(r.unbalanced) ? r.unbalanced.filter(u => u && u.asset != null && /^\d+$/.test(String(u.missing)) && BigInt(String(u.missing)) > 0n) : [];
    T.last = { ok: !!r.ok && !unbalanced.length, unbalanced, error: r.error, declared: r.declaredCost, used: r.gasUsed, block: T.block, moves: Array.isArray(t.moves) ? t.moves : [], inputs: Array.isArray(r.inputs) ? r.inputs : [], outputs: Array.isArray(r.outputs) ? r.outputs : [] };
    if (!unbalanced.length && t.next && typeof t.next === 'object') T.session = { wallet: Array.isArray(t.next.wallet) ? t.next.wallet : [], state: t.next.state ?? null };
    T.runs++;
  } finally { T.running = false; render(); }
}

function fail(e) {
  S.error = e?.message || String(e); S.errField = e?.field || null; S.errCombine = !!e?.combine; S.busy = false; render();
  const box = $app.querySelector('.modal .err, .err'); box?.scrollIntoView?.({ block: 'center' }); box?.focus?.({ preventScroll: true });
}   // the message may sit below the button that was pressed

// ---------------------------------------------------------------- views
const top = () => `<div class="top"><span class="brand">ZP Wallet</span>
  <span class="row" data-s="fixed gap6">${net() === 'test' ? '<span class="pill test">TESTNET</span>' : ''}
  <span class="pill" title="${esc(S.settings.nodes[net()])}"><span class="dot ${S.nodeOk === false ? 'bad' : busyNow() ? '' : S.nodeOk === true ? 'ok' : ''}"></span>${S.nodeOk === false ? 'Node offline' : busyNow() ? 'Node busy, retrying…' : S.tip ? 'Block ' + esc(S.tip.toLocaleString('en-US')) : 'Connecting…'}</span></span></div>`;
const backBar = (title, to = 'home') => `<div class="back"><button class="iconbtn" data-go="${to}" aria-label="Back">${I.back}</button><h1>${esc(title)}</h1></div>`;
// an error is a box that cannot be missed: an icon, its first part in bold ("Use a new Bitcoin address for each line"),
// the details under it; the field it is about is marked too (S.errField, from an Error's .field)
const errBox = () => {
  if (!S.error) return '';
  const i = S.error.indexOf(': '), head = i > 0 && i < 80 ? S.error.slice(0, i) : S.error, rest = i > 0 && i < 80 ? S.error.slice(i + 2) : '';
  return `<div class="err" role="alert" tabindex="-1"><span class="err-ic" aria-hidden="true">!</span><div><b>${esc(head)}</b>${rest ? `<div class="err-more">${esc(rest)}</div>` : ''}${S.errCombine ? '<button type="button" class="btn small" data-s="mt10" data-act="combine">Combine my ZP now</button>' : ''}</div></div>`;
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
        <div class="balance" title="${d.state ? esc(formatZP(zp?.spendable || 0n)) + ' ZP exactly' : ''}">${d.state ? balShort(zp?.spendable || 0n) : '…'} <small class="tname">${zpLogo(22)}ZP</small></div>
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
      ${others.length ? `<div class="card"><h2>Tokens</h2><div class="list">${others.map(x => `<button type="button" class="item tokrow" data-act="token" data-asset="${esc(x.asset)}"><span class="tname" title="${esc(x.asset)}">${tokenIcon(x.asset)}${S.assetNames[x.asset] ? esc(S.assetNames[x.asset]) : `<span class="mono small">${esc(x.asset.slice(0, 18))}…</span>`}</span><span class="amt">${tokenAmount(x.asset, x.spendable + x.maturing)} <span class="muted">›</span></span></button>`).join('')}</div></div>` : ''}
      <div class="row"><h2>Activity</h2><button class="iconbtn" data-act="refresh" aria-label="Refresh" data-s="fixed">${S.busy ? '<span class="spin"></span>' : I.refresh}</button></div>
      ${actFilter(d)}</div>${nav('home')}`;
  },

  send: () => {
    const a = active(), assets = (S.data.get(a.id)?.state?.assets || []).filter(x => x.asset === '00' || x.spendable > 0n);
    const asset = assets.some(x => x.asset === S.draft.asset) ? S.draft.asset : '00', held = assets.find(x => x.asset === asset), u = unitOf(asset);
    return `${backBar(asset === '00' ? 'Send ZP' : 'Send ' + esc(u))}<form data-form="send" class="screen">
      ${assets.length > 1 ? `<div class="field"><span>What</span><div class="tokpick" role="radiogroup" aria-label="What to send">${assets.map(x => `<button type="button" role="radio" aria-checked="${x.asset === asset}" class="chip tokchip ${x.asset === asset ? 'on' : ''}" data-act="send-asset" data-asset="${esc(x.asset)}">${x.asset === '00' && !ICONS.zp ? '<span class="zpdot">ZP</span>' : tokenIcon(x.asset, 22)}<span><b>${esc(unitOf(x.asset))}</b><small>${esc(tokenAmount(x.asset, x.spendable))}</small></span></button>`).join('')}</div><input type="hidden" name="asset" value="${esc(asset)}"></div>` : ''}
      <label class="field">To address<input name="to" class="mono" autocomplete="off" spellcheck="false" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" value="${esc(S.draft.to || '')}" required></label>
      <label class="field"><span class="row" data-s="between"><span class="tname">${tokenIcon(asset, 18)}Amount (${esc(u)})</span><span data-s="right">Available ${esc(tokenAmount(asset, held?.spendable || 0n))}</span></span>
        <span class="row"><input name="amount" inputmode="decimal" autocomplete="off" value="${esc(S.draft.amount || '')}" required><button type="button" class="btn" data-act="max" data-s="fixed">Max</button></span></label>
      ${bridgeNote(S.draft.to, asset)}
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
    const unit = (asset, v) => withUnit(asset, BigInt(v));
    const tabs = [['oracle', 'Oracle'], ['dex', 'Dex'], ['swap', 'ZP ⇄ BTC']];
    const head = `<div class="tabs3 sticky" role="tablist" aria-label="Markets">${tabs.map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}" data-mtab="${k}">${k === 'swap' ? `<span class="tname tight">${zpLogo(15)}ZP⇄${btcLogo(15)}BTC</span>` : l}</button>`).join('')}</div>`;
    const errCard = S.marketsError ? `<div class="card"><p class="muted small">${esc(S.marketsError)}</p></div>` : '';
    let body = '';
    if (tab === 'oracle') {
      const cat = ORACLE_CATS.some(([k]) => k === S.settings.ocat) ? S.settings.ocat : 'crypto';
      const all = (m?.round?.tickers || []).map((t, i) => [t, i]), present = new Set(all.map(([t]) => tickerCat(t)));
      const chips = `<div class="afilter" role="tablist" aria-label="Markets">${ORACLE_CATS.filter(([k]) => present.has(k) || k === cat).map(([k, l]) => `<button type="button" class="chip mini ${cat === k ? 'on' : ''}" role="tab" aria-selected="${cat === k}" data-act="ocat" data-v="${k}">${l}</button>`).join('')}</div>`;
      const rows = all.filter(([t]) => tickerCat(t) === cat).map(([t, i]) => {
        const e = m.evidence[t] || {}, names = Object.keys(e.sources || {}), dropped = e.dropped || [];
        const src = !names.length ? '1 source' : `${names.length - dropped.length} of ${names.length} sources agree`;
        const day = e.asOf && m.day && e.asOf !== m.day ? 'close ' + e.asOf : '';
        const tip = names.map(n => n + ' = ' + e.sources[n]).join('\n') + (dropped.length ? '\ndropped: ' + dropped.join(', ') : '');
        return `<div class="item" title="${esc(tip)}"><div><div><b>${esc(t)}</b>${TICKER_NAMES[t] ? ` <span class="muted small">${esc(TICKER_NAMES[t])}</span>` : ''}</div><div class="muted small">${esc(src)}${day ? ' · ' + esc(day) : ''}</div></div><div class="amt">${esc(Number(m.round.values[i]).toLocaleString('en-US', { maximumFractionDigits: 6 }))}</div></div>`;
      }).join('');
      body = `${errCard}${loading ? '' : betsCard(m, cat)}<div class="card"><h2>Prices in USD${m?.round ? ' <span class="muted small">· ' + esc(ago(m.round.timestamp)) + '</span>' : ''}</h2>${chips}<div class="list">${loading ? '<p class="muted small">Loading…</p>' : rows || '<p class="muted small">No prices in this group yet.</p>'}</div>
        <p class="muted small" data-s="mt10">${cat === 'forex' ? 'US dollars for one unit of each currency.' : cat === 'stocks' || cat === 'commodities' ? 'End-of-day closes.' : 'Live prices.'} Several sources must agree.</p></div>`;
    } else if (tab === 'dex') {
      body = errCard + dexView(m, base, loading);
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
    <form class="card" data-form="btcapi"><h2>Bitcoin data</h2>
      <p class="muted small">For ZP ⇄ BTC the wallet asks a Bitcoin service whether an address received bitcoin before. That service sees those addresses and your IP address. The default is mempool.space; you can use your own (an Esplora API).</p>
      <label class="field" data-s="mt10">Esplora API address<input name="url" class="mono" value="${esc(S.settings.btcApi)}" placeholder="${esc(BTC_API.main)}"></label>
      <div class="row" data-s="mt10"><button class="btn primary">Save and test</button><button type="button" class="btn" data-act="btcapi-default">Default</button></div>
      ${S.btcApiOk ? `<p class="ok small">Saved: it answers with Bitcoin block ${S.btcApiOk.toLocaleString('en-US')}.</p>` : ''}${S.error && S.errField === 'url' && S.screen === 'settings' ? errBox() : ''}
      ${btcAccount() ? `<div class="kv" data-s="mt10"><span>Bitcoin account key on this device</span><span class="mono small">${esc(btcAccount().key.slice(0, 4))}…${esc(btcAccount().key.slice(-6))} <button type="button" class="chip mini" data-act="btc-acc-forget">Forget</button></span></div>` : ''}</form>
    <div class="card"><h2>Wallets on ${net() === 'main' ? 'mainnet' : 'testnet'}</h2><div class="list">${walletsHere().map(w => `<div class="item"><div><div>${esc(w.name)}</div><div class="muted small">${{ mnemonic: '24 words', key: 'Private key', watch: 'Watch only' }[w.kind]}</div></div>
      <span class="row" data-s="fixed">${w.kind !== 'watch' ? `<button class="btn" data-act="reveal" data-id="${esc(w.id)}">Backup</button>` : ''}<button class="btn danger" data-act="remove" data-id="${esc(w.id)}">Remove</button></span></div>`).join('') || '<p class="muted small">None.</p>'}</div></div>
    <button class="btn big" data-act="lock">Lock now</button>
    <p class="muted small">ZP Wallet ${esc(WALLET_VERSION)} · open source and community-run. Not affiliated with Zen Protocol Ltd. Wallet names and logos are trademarks of their owners; the Bitcoin logo is public domain; the ZP logo is Zen Protocol's original.</p></div>${nav('settings')}`,
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
    const mint = (tx.inputs || []).map(i => i && i.mint).find(Boolean);   // tokens issued by a contract in this transaction
    const info = { vote: !!vote, to: to || null, from, mintAsset: mint && typeof mint.asset === 'string' ? mint.asset : null };
    S.txInfo.set(hash, info);
    return info;
  } catch { return null; }
}
// the filter chips and the rows they keep; moves within the wallet show under All only
function actFilter(d) {
  if (!d.history) return '<div class="list"><p class="muted small">Loading…</p></div>';
  if (!d.history.length) return '<div class="list"><p class="muted small">No transactions yet.</p></div>';
  const f = ACT_KINDS.some(([k]) => k === S.settings.afilter) ? S.settings.afilter : 'all', a = active();
  const rows = f === 'all' ? d.history : d.history.filter(h => actKind(h) === f), unknown = f !== 'all' && d.history.some(h => h.txHash && !S.txInfo.get(h.txHash) && BigInt(h.amount) !== 0n);
  return `<div class="afilter" role="tablist" aria-label="Show">${ACT_KINDS.map(([k, l]) => `<button type="button" class="chip mini ${f === k ? 'on' : ''}" role="tab" aria-selected="${f === k}" data-act="afilter" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="list">${rows.length ? rows.map(h => activityRow(h, a)).join('') : `<p class="muted small">None in the last ${d.history.length} transactions.</p>`}</div>
    ${unknown ? '<p class="muted small"><span class="spin"></span> Looking up the transactions…</p>' : ''}
    ${d.more !== false ? `<button type="button" class="btn small" data-s="mt10" data-act="hist-more" ${S.busy ? 'disabled' : ''}>Show older</button>` : ''}`;
}
let txInfoBusy = false;
async function loadTxInfo(w, rows) {
  if (txInfoBusy) return; txInfoBusy = true;
  try { let any = false; for (const h of rows.filter(h => h.txHash && !S.txInfo.has(h.txHash) && BigInt(h.amount) !== 0n && !h.lock?.Coinbase).slice(0, 60)) { await txInfo(h.txHash, w); any = true; } if (any && !S.modal && S.screen === 'home') render(); }
  finally { txInfoBusy = false; }
}
// Activity filters: what a row is, from the amount and the transaction (txInfo, looked up in the background)
const ACT_KINDS = [['all', 'All'], ['received', 'Received'], ['sent', 'Sent'], ['mining', 'Mining'], ['trading', 'Trading'], ['votes', 'Votes']];
function actKind(h) {
  const amt = BigInt(h.amount), inn = amt > 0n, info = h.txHash ? S.txInfo.get(h.txHash) : null;
  if (amt === 0n) return 'internal';
  if (h.lock?.Coinbase) return 'mining';
  if ((S.myVotes ||= loadVotes()).some(v => v.hash === h.txHash)) return 'votes';
  if (info) {
    if (!inn && (info.vote || (amt === -1n && !info.to))) return 'votes';
    const o = inn ? info.from : info.to;
    if (o?.kind === 'Contract' && o.id && knownContract(o.id)) return 'votes';
    if (o?.kind === 'Contract' || (S.bridge && (o?.address === S.bridge.zp || info.mintAsset === S.bridge.asset))) return 'trading';
  }
  return inn ? 'received' : 'sent';
}
function activityRow(h, w) {
  const amt = BigInt(h.amount), inn = amt > 0n, info = h.txHash ? S.txInfo.get(h.txHash) : null;
  const mineVote = (S.myVotes ||= loadVotes()).find(v => v.hash === h.txHash);
  let what = h.lock?.Coinbase ? 'Mining reward' : inn ? 'Received' : 'Sent', who = '', back = '';
  if (amt === 0n && !h.lock?.Coinbase) {   // nothing in or out: the coins moved between this wallet's own addresses
    return `<div class="item act"><div class="act-main"><div>Moved within this wallet</div>
      <div class="muted small">${h.timestamp ? ago(h.timestamp) : 'pending'} · ${h.confirmations ? esc(h.confirmations.toLocaleString('en-US')) + ' conf.' : 'unconfirmed'} · to your own address, no fee</div></div>
    <div class="amt muted">${tokenIcon(h.asset, 16)}0 ${esc(unitOf(h.asset))}</div></div>`;
  }
  if (!h.lock?.Coinbase && info) {
    // a ballot costs 1 kalapa and pays nobody: votes from another device are recognised by that too
    if (!inn && (info.vote || mineVote || (amt === -1n && !info.to))) { what = 'CGP ballot'; who = mineVote ? esc(mineVote.kind + ': ' + mineVote.label) : 'vote fee (1 kalapa)'; }
    else {
      const o = inn ? info.from : info.to, name = o && o.kind === 'Contract' && o.id ? knownContract(o.id) : null;
      if (inn && S.bridge && info.mintAsset === S.bridge.asset && h.asset === S.bridge.asset) {   // zUSDC issued for a USDC deposit
        what = 'Received from'; who = 'the USDC bridge (deposit)';
        back = `<button type="button" class="chip mini" data-act="send-back" data-to="${esc(S.bridge.zp)}" data-asset="${esc(h.asset)}">Withdraw</button><button type="button" class="chip mini" data-act="copy" data-text="${esc(h.txHash)}" title="${esc(h.txHash)}">Copy id</button>`;
      } else if (o && o.address) {
        what = inn ? 'Received from' : 'Sent to';
        who = name ? esc(name.replace(/^the /, 'The ')) : S.bridge && o.address === S.bridge.zp ? `<span title="${esc(o.address)}">the USDC bridge</span>` : typeof contractNames[o.address] === 'string' ? `<span title="${esc(o.address)}">the ${esc(contractNames[o.address].toLowerCase())}</span>` : `<span class="mono" title="${esc(o.address)}">${esc(shortAddr(o.address))}</span>`;
        const copy = `<button type="button" class="chip mini" data-act="copy" data-text="${esc(o.address)}">Copy</button>`;
        back = (inn && o.kind !== 'Contract' ? `<button type="button" class="chip mini" data-act="send-back" data-to="${esc(o.address)}" data-asset="${esc(h.asset)}">Send back</button>` : !inn && o.kind !== 'Contract' ? `<button type="button" class="chip mini" data-act="send-back" data-to="${esc(o.address)}" data-asset="${esc(h.asset)}">Send again</button>` : '') + (o.kind !== 'Contract' ? copy : '')
          + `<button type="button" class="chip mini" data-act="copy" data-text="${esc(h.txHash)}" title="${esc(h.txHash)}">Copy id</button>`;
      }
    }
  } else if (mineVote && !inn) { what = 'CGP ballot'; who = esc(mineVote.kind + ': ' + mineVote.label); }
  else if (!info && h.txHash && !h.lock?.Coinbase) who = '<span class="muted">…</span>';
  return `<div class="item act"><div class="act-main"><div>${what}${who ? ` <span class="act-who">${who}</span>` : ''}</div>
      <div class="muted small">${h.timestamp ? ago(h.timestamp) : 'pending'} · ${h.confirmations ? esc(h.confirmations.toLocaleString('en-US')) + ' conf.' : 'unconfirmed'}</div>
      ${back ? `<div class="row" data-s="mt4">${back}</div>` : ''}</div>
    <div class="amt ${inn ? 'in' : ''}">${tokenIcon(h.asset, 16)}${inn ? '+' : '−'}${esc(withUnit(h.asset, inn ? amt : -amt))}</div></div>`;
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
    <div class="card"><div class="kv"><span class="muted">Send</span><span class="amt tname">${tokenIcon(m.asset || '00')}${esc(withUnit(m.asset || '00', m.amount))}</span></div>
    <div class="kv"><span class="muted">To</span><span class="mono small">${toBridge(m.to) ? '<b>USDC bridge</b> ' : typeof contractNames[m.to] === 'string' ? `<b>${esc(contractNames[m.to])}</b> ` : ''}${esc(m.to)}</span></div>
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
    <label class="field"><span class="tname">${zpLogo(16)}ZP to sell</span><input name="zp" inputmode="decimal" autocomplete="off" value="${esc(m.zp || '')}" required></label>
    <p class="muted small row" data-s="between"><span>From ${esc(active().name)}: ${m.balance === null ? '–' : formatZP(m.balance) + ' ZP'} spendable.</span>${m.balance ? '<button type="button" class="chip mini" data-s="fixed" data-act="offer-max">Max</button>' : ''}</p>
    <div class="small">Price</div>
    <div class="tabs3" role="group" aria-label="How to give the price">${[['usd', '$ per ZP'], ['total', 'Total in BTC'], ['sat', 'sat per ZP']].map(([k, l]) =>
      `<button type="button" class="chip ${(m.mode || 'total') === k ? 'on' : ''}" data-act="price-mode" data-v="${k}" ${k === 'usd' && !btcUsd() ? 'disabled title="No Bitcoin price from the oracle right now"' : ''}>${l}</button>`).join('')}</div>
    ${(m.mode || 'total') === 'total'
      ? `<label class="field"><span class="tname">${btcLogo(16)}Total price (BTC, for all of it)</span><input name="btc" inputmode="decimal" autocomplete="off" placeholder="0.0005" value="${esc(m.btc || '')}" required></label>`
      : `<label class="field">${m.mode === 'usd' ? 'Price per ZP ($)' : 'Price per ZP (satoshis)'}<input name="per" inputmode="decimal" autocomplete="off" placeholder="${m.mode === 'usd' ? '1.25' : '1250'}" value="${esc(m.per || '')}" required></label>`}
    <div class="small muted" id="offer-rate" aria-live="polite"></div>
    ${m.mode === 'usd' ? `<p class="muted small">At the oracle's Bitcoin price, $${esc(btcUsd()?.toLocaleString('en-US'))}. The offer keeps the total in BTC: if Bitcoin moves, the dollar price per ZP moves with it.</p>` : ''}
    ${offerAddrs(m)}
    ${errBox()}<div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Review</button></div></form></div></div>`;
  if (m.type === 'confirm-offer') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm offer</h2>
    <div class="card"><div class="kv"><span class="muted">Sell</span><span class="amt">${formatZP(m.amount)} ZP</span></div>
    <div class="kv"><span class="muted">For (total)</span><span class="amt">${btcAmt(m.sats)}${btcUsd() ? ` <span class="muted small">≈ $${(Number(m.sats) / 1e8 * btcUsd()).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : ''}</span></div>
    <div class="kv"><span class="muted">Price per ZP</span><span>${esc(rateText(m.sats, m.amount))}</span></div>
    ${m.src === 'key' ? '<div class="kv"><span class="muted">Bitcoin addresses</span><span class="small">New, from your account key</span></div>' : ''}
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
  if (m.type === 'combine') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Combine your ZP</h2>
    <div class="card"><div class="kv"><span class="muted">Small pieces</span><span class="amt">${m.pieces.toLocaleString('en-US')}</span></div>
      <div class="kv"><span class="muted">Amount</span><span class="amt">${esc(formatZP(m.amount))} ZP</span></div>
      <div class="kv"><span class="muted">Transfers</span><span>${m.batches.length} to your own address</span></div>
      <div class="kv"><span class="muted">Fee</span><span>None</span></div></div>
    <p class="muted small">Nothing leaves this wallet: the pieces are sent to its own address and come back as ${m.batches.length === 1 ? 'one piece' : m.batches.length + ' pieces'}. After the next block (about 4 minutes), contract calls (offers, Dex orders) work again.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="combine-send" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'combined') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Sent</h2>
    <p>${m.sent} transfer${m.sent === 1 ? '' : 's'} to your own address gather ${m.pieces.toLocaleString('en-US')} pieces (${esc(formatZP(m.amount))} ZP). They take effect in the next block, about 4 minutes; then try again.</p>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'btcw') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Choose your Bitcoin wallet</h2>
    ${btcWallets().length ? btcTiles('btcw-pick') : '<p class="muted small">No Bitcoin wallet found in this browser. Use the QR code.</p>'}
    <p class="muted small">Your Bitcoin wallet shows the payment and asks you to confirm it. The ZP Wallet never sees your Bitcoin keys.</p>
    <p class="muted small">Wallet names and logos are trademarks of their owners.</p>
    <button class="btn" data-act="close">Cancel</button></div></div>`;
  if (m.type === 'btc-pay') {
    const o = S.swap?.offers.find(x => x.id === m.id), w = btcWallets().find(x => x.id === m.walletId); if (!o || !w) return '';
    const why = payCheck({ offer: o, buy: myBuy(), zpTip: S.swap?.zpTip ?? 0, cap: WALLET_PAY_CAP }), same = o.address === m.address && o.sats === m.sats, amt = formatBTC(m.sats);
    return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="tname">${btcIcon(w, 28)}Pay with ${esc(w.name)}</h2>
    <div class="card"><div class="kv"><span class="muted">Amount</span><span class="amt">${btcAmt(m.sats)}${btcUsd() ? ` <span class="muted small">≈ $${(m.sats / 1e8 * btcUsd()).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : ''}</span></div>
      <div class="kv"><span class="muted">To</span><span class="mono small" data-s="wrap">${esc(m.address)}</span></div>
      <div class="kv"><span class="muted">For</span><span>${esc(formatZP(BigInt(o.amount)))} ZP to ${esc(active().name)}</span></div>
      <div class="kv"><span class="muted">Network fee</span><span>${S.feeRate ? `at least ${S.feeRate} sat/vB` : 'the fastest'}</span></div></div>
    ${why ? `<div class="warn">${esc(why)}</div>` : same ? '<p class="ok small">✓ Same address and amount as your reservation.</p>' : '<div class="warn">The reservation changed: close and check again.</div>'}
    <p class="muted small">${esc(w.name)} opens with this payment. Check there that it goes to the address ending <b class="mono">${esc(m.address.slice(-8))}</b> for exactly ${esc(amt)} BTC${S.feeRate ? `, with a fee of at least ${S.feeRate} sat/vB (choose "fast" or "high priority" if it asks)` : ', with its fastest fee'}, then confirm. Only your Bitcoin wallet signs.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="btc-pay-go" ${S.busy || why || !same ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Open ' + esc(w.name)}</button></div></div></div>`;
  }
  if (m.type === 'buy') {
    const o = S.swap?.offers.find(x => x.id === m.id); if (!o) return '';
    const to = receiveAddress(S.open.get(active().id));
    const usd = btcUsd() ? o.sats / 1e8 * btcUsd() : null, oneClick = WALLET_PAY && !!chosenBtc() && o.sats <= WALLET_PAY_CAP;
    return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Buy ${esc(formatZP(BigInt(o.amount)))} ZP</h2>
    <div class="lead">⏱ About <b>${buyMin(o.sats)} min</b> in all, if you pay as soon as it is reserved.</div>
    <div class="card"><div class="kv"><span class="muted">You pay</span><span class="amt">${btcAmt(o.sats)}${usd ? ` <span class="muted small">≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : ''}</span></div><div class="kv"><span class="muted">Price</span><span class="small">${esc(rateText(o.sats, BigInt(o.amount)))}</span></div>
      <div class="kv"><span class="muted">ZP to</span><span class="mono small">${esc(active().name)} · ${esc(shortAddr(to))}</span></div></div>
    <ol class="small steps-list"><li>Reserved for you: about ${BLOCK_MIN} min (no fee for you).</li><li>You pay from ${oneClick ? esc(chosenBtc().name) + ', which opens by itself' : 'your Bitcoin wallet'}.</li><li>${o.confs} Bitcoin confirmations: about ${o.confs * 10} min.</li><li>The ZP arrives here by itself: about ${PROOF_MIN} min later.</li></ol>
    <p class="muted small">You have up to ${hm(payOf(o.sats))} to pay; the offer stays held for you ${hm(holdOf(o.sats))} in all.</p>
    ${realBanner('buy')}
    ${errBox()}<div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="buy-reserve" data-id="${esc(o.id)}" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : oneClick ? 'Reserve and pay' : 'Reserve'}</button></div></div></div>`;
  }
  if (m.type === 'bet') return betModal(m);
  if (m.type === 'bet-sell') return sellModal(m);
  if (m.type === 'dex-take') {
    const o = m.o, have = S.data.get(active().id)?.state?.assets.find(x => x.asset === o.pairAsset)?.spendable || 0n, v = S.draft.dtake ?? '';
    let get = ''; try { const p = o.pairAsset === '00' ? parseZP(v) : parseUnits(v, decimalsOf(o.pairAsset)); if (p > 0n && p <= o.pairTotal) get = withUnit(o.underAsset, payoutFor(o, p)); } catch { /* not yet */ }
    return `<div class="modal" role="dialog" aria-modal="true"><form class="sheet" data-form="dex-take"><h2>Take order</h2>
    <div class="card small">${orderLine(o)}</div>
    <label class="field"><span class="row" data-s="between"><span class="tname">${o.pairAsset === '00' ? '' : tokenIcon(o.pairAsset, 18)}You give (${esc(unitOf(o.pairAsset))})</span><span data-s="right">You have ${esc(tokenAmount(o.pairAsset, have))}</span></span>
      <span class="row"><input name="give" inputmode="decimal" autocomplete="off" value="${esc(v)}" placeholder="up to ${esc(tokenAmount(o.pairAsset, o.pairTotal))}"><button type="button" class="btn" data-act="dex-all" data-s="fixed">Whole order</button></span></label>
    <div class="kv"><span class="muted">You get</span><span class="amt" id="dex-get">${get ? esc(get) : '–'}</span></div>
    ${errBox()}<div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Review'}</button></div></form></div>`;
  }
  if (m.type === 'dex-confirm') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>${m.kind === 'bet' ? 'Confirm bet' : m.kind === 'redeem' ? 'Collect winnings' : m.kind === 'take' ? 'Confirm take' : m.kind === 'make' ? 'Confirm order' : 'Cancel order'}</h2>
    <div class="card">${m.lines.map(([k, v]) => `<div class="kv"><span class="muted">${esc(k)}</span><span class="amt">${esc(v)}</span></div>`).join('')}<div class="kv"><span class="muted">Fee</span><span>1 kalapa</span></div></div>
    ${(m.warn || []).map(x => `<div class="warn small">${esc(x)}</div>`).join('')}
    <p class="muted small">Checked before signing: ${m.kind === 'redeem' ? 'the bet contract' : 'the Dex'} pays exactly this, and nothing goes to anyone else.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Back</button><button class="btn primary" data-act="dex-send" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'dex-sent') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">${m.kind === 'cancel' ? 'Cancelled' : 'Sent'}</h2>
    <p>${m.kind === 'bet' ? 'Your bet is on its way. The tokens arrive in the next block, about 4 minutes; they show under Your bets.' : m.kind === 'redeem' ? 'Your winnings are on their way: the zUSDC arrives in the next block, about 4 minutes.' : m.kind === 'take' ? 'Your take is on its way. The coins arrive in the next block, about 4 minutes.' : m.kind === 'make' ? 'Your order is on its way. It shows in the book now, marked as waiting for its block (about 4 minutes); then anyone can take it.' : `Order cancelled: it is off the book now. ${esc(m.back || 'Your coins')} come${m.back ? 's' : ''} back to your balance with the next block, about 4 minutes.`}</p>
    <div class="card small"><div class="between"><span class="muted">Transaction</span><button type="button" class="chip mini" data-act="copy" data-text="${esc(m.hash)}">Copy</button></div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'token') {
    const a = active(), st = S.data.get(a.id)?.state, x = st?.assets.find(y => y.asset === m.asset) || { spendable: 0n, maturing: 0n }, bridge = S.bridge && m.asset === S.bridge.asset;
    const rows = (S.data.get(a.id)?.history || []).filter(h => h.asset === m.asset).slice(0, 8);
    return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet">
    <div class="tokhead">${tokenIcon(m.asset, 44) || '<span class="zpdot big">T</span>'}<div><h2>${esc(unitOf(m.asset))}</h2><div class="muted small mono" title="${esc(m.asset)}">${esc(m.asset.slice(0, 14))}…</div></div></div>
    <div class="tokbal">${esc(tokenAmount(m.asset, x.spendable + x.maturing))} <span class="muted">${esc(unitOf(m.asset))}</span></div>
    <div class="actions" data-s="mb12"><button class="btn primary" data-act="token-send" data-asset="${esc(m.asset)}" ${x.spendable > 0n && canSpend(S.open.get(a.id)) ? '' : 'disabled'}>${I.send}Send</button><button class="btn" data-go="receive">${I.recv}Receive</button>
      ${bridge ? `<button class="btn" data-act="send-back" data-to="${esc(S.bridge.zp)}" data-asset="${esc(m.asset)}">${I.send}Withdraw</button>` : ''}</div>
    ${bridge ? `<div class="card small">zUSDC is test USDC brought over the bridge, one for one. <a href="${esc(siteBase())}/bridge.html" rel="noopener">Deposit USDC</a> to get more; Withdraw sends it back as USDC to your linked EVM wallet (about 8 to 10 minutes).</div>` : ''}
    <h3 class="small muted" data-s="mt10">Activity</h3>
    <div class="list">${rows.length ? rows.map(h => activityRow(h, a)).join('') : '<p class="muted small">No transfers of this token yet.</p>'}</div>
    <button class="btn" data-act="close">Close</button></div></div>`;
  }
  if (m.type === 'sent') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">Sent</h2>
    <p>${esc(withUnit(m.asset || '00', m.amount))} is on its way. It appears in the next block, about 4 minutes.</p>
    ${m.bridge ? `<p class="small"><b>Withdrawal:</b> the bridge pays the USDC to your linked EVM address by itself, ${bridgeWait()}. Nothing else to do.</p>` : ''}
    <div class="card small"><div class="between"><span class="muted">Transaction</span><button type="button" class="chip mini" data-act="copy" data-text="${esc(m.hash)}">Copy</button></div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
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
  // sizes set through the DOM: the page's CSP refuses style attributes in markup
  for (const e of $app.querySelectorAll('[data-cols]')) e.style.gridTemplateColumns = `repeat(${Number(e.dataset.cols) || 1}, 1fr)`;
  for (const e of $app.querySelectorAll('[data-px]')) e.style.width = e.style.height = (Number(e.dataset.px) || 24) + 'px';
  for (const e of $app.querySelectorAll('[data-w]')) e.style.width = Math.max(0, Math.min(100, Number(e.dataset.w) || 0)) + '%';
  syncLimit();
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
// Up and Down tokens are named after their market ("BTC 105,000 Up") and counted in the collateral's decimals
// (kept in S.betNames too: the site's assets.json replaces the name list when it arrives, and must not drop these)
function nameBets(bets) { for (const b of bets || []) { const n = `${b.ticker} ${b.strike.toLocaleString('en-US')}`; S.betNames = { ...(S.betNames || {}), [b.bull]: n + ' Up', [b.bear]: n + ' Down' }; S.assetNames[b.bull] = n + ' Up'; S.assetNames[b.bear] = n + ' Down'; S.betDec = { ...(S.betDec || {}), [b.bull]: decimalsOf(b.collateral), [b.bear]: decimalsOf(b.collateral) }; } }
async function refreshExtras() {
  const n = node(); if (!n) return;
  // the community site publishes stats.json next to /node/ (CGP fund balance, named contracts)
  S.stats = null;
  try {
    const u = new URL(S.settings.nodes[net()]);
    if (/\/node$/.test(u.pathname)) {
      const r = await fetch(u.origin + '/stats.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); if (j && typeof j === 'object') S.stats = j; }
      // the site's USDC bridge (testnet): its ZP address is named, and zUSDC sent there is a withdrawal
      try { const rb = await fetch(u.origin + '/bridge/status', { cache: 'no-cache' }); const j = rb.ok ? await rb.json() : null;
        S.bridge = j && typeof j.bridgeZp === 'string' && /^[0-9a-f]{72}$/.test(j.asset || '') ? { zp: j.bridgeZp, asset: j.asset, conf: Number(j.zpConfirmations) || 2, auto: j.autoWithdraw !== false } : null; } catch { S.bridge = null; }
      try { const rm = await fetch(u.origin + '/explorer/api/bets/markets', { cache: 'no-cache' }); nameBets(marketsOf(rm.ok ? await rm.json() : null)); } catch { /* no bets on this site */ }
      const ra = await fetch(u.origin + '/assets.json', { cache: 'no-cache' });
      if (ra.ok) {
        const j = await ra.json(), names = {};
        for (const x of Array.isArray(j?.assets) ? j.assets : []) if (typeof x?.asset === 'string' && typeof x?.name === 'string') names[x.asset] = x.name.slice(0, 40);
        S.assetNames = { ...BUILTIN_NAMES, ...names, ...(S.betNames || {}) };
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
    d.history = await readHistory(w, n); d.more = d.history.length >= 30;
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
  const bal = S.modal?.balance; if (z && bal != null && z > bal) err = `More than you have: ${formatZP(bal)} ZP spendable`;
  const typed = (f.btc || f.per)?.value.trim();
  if (!err && z && z > 0n && typed) { try { b = offerTotal(f, z); } catch (e) { err = e.message; } }
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
    if (act === 'ocat') { S.settings.ocat = t.dataset.v; saveSettings(); return render(); }
    if (act === 'afilter') { S.settings.afilter = t.dataset.v; saveSettings(); render(); const a = active(); return loadTxInfo(a, S.data.get(a.id)?.history || []); }
    if (act === 'hist-more') {
      const a = active(), d = S.data.get(a.id), w = S.open.get(a.id); if (!d?.history || !w) return;
      S.busy = true; render();
      try { const more = await readHistory(w, node(), d.history.length, 50); d.history = [...d.history, ...more]; d.more = more.length === 50; } finally { S.busy = false; }
      render(); return loadTxInfo(a, d.history);
    }
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
      if (act === 'confirm-offer' && m.indexes) rememberIndex(m.indexes);
      if (act === 'confirm-cancel' && m.release?.length) forgetScripts(m.release);
      if (act === 'confirm-offer' && m.id) addPendingOffer({ id: m.id, amount: String(m.amount), sats: Number(m.sats), at: Date.now(), net: net(), swapId: S.swap?.swapId });
      S.busy = false; S.modal = { type: 'swap-sent', hash, text: act === 'confirm-offer' ? `Your offer of ${formatZP(m.amount)} ZP for ${formatBTC(m.sats)} BTC was sent. It shows under Your offers right away, marked as waiting for the next block.` : 'The offer is being taken back: the ZP returns to your wallet.' };
      render(); setTimeout(() => { loadSwap(); refreshAll(); }, 30000); return;
    }
    if (act === 'price-mode') {
      const m = S.modal;
      keepOffer(); m.mode = t.dataset.v;
      if (m.mode !== 'total') m.per = '';   // a number typed in $ is not a number in sat
      freshScreen = true; render(); return syncOffer();
    }
    if (act === 'swap-cancel') {
      const o = S.swap?.offers.find(x => x.id === t.dataset.id), w = o && mySellers().get(o.seller); if (!o || !w) return;
      await refreshWallet(w.id);
      const d = S.data.get(w.id); if (!d?.state) throw new Error('Could not read the balance from the node');
      const prepared = await waitingFirst(pendingSpent(d), ex => prepareCancel({ w: S.open.get(w.id), state: d.state, node: node(), swapContractId: S.swap.swapId, id: o.id, amount: BigInt(o.amount), exclude: ex }));
      S.modal = { type: 'confirm-cancel', id: o.id, prepared, amount: BigInt(o.amount), sats: o.sats, wallet: w.name, release: Array.isArray(o.scriptList) ? o.scriptList.slice(Number(o.used) || 0) : [] }; S.error = ''; return render();
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
    if (act === 'buy') { S.modal = { type: 'buy', id: t.dataset.id }; S.error = ''; return render(); }
    if (act === 'dex-level') { const l = S.bookView?.[t.dataset.side + 's']?.[Number(t.dataset.i)], me = myPub(), r = l?.rows.find(x => !x.pending && !x.busy && !myOrder(x.o, me)); if (!r) return; S.draft.dtake = ''; S.modal = { type: 'dex-take', o: r.o }; S.error = ''; return render(); }
    if (act === 'dex-side') { const f = $app.querySelector('form[data-form=dex-limit]'); S.draft = { ...S.draft, dside: t.dataset.v, dprice: f?.price.value || '', damt: f?.amount.value || '' }; S.error = ''; return render(); }
    if (act === 'stab') { S.settings.stab = t.dataset.v === 'sell' ? 'sell' : 'buy'; saveSettings(); S.error = ''; return render(); }
    if (act === 'btcw-choose') { S.modal = { type: 'btcw' }; S.error = ''; return render(); }
    if (act === 'btcw-pick') { try { localStorage.setItem(BTC_WALLET_KEY, t.dataset.id); } catch { /* private mode */ } S.modal = null; return btcPayOpen(); }
    if (act === 'btc-pay') return btcPayOpen();
    if (act === 'btc-pay-go') {
      const m = S.modal; S.busy = true; render();
      try {
        const b = myBuy(), o = S.swap?.offers.find(x => x.id === b?.id);
        const why = payCheck({ offer: o, buy: b, zpTip: S.swap?.zpTip ?? 0, cap: WALLET_PAY_CAP }); if (why) throw new Error(why);
        if (o.id !== m.id || o.address !== m.address || o.sats !== m.sats) throw new Error('The reservation changed: check the payment again');
        const w = btcWallets().find(x => x.id === m.walletId); if (!w) throw new Error('The Bitcoin wallet is no longer available in this browser');
        await connectBtcWallet(w, btcNet());
        const txid = await payWithWallet(w, { to: o.address, sats: o.sats, net: btcNet(), feeRate: S.feeRate || null });
        setBuy({ ...b, btcTx: typeof txid === 'string' && txid ? txid : 'sent', btcWallet: w.name }); S.modal = null;
      } finally { S.busy = false; }
      render(); setTimeout(loadSwap, 10000); return;
    }
    if (act === 'combine') {   // transfers to this wallet's own address gather the small outputs into a few
      const a = active(); await refreshWallet(a.id);
      const d = S.data.get(a.id); if (!d?.state) throw new Error('Could not read the balance from the node');
      const c = prepareCombine(S.open.get(a.id), d.state, { exclude: pendingSpent(d) });
      stopScan(); S.errCombine = false; S.error = ''; S.modal = { type: 'combine', ...c }; return render();
    }
    if (act === 'combine-send') {
      const m = S.modal; S.busy = true; render(); let sent = 0;
      try { for (const b of m.batches) { await publish(node(), b); sent++; for (const sp of b.spent) (S.pendingVotes ||= []).push({ spent: sp, at: Date.now() }); } }
      finally { S.busy = false; }
      S.modal = { type: 'combined', sent, pieces: m.pieces, amount: m.amount }; render(); setTimeout(() => refreshAll(), 1500); return;
    }
    if (act === 'offer-max') { const i = $app.querySelector('form[data-form=offer] input[name=zp]'), bal = S.modal?.balance; if (i && bal) { i.value = formatZP(bal > 1n ? bal - 1n : 0n).replace(/,/g, ''); i.dispatchEvent(new Event('input', { bubbles: true })); } return; }
    if (act === 'addr-src') { keepOffer(); S.modal.src = t.dataset.v; S.error = ''; freshScreen = true; render(); return syncOffer(); }
    if (act === 'addr-count') { keepOffer(); S.modal.count = Number(t.dataset.v); render(); return syncOffer(); }
    if (act === 'btc-acc-change') { keepOffer(); S.modal.newKey = true; render(); syncOffer(); return $app.querySelector('input[name=xpub]')?.focus(); }
    if (act === 'btcw-sell') {
      keepOffer(); const m = S.modal, w = btcWallets().find(x => x.id === t.dataset.id); if (!w) return;
      S.busy = true; render();
      try { m.walletAddr = await connectBtcWallet(w, btcNet()); m.walletName = w.name; S.error = ''; } finally { S.busy = false; }
      render(); return syncOffer();
    }
    if (act === 'btcapi-default') { S.settings.btcApi = ''; saveSettings(); S.error = ''; return render(); }
    if (act === 'btc-acc-forget') { setBtcAccount(null); return render(); }
    if (act === 'buy-done') { setBuy(null); return render(); }
    if (act === 'buy-reserve') {
      const id = t.dataset.id, buyer = receiveAddress(S.open.get(active().id));
      S.busy = true; render();
      try {
        const r = await fetch(siteBase() + '/swap/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, buyer }) });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        if (!/^[0-9a-f]{64}$/.test(String(j.pkHash || ''))) throw new Error('The swap service sent an unexpected answer');
        if (j.pkHash !== hex(decodeAddress(buyer).hash)) throw new Error('The reservation is not for this wallet');
        const o = S.swap?.offers.find(x => x.id === id);
        setBuy({ id, buyer, pk: j.pkHash, tx: j.tx, at: Date.now(), sats: o?.sats, amount: o?.amount }); S.modal = null;
      } finally { S.busy = false; }
      render(); setTimeout(loadSwap, 15000); return;
    }
    if (act === 'dex-take') { const o = (S.markets?.orders || []).map(r => { try { return orderOf(r); } catch { return null; } }).find(x => x && x.tx === t.dataset.tx); if (o) { S.draft.dtake = ''; S.modal = { type: 'dex-take', o }; S.error = ''; render(); } return; }
    if (act === 'dex-all') { const o = S.modal?.o, i = $app.querySelector('[data-form=dex-take] [name=give]'); if (o && i) { i.value = tokenAmount(o.pairAsset, o.pairTotal).replace(/,/g, ''); i.dispatchEvent(new Event('input', { bubbles: true })); } return; }
    if (act === 'dex-cancel') { const o = (S.markets?.orders || []).map(r => { try { return orderOf(r); } catch { return null; } }).find(x => x && x.tx === t.dataset.tx); if (!o) return; S.busy = true; render(); try { await dexPrepare('cancel', o); } finally { S.busy = false; render(); } return; }
    if (act === 'dex-pick') { const f = $app.querySelector('[data-form=dex-make]'); S.draft = { ...S.draft, [t.dataset.name]: t.dataset.asset, dgamt: f?.give.value || '', dwamt: f?.want.value || '' }; S.error = ''; return render(); }
    if (act === 'bet') { S.draft.bstake = ''; S.modal = { type: 'bet', id: t.dataset.id, side: t.dataset.side }; S.error = ''; return render(); }
    if (act === 'bet-sell') { S.draft.sellAmt = undefined; S.draft.sellPrice = undefined; S.modal = { type: 'bet-sell', id: t.dataset.id, side: t.dataset.side }; S.error = ''; return render(); }
    if (act === 'sell-all') { const md = S.modal, b = (S.markets?.bets || []).find(x => x.bull === md?.id), i = $app.querySelector('[data-form=bet-sell] [name=amount]'); if (b && i) { i.value = tokenAmount(b.collateral, betHeld(b)[md.side]).replace(/,/g, ''); i.dispatchEvent(new Event('input', { bubbles: true })); } return; }
    if (act === 'bet-sellnow') {
      const md = S.modal, b = (S.markets?.bets || []).find(x => x.bull === md.id); if (!b) return;
      const asset = sideAsset(b, md.side), n = betHeld(b)[md.side], bid = bestBid(betOrders(), asset, b.collateral); if (!bid || !n) return;
      const give = n < bid.pairTotal ? n : bid.pairTotal, up = md.side === 'up';
      S.busy = true; render();
      try { await dexPrepare('take', bid, { provided: give, lines: payout => [['Sell', `${up ? '▲ Up' : '▼ Down'}: ${b.ticker} ${up ? '≥' : '<'} ${strikeText(b)}`], ['Tokens', tokenAmount(b.collateral, give)], ['You get now', withUnit(b.collateral, payout)]] }); }
      finally { S.busy = false; } return render();
    }
    if (act === 'bet-redeem') { const b = (S.markets?.bets || []).find(x => x.bull === t.dataset.id); if (!b) return; S.busy = true; render(); try { await betRedeem(b, t.dataset.side); } finally { S.busy = false; } return render(); }
    if (act === 'dex-send') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      if (m.kind === 'redeem') { S.redeemed = { ...(S.redeemed || {}), [m.key]: Date.now() }; }
      else if (m.kind !== 'make') { dexPending.set(m.o.tx, m.kind === 'cancel' ? 'cancelling' : 'taking'); if (m.kind === 'cancel') dropDexMade([m.o.tx]); }
      else addDexMade({ tx: hash, net: net(), at: Date.now(), under_asset: m.o.underAsset, under_amount: String(m.o.underAmount), pair_asset: m.o.pairAsset, pair_total: String(m.o.pairTotal), maker: myPub() });
      S.busy = false; S.modal = { type: 'dex-sent', kind: m.kind, hash, back: m.kind === 'cancel' && m.o ? withUnit(m.o.underAsset, m.o.underAmount) : null }; S.draft = { ...S.draft, dgamt: '', dwamt: '', dtake: '', dprice: '', damt: '' }; freshScreen = true;
      render(); setTimeout(() => { refreshAll(); loadMarkets(); }, 1500); return;
    }
    if (act === 'token') { S.modal = { type: 'token', asset: t.dataset.asset }; return render(); }
    if (act === 'token-send') { S.draft = { ...S.draft, asset: t.dataset.asset, amount: '' }; return go('send'); }
    if (act === 'send-asset') { S.draft = { ...S.draft, asset: t.dataset.asset, to: $app.querySelector('[name=to]')?.value || S.draft.to || '', amount: '' }; S.error = ''; return render(); }
    if (act === 'send-back') { S.draft = { ...S.draft, to: t.dataset.to, asset: t.dataset.asset || '00', amount: '' }; return go('send'); }
    if (act === 'copy') { await navigator.clipboard.writeText(t.dataset.text); t.innerHTML = I.copy + 'Copied'; return; }
    if (act === 'max') { const as = $app.querySelector('[name=asset]')?.value || S.draft.asset || '00', h = S.data.get(active().id)?.state?.assets.find(x => x.asset === as); $app.querySelector('[name=amount]').value = tokenAmount(as, h?.spendable || 0n).replace(/,/g, ''); return; }
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
      S.busy = false; S.modal = { type: 'sent', amount: m.amount, asset: m.asset || '00', hash, bridge: toBridge(m.to) && m.asset === S.bridge?.asset }; S.draft = {};
      S.screen = 'home'; render(); setTimeout(() => refreshAll(), 1500); return;
    }
  } catch (err) { fail(err); }
});

// a folded section the page re-draws stays as the person left it
$app.addEventListener('toggle', e => { const d = e.target; if (d?.dataset?.keep) (S.keep ||= {})[d.dataset.keep] = d.open; }, true);
$app.addEventListener('input', e => {
  const t = e.target; S.lastActivity = Date.now();
  if ((t.name === 'price' || t.name === 'amount') && t.closest('[data-form=bet-sell]') && S.modal?.type === 'bet-sell') {   // the total as you type
    const md = S.modal, b = (S.markets?.bets || []).find(x => x.bull === md.id), el = $app.querySelector('#sell-get'), f = t.closest('form'); S.draft.sellPrice = f.price.value; S.draft.sellAmt = f.amount.value;
    let txt = '–'; try { const o = sellOrder(f.price.value, parseUnits(f.amount.value.trim(), decimalsOf(sideAsset(b, md.side)))); txt = o.tokens > betHeld(b)[md.side] ? 'more than you hold' : withUnit(b.collateral, o.total); } catch { /* not yet */ }
    if (el) el.textContent = txt; return;
  }
  if (t.name === 'stake' && t.closest('[data-form=bet]') && S.modal?.type === 'bet') {   // the winnings as you type
    const md = S.modal, b = (S.markets?.bets || []).find(x => x.bull === md.id), o = b && bestOffer(betOrders(), sideAsset(b, md.side), b.collateral), el = $app.querySelector('#bet-win'); S.draft.bstake = t.value;
    let txt = '–'; try { const q = betQuote(o, parseUnits(t.value, decimalsOf(b.collateral))); txt = withUnit(b.collateral, q.payout) + ' (+' + tokenAmount(b.collateral, q.profit) + ')'; } catch (e) { if (/More than/.test(e.message)) txt = 'more than this offer'; }
    if (el) el.textContent = txt; return;
  }
  if (t.name === 'give' && t.closest('[data-form=dex-take]') && S.modal?.o) {   // the payout as you type
    const o = S.modal.o, el = $app.querySelector('#dex-get'); S.draft.dtake = t.value;
    let txt = '–'; try { const p = o.pairAsset === '00' ? parseZP(t.value.trim().replace(/,/g, '')) : parseUnits(t.value, decimalsOf(o.pairAsset)); if (p > 0n && p <= o.pairTotal && payoutFor(o, p) > 0n) txt = withUnit(o.underAsset, payoutFor(o, p)); else if (p > o.pairTotal) txt = 'more than the order'; } catch { /* not yet */ }
    if (el) el.textContent = txt; return;
  }
  if (t.name === 'to' && t.closest('[data-form=send]') && (toBridge(t.value) !== toBridge(S.draft.to) || !!contractNames[t.value.trim()] !== !!contractNames[String(S.draft.to || '').trim()])) { S.draft = { ...S.draft, to: t.value, amount: $app.querySelector('[name=amount]')?.value || '' }; render(); const i = $app.querySelector('[name=to]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } return; }
  if (t.name === 'asset' && t.closest('[data-form=send]')) { S.draft = { ...S.draft, asset: t.value, to: $app.querySelector('[name=to]')?.value || '', amount: '' }; S.error = ''; return render(); }
  if ((t.name === 'price' || t.name === 'amount') && t.closest('form[data-form=dex-limit]')) syncLimit();
  else if (t.name === 'pct') syncAlloc(t.value, 'field');
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
      case 'bet-sell': {
        const md = S.modal, b = (S.markets?.bets || []).find(x => x.bull === md.id); if (!b) throw new Error('This market is gone');
        S.draft.sellPrice = v.price; S.draft.sellAmt = v.amount;
        const asset = sideAsset(b, md.side), held = betHeld(b)[md.side], up = md.side === 'up';
        let o; try { o = sellOrder(v.price, parseUnits(String(v.amount).trim(), decimalsOf(asset))); } catch (e) { throw fieldError(e.message, /price/i.test(e.message) || /at most 1/.test(e.message) ? 'price' : 'amount'); }
        if (o.tokens > held) throw fieldError(`You hold ${tokenAmount(b.collateral, held)} tokens`, 'amount');
        S.busy = true; render();
        try { await dexPrepare('make', { underAsset: asset, underAmount: o.tokens, pairAsset: b.collateral, pairTotal: o.total }, { lines: () => [['Sell', `${up ? '▲ Up' : '▼ Down'}: ${b.ticker} ${up ? '≥' : '<'} ${strikeText(b)}`], ['Tokens', tokenAmount(b.collateral, o.tokens)], ['Price per token', o.price.toFixed(4) + ' zUSDC'], ['You get when it sells', withUnit(b.collateral, o.total)]] }); }
        finally { S.busy = false; } return render();
      }
      case 'bet': {
        const md = S.modal, b = (S.markets?.bets || []).find(x => x.bull === md.id), o = b && bestOffer(betOrders(), sideAsset(b, md.side), b.collateral);
        if (!o) throw new Error('This offer is gone: close and pick again');
        const raw = String(v.stake || '').trim(); S.draft.bstake = raw;
        const q = betQuote(o, parseUnits(raw, decimalsOf(b.collateral)));
        const have = S.data.get(active().id)?.state?.assets.find(x => x.asset === b.collateral)?.spendable || 0n;
        if (q.stake > have) throw new Error(`You have ${withUnit(b.collateral, have)}`);
        const up = md.side === 'up';
        S.busy = true; render();
        try { await dexPrepare('bet', o, { provided: q.stake, lines: payout => [['Bet', `${up ? '▲ Up' : '▼ Down'}: ${b.ticker} ${up ? '≥' : '<'} ${strikeText(b)}`], ['Closes', closeText(b.close)], ['Your stake', withUnit(b.collateral, q.stake)], ['If right you get', withUnit(b.collateral, payout)]] }); }
        finally { S.busy = false; } return render();
      }
      case 'dex-take': {
        const o = S.modal.o, raw = String(v.give || '').trim(); S.draft.dtake = raw;
        const provided = o.pairAsset === '00' ? parseZP(raw.replace(/,/g, '')) : parseUnits(raw, decimalsOf(o.pairAsset));
        if (provided <= 0n) throw new Error('Enter how much you give');
        if (provided > o.pairTotal) throw new Error(`The order takes at most ${withUnit(o.pairAsset, o.pairTotal)}`);
        S.busy = true; render(); try { await dexPrepare('take', o, { provided }); } finally { S.busy = false; } return render();
      }
      case 'dex-limit': {
        const side = S.draft.dside === 'sell' ? 'sell' : 'buy', q = S.bookView?.q; S.draft = { ...S.draft, dprice: v.price, damt: v.amount };
        if (!q) throw new Error('No zUSDC on this network');
        let price8, amount; try { price8 = parsePrice(v.price); } catch (e) { throw fieldError(e.message, 'price'); }
        try { amount = parseZP(String(v.amount).trim().replace(/,/g, '')); } catch (e) { throw fieldError(e.message, 'amount'); }
        let o; try { o = limitOrder({ side, price8, amount, quote: q }); } catch (e) { throw fieldError(e.message, 'amount'); }
        const d = bookData(S.markets), ba = d?.asks.find(r => !r.pending), bb = d?.bids.find(r => !r.pending), p = Number(price8) / 1e8, warn = [];
        if (side === 'buy' && ba && p >= ba.price) warn.push(`Someone already sells at ${ba.price.toFixed(4)}: this order does not buy from them, it waits in the book. To buy now, tap that price in the book instead.`);
        if (side === 'sell' && bb && p <= bb.price) warn.push(`Someone already buys at ${bb.price.toFixed(4)}: this order does not sell to them, it waits in the book. To sell now, tap that price in the book instead.`);
        const mid = ba && bb ? (ba.price + bb.price) / 2 : ba?.price || bb?.price;
        if (mid && Math.abs(p - mid) / mid > 0.05) warn.push(`Your price is ${Math.round(Math.abs(p - mid) / mid * 100)}% ${p > mid ? 'above' : 'below'} the middle of the book (${mid.toFixed(4)}).`);
        S.busy = true; render(); try { await dexPrepare('make', o, { warn }); } finally { S.busy = false; } return render();
      }
      case 'dex-make': {
        const give = S.draft.dgive || '00', known = $app.querySelector('[data-form=dex-make] [data-name=dwant].on')?.dataset.asset || S.draft.dwant;
        S.draft = { ...S.draft, dgamt: v.give, dwamt: v.want };
        if (!known || known === give) throw new Error('Choose what you want for it');
        const amt = (a, x) => a === '00' ? parseZP(String(x).trim().replace(/,/g, '')) : parseUnits(x, decimalsOf(a));
        const underAmount = amt(give, v.give), pairTotal = amt(known, v.want);
        if (underAmount <= 0n || pairTotal <= 0n) throw new Error('Enter both amounts');
        S.busy = true; render(); try { await dexPrepare('make', { underAsset: give, underAmount, pairAsset: known, pairTotal }); } finally { S.busy = false; } return render();
      }
      case 'send': {
        const asset = v.asset || S.draft.asset || '00', to = v.to.trim(); S.draft = { to, amount: v.amount, asset };
        if (!isValidAddress(to, net())) { decodeAddress(to); throw new Error('Not a valid address for this network'); }
        const amount = asset === '00' ? parseZP((r => /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(r) ? r.replace(/,/g, '') : r)(v.amount.trim())) : parseUnits(v.amount, decimalsOf(asset));   // only thousands separators; "1,5" is refused
        if (amount <= 0n) throw new Error('Enter an amount');
        const a = active(); await refreshWallet(a.id);
        const d = S.data.get(a.id);
        if (!d?.state || d.error) throw new Error('Could not read the balance from the node' + (d?.error ? ': ' + d.error : ''));
        const prepared = prepareSend(S.open.get(a.id), S.data.get(a.id).state, to, amount, asset);
        S.modal = { type: 'confirm-send', to, amount, asset, prepared }; S.error = ''; return render();
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
        const m = S.modal; Object.assign(m, { zp: v.zp, btc: v.btc, per: v.per, addrs: v.addrs ?? m.addrs, xpub: v.xpub ?? m.xpub });
        const raw = v.zp.trim(), amount = parseZP(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw);
        if (amount <= 0n) throw fieldError('Enter the ZP to sell', 'zp');
        if (m.balance != null && amount > m.balance) throw fieldError(`You have ${formatZP(m.balance)} ZP to sell; the fee is 1 kalapa, so at most ${formatZP(m.balance > 1n ? m.balance - 1n : 0n)} ZP`, 'zp');
        const sats = offerTotal(f, amount);
        if (!S.swap?.swapId) throw new Error('The swap contract is not running on this network');
        const market = S.swap.offers.flatMap(o => Array.isArray(o.scriptList) ? o.scriptList : []), known = usedScripts(), src = m.src || 'key';
        let addrs, scripts, checked = true, indexes = null;
        if (src === 'key') {
          // new receive addresses from the account key, after the last one used on Bitcoin and within the gap limit
          const saved = btcAccount(), text = m.newKey || !saved ? String(v.xpub || '').trim() : saved.key;
          let acc; try { acc = parseAccount(text, btcNet()); } catch (e) { throw fieldError(e.message, 'xpub'); }
          const r = await freshAddresses(acc, { count: m.count || 2, lastUsed: saved?.key === acc.key ? saved.lastUsed : -1, known, market, api: btcApi() });
          addrs = r.list.map(x => x.addr); scripts = r.list.map(x => x.script); checked = r.checked; indexes = r.list.map(x => [x.addr, x.index]);
          setBtcAccount({ key: acc.key, lastUsed: r.lastUsed });
          m.newKey = false; m.xpub = '';
        } else {
          if (src === 'wallet') { if (!m.walletAddr) throw new Error('Choose your Bitcoin wallet first'); addrs = [m.walletAddr]; }
          else addrs = String(v.addrs || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
          if (!addrs.length || addrs.length > MAX_SCRIPTS) throw fieldError(`Give 1 to ${MAX_SCRIPTS} Bitcoin addresses`, 'addrs');
          scripts = addrs.map((x, i) => { try { return btcScript(x, btcNet()); } catch (e) { throw fieldError(`Bitcoin address ${i + 1}: ${e.message}`, 'addrs'); } });
          if (new Set(scripts).size !== scripts.length) throw fieldError('Each Bitcoin address must be different', 'addrs');
          const fresh = await checkFresh(scripts, addrs, { known, market, api: btcApi() });
          if (fresh.bad.length) throw (src === 'type' ? fieldError('Use a new Bitcoin address for each line: ' + fresh.bad.join('; ') + '.', 'addrs') : new Error(`${m.walletName} gave an address that was used before (${fresh.bad.join('; ')}). Make a new receive address in it, or use your account key.`));
          checked = fresh.checked;
        }
        const a = active(); await refreshWallet(a.id);
        const d = S.data.get(a.id); if (!d?.state || d.error) throw new Error('Could not read the balance from the node');
        const offerId = newOfferId();
        const prepared = await waitingFirst(pendingSpent(d), ex => prepareOffer({ w: S.open.get(a.id), state: d.state, node: node(), swapContractId: S.swap.swapId, id: offerId, amount, sats, scripts, exclude: ex }));
        S.modal = { type: 'confirm-offer', id: offerId, prepared, amount, sats, addrs, scripts, unchecked: !checked, src, indexes }; S.error = ''; return render();
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
      case 'btcapi': {
        const url = v.url.trim().replace(/\/+$/, '');
        if (!url) { S.settings.btcApi = ''; saveSettings(); S.error = ''; return render(); }
        let u = null; try { u = new URL(url); } catch { /* invalid */ }
        if (!(u && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) && !u.username && !u.password)) throw fieldError('Use https://, or http://localhost for a service on this computer', 'url');
        let h = NaN; try { const r = await fetch(url + '/blocks/tip/height', { cache: 'no-store' }); h = Number(await r.text()); } catch { /* below */ }
        if (!(h > 0)) throw fieldError('That service did not answer like an Esplora API (GET /blocks/tip/height)', 'url');
        S.settings.btcApi = url; saveSettings(); S.error = ''; S.btcApiOk = h; return render();
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
// the Dex tab follows the book (the site's index is fresh to one block)
// bets: the wallet's own Up/Down tokens change when an order is taken or mined, so its balance is read again too (each minute)
setInterval(() => { if (S.key && S.screen === 'markets' && (S.settings.mtab || 'oracle') === 'oracle' && S.markets?.bets?.length && !S.modal && !document.hidden) refreshWallet(active().id).then(render).catch(() => {}); }, 60000);
setInterval(() => { if (S.key && S.screen === 'markets' && (S.settings.mtab || 'oracle') !== 'swap' && !S.modal && !document.hidden && !$app.querySelector('form[data-form=dex-limit] input:focus')) loadMarkets(); }, 20000);
setInterval(() => { if (S.key && S.screen === 'markets' && (S.settings.mtab || 'oracle') === 'swap' && !S.modal && !document.hidden && myBuy() && !myBuy().paid) loadSwap(); }, 10000);   // a purchase in progress
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

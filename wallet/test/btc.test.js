// ZP <-> BTC helpers: BIP84/BIP49 receive addresses (published vectors and the reference derivation), fresh
// addresses that skip used ones, waiting times, the pay check, and the Bitcoin wallet adapters against fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { parseAccount, accountAddress, freshAddresses, fetchFeeRate, confsFor, afterPayMin, payCheck, bip21, findBtcWallets, connectBtcWallet, payWithWallet } from '../src/btc.js';
import { btcScript } from '../src/swap.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

test('BIP84: the published test vectors', () => {
  const acc = parseAccount(ZPUB);
  assert.equal(acc.kind, 'wpkh');
  assert.equal(accountAddress(acc, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(accountAddress(acc, 1), 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
});

test('xpub and ypub give the same keys as the derivation from the seed', () => {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON));
  const a84 = root.derive("m/84'/0'/0'"), xpub = a84.publicExtendedKey;   // standard xpub version
  assert.equal(accountAddress(parseAccount(xpub), 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  const a49 = root.derive("m/49'/0'/0'");
  const ypub = new HDKey({ versions: { private: 0x049d7878, public: 0x049d7cb2 }, depth: 3, index: a49.index, parentFingerprint: a49.parentFingerprint, chainCode: a49.chainCode, publicKey: a49.publicKey }).publicExtendedKey;
  const acc = parseAccount(ypub); assert.equal(acc.kind, 'sh-wpkh');
  const p = accountAddress(acc, 0); assert.match(p, /^3/);
  assert.equal(p, '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');   // BIP49 vector for this seed on mainnet
});

test('account keys: private keys, wrong network and wrong depth are refused', () => {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON));
  assert.throws(() => parseAccount(root.derive("m/84'/0'/0'").privateExtendedKey), /private key/);
  assert.throws(() => parseAccount(ZPUB, 'test'), /mainnet/);
  assert.throws(() => parseAccount(root.publicExtendedKey), /depth 3/);
  assert.throws(() => parseAccount('zpub123'), /Not a valid/);
});

test('fresh addresses skip used, market and funded ones; a funded one moves the window', async () => {
  const acc = parseAccount(ZPUB);
  const s = i => btcScript(accountAddress(acc, i));
  const funded = accountAddress(acc, 3);
  const fetchFn = async url => ({ ok: true, json: async () => ({ chain_stats: { funded_txo_count: url.endsWith(funded) ? 1 : 0 }, mempool_stats: { funded_txo_count: 0 } }) });
  const r = await freshAddresses(acc, { count: 3, known: [s(0)], market: [s(2)], fetchFn, api: 'x' });
  assert.deepEqual(r.list.map(x => x.index), [1, 4, 5]);
  assert.equal(r.lastUsed, 3); assert.equal(r.checked, true);
  const again = await freshAddresses(acc, { count: 1, lastUsed: r.lastUsed, known: [s(0), s(1), s(2), s(4), s(5)], fetchFn, api: 'x' });
  assert.equal(again.list[0].index, 6);
  const down = await freshAddresses(acc, { count: 1, fetchFn: async () => { throw new Error('offline'); }, api: 'x' });
  assert.equal(down.checked, false);
});

test('the gap limit: 6 offers of 4 addresses, none paid -> the 6th is refused; a take-back frees its addresses', async () => {
  const acc = parseAccount(ZPUB), never = async () => ({ ok: true, json: async () => ({ chain_stats: { funded_txo_count: 0 }, mempool_stats: { funded_txo_count: 0 } }) });
  let known = [];
  for (let k = 0; k < 5; k++) { const r = await freshAddresses(acc, { count: 4, known, fetchFn: never, api: 'x' }); known = [...known, ...r.list.map(x => x.script)]; assert.equal(r.list.at(-1).index, k * 4 + 3); }
  await assert.rejects(freshAddresses(acc, { count: 4, known, fetchFn: never, api: 'x' }), e => e.gap === true && /would not see payments beyond this: 20 addresses/.test(e.message) && /gap limit/.test(e.message));
  const r = await freshAddresses(acc, { count: 4, known: known.slice(4), fetchFn: never, api: 'x' });   // the first offer taken back unreserved
  assert.deepEqual(r.list.map(x => x.index), [0, 1, 2, 3]);
  const paid = accountAddress(acc, 7), some = async u => ({ ok: true, json: async () => ({ chain_stats: { funded_txo_count: u.endsWith(paid) ? 1 : 0 }, mempool_stats: { funded_txo_count: 0 } }) });
  const moved = await freshAddresses(acc, { count: 4, known, fetchFn: some, api: 'x' });   // address 7 was paid: the window reaches 27
  assert.deepEqual(moved.list.map(x => x.index), [20, 21, 22, 23]); assert.equal(moved.lastUsed, 7);
});

test('the network fee: next-block rate from Esplora, rounded up', async () => {
  const f = j => async () => ({ ok: true, json: async () => j });
  assert.equal(await fetchFeeRate('x', f({ 1: 12.2, 2: 9 })), 13);
  assert.equal(await fetchFeeRate('x', f({ 2: 4.5 })), 5);
  assert.equal(await fetchFeeRate('x', async () => { throw new Error('down'); }), null);
});

test('waiting times follow the contract', () => {
  assert.deepEqual([1e6, 1e6 + 1, 1e7, 1e8, 1e8 + 1].map(confsFor), [2, 3, 3, 4, 6]);
  assert.equal(afterPayMin(90000), 26);
});

test('the pay check: own active reservation, enough time, the cap', () => {
  const offer = { id: 'o-1', buyer: 'AB', state: 'reserved', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', sats: 90000, until: 120 };
  const buy = { id: 'o-1', pk: 'ab' };
  assert.equal(payCheck({ offer, buy, zpTip: 100 }), null);               // 20 left > 12 needed
  assert.match(payCheck({ offer, buy, zpTip: 108 }), /Too little time/);  // 12 left
  assert.match(payCheck({ offer, buy: { ...buy, pk: 'cd' }, zpTip: 100 }), /not reserved for this wallet/);
  assert.match(payCheck({ offer: { ...offer, payment: {} }, buy, zpTip: 100 }), /already/);
  assert.match(payCheck({ offer: { ...offer, sats: 2e6 }, buy, zpTip: 100, cap: 1e6 }), /limited to 0.01000000 BTC/);
  assert.equal(bip21(offer.address, 90000), `bitcoin:${offer.address}?amount=0.0009`);
});

test('Bitcoin wallets: WBIP004 providers with their icon, UniSat and OKX without', async () => {
  const calls = [];
  const xverse = { request: async (m, p) => { calls.push([m, p]); return m === 'getAddresses' ? { jsonrpc: '2.0', result: { addresses: [{ address: 'bc1pxxx', purpose: 'ordinals' }, { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', purpose: 'payment' }] } } : { result: { txid: 'aa'.repeat(32) } }; } };
  const leather = { request: async (m, p) => { calls.push([m, p]); return m === 'getAddresses' ? { result: { addresses: [{ symbol: 'BTC', type: 'p2tr', address: 'bc1pzzz' }, { symbol: 'BTC', type: 'p2wpkh', address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' }] } } : { result: { txid: 'bb'.repeat(32) } }; } };
  const win = {
    btc_providers: [
      { id: 'XverseProviders.BitcoinProvider', name: 'Xverse Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+' },
      { id: 'LeatherProvider', name: 'Leather', icon: 'javascript:alert(1)' },
      { id: 'Missing.Provider', name: 'Gone' },
    ],
    XverseProviders: { BitcoinProvider: xverse }, LeatherProvider: leather,
    unisat: { requestAccounts: async () => ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'], sendBitcoin: async () => 'cc'.repeat(32) },
    okxwallet: { bitcoin: { connect: async () => ({ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }), sendBitcoin: async (to, s, o) => { calls.push(['okx', to, s, o]); return 'dd'.repeat(32); } } },
  };
  const ws = findBtcWallets(win);
  assert.deepEqual(ws.map(w => w.name), ['Xverse Wallet', 'Leather', 'UniSat', 'OKX Wallet']);
  assert.equal(ws[0].icon, 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(ws[1].icon, null);                                          // not a data: image: not shown
  assert.equal(ws[2].icon, null);                                          // UniSat gives none and none was bundled
  const withLogos = findBtcWallets(win, { unisat: 'data:image/png;base64,AAAA', okx: 'data:image/webp;base64,BBBB' });
  assert.deepEqual(withLogos.map(w => [w.name, w.icon, !!w.bundled]), [['Xverse Wallet', 'data:image/svg+xml;base64,PHN2Zy8+', false], ['Leather', null, false], ['UniSat', 'data:image/png;base64,AAAA', true], ['OKX Wallet', 'data:image/webp;base64,BBBB', true]]);
  assert.equal(await connectBtcWallet(ws[0]), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(await connectBtcWallet(ws[1]), 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
  await assert.rejects(connectBtcWallet(ws[2]), /UniSat is on Bitcoin testnet/);
  const to = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
  assert.equal(await payWithWallet(ws[0], { to, sats: 90000 }), 'aa'.repeat(32));
  assert.deepEqual(calls.find(c => c[0] === 'sendTransfer' && c[1].recipients[0].amount === 90000)[1], { recipients: [{ address: to, amount: 90000 }] });
  await payWithWallet(ws[1], { to, sats: 90000 });
  assert.deepEqual(calls.filter(c => c[0] === 'sendTransfer')[1][1], { recipients: [{ address: to, amount: '90000' }], network: 'mainnet' });
  await payWithWallet(ws[3], { to, sats: 90000, feeRate: 13 });
  assert.deepEqual(calls.at(-1), ['okx', to, 90000, { feeRate: 13 }]);
  await assert.rejects(payWithWallet(ws[0], { to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', sats: 1 }), /testnet/);
  const refuse = { ...ws[0], send: async () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); } };
  await assert.rejects(payWithWallet(refuse, { to, sats: 5 }), /cancelled/);
});

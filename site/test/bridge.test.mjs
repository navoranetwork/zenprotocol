// The bridge's withdrawals against a mock node: read from the node (not the explorer), paid automatically after
// BRIDGE_ZP_CONFIRMATIONS blocks to the linked EVM address, never twice, and never for an unlinked sender.
//   node --test site/test/bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSET = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577';
const BRIDGE = 'tzn1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqshjlp3';
const USER = 'tzn1qjyg6ddlvm95lnwym6efpsaxkfc04up4yszdrh6nexkau9u36c3zs87wpyf', STRANGER = 'tzn1q8rzk3kl7e2dzvkmezhmhv28knmgf8v5mzauzr4a3nlx8yqlnsuuslnjhx0';
const EVM = '0x7c4f1c7966fe0eb6085aaed9fa835118ec61dd6d';
const h = c => c.repeat(64);
const pk = address => ({ PK: { hash: '00'.repeat(32), address } });

function mockNode() {
  const st = { txs: {}, executed: [] };
  const add = (hash, conf, inputs, outputs) => { st.txs[hash] = { tx: { version: 0, inputs, outputs }, confirmations: conf }; };
  // the user's zUSDC (an earlier transaction) and two withdrawals: 1.00 from the user, 3.00 from an unlinked address
  add(h('a'), 9, [], [{ lock: pk(USER), spend: { asset: ASSET, amount: 2000000 } }]);
  add(h('c'), 9, [], [{ lock: pk(STRANGER), spend: { asset: ASSET, amount: 3000000 } }]);
  add(h('1'), 1, [{ outpoint: { txHash: h('a'), index: 0 } }], [{ lock: pk(BRIDGE), spend: { asset: ASSET, amount: 1000000 } }, { lock: pk(USER), spend: { asset: ASSET, amount: 1000000 } }]);
  add(h('2'), 5, [{ outpoint: { txHash: h('c'), index: 0 } }], [{ lock: pk(BRIDGE), spend: { asset: ASSET, amount: 3000000 } }]);
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const u = new URL(req.url, 'http://x'), send = (c, v) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (u.pathname === '/wallet/address') return send(200, BRIDGE);
      if (u.pathname === '/blockchain/transaction') { const t = st.txs[u.searchParams.get('hash')]; return t ? send(200, t) : send(400, 'transaction not found'); }
      if (u.pathname === '/addressdb/transactions') return send(200, [h('1'), h('2')].map(x => ({ txHash: x, asset: ASSET, amount: String(st.txs[x].tx.outputs[0].spend.amount), confirmations: st.txs[x].confirmations })));
      if (u.pathname === '/wallet/contract/execute') { st.executed.push(JSON.parse(b)); return send(200, 'f'.repeat(64)); }
      send(404, { error: 'mock: ' + u.pathname });
    });
  });
  return { st, srv };
}

test('withdrawals: from the node, automatic after the confirmations, once, only for linked senders', async () => {
  const { st, srv } = mockNode(); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify({ [EVM]: { zp: USER, since: 1 } }));
  fs.writeFileSync(path.join(dir, 'zo.mjs'), "console.log('00')");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const p = spawn(process.execPath, [path.join(here, '../bridge/bridge.mjs')], { env: { ...process.env, BRIDGE_NODE: `http://127.0.0.1:${srv.address().port}`, BRIDGE_CONTRACT: 'ctzn1x', BRIDGE_ASSET: ASSET,
    BRIDGE_EVM: 'mock:' + path.join(dir, 'evm.json'), BRIDGE_DATA: dir, BRIDGE_LISTEN: '127.0.0.1:' + port, BRIDGE_INTERVAL: '0.3', BRIDGE_ZO: process.execPath + ' ' + path.join(dir, 'zo.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const api = async (m, pth, body) => (await fetch(`http://127.0.0.1:${port}${pth}`, body ? { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    for (let i = 0; i < 50 && !/bridge on/.test(out); i++) await sleep(100);
    await sleep(900);
    let look = await api('GET', '/lookup?evm=' + EVM);
    assert.deepEqual(look.arriving, [{ zpTx: h('1'), amount: '1000000', confirmations: 1, need: 2 }], out);
    assert.equal(st.executed.length, 0, 'nothing paid before 2 confirmations; the unlinked 3.00 is never paid');
    const claim = await api('POST', '/withdraw', { zpTx: h('1'), evm: EVM });
    assert.match(claim.error, /waiting for ZP blocks: 1 of 2/);
    st.txs[h('1')].confirmations = 2; await sleep(1200);
    look = await api('GET', '/lookup?evm=' + EVM);
    assert.equal(look.withdrawals.length, 1); assert.equal(look.withdrawals[0].amount, '1000000'); assert.deepEqual(look.arriving, []);
    assert.equal(st.executed.length, 1); assert.equal(st.executed[0].command, 'Destroy'); assert.equal(st.executed[0].spends[0].amount, 1000000);
    assert.equal((await api('POST', '/withdraw', { zpTx: h('1'), evm: EVM })).amount, '1000000', 'a later claim returns the payout already made');
    await sleep(800); assert.equal(st.executed.length, 1, 'paid once');
    const st2 = await api('GET', '/status'); assert.equal(st2.zpConfirmations, 2); assert.equal(st2.autoWithdraw, true);
    assert.match((await api('POST', '/withdraw', { zpTx: h('2'), evm: EVM })).error, /not linked/);
    assert.match((await api('POST', '/withdraw', { zpTx: h('9'), evm: EVM })).error, /not found/);
  } finally { p.kill(); srv.close(); }
});

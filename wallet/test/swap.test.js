// ZP <-> BTC swap: Bitcoin addresses to scripts, offer and cancel bodies, and the signed contract call
// (a fake node plays /contract/execute the way TransactionHandler.executeContract builds the transaction).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { btcScript, parseBTC, offerBody, checkOfferId, checkFresh } from '../src/swap.js';
import { openWallet, prepareOffer, prepareCancel, signerOf } from '../src/wallet.js';
import { deriveKey } from '../src/keys.js';
import { verifyDigest } from '../src/tx.js';
import { Reader, Writer, VarInt, Outpoint, Output, Data, ContractId, Str, ZEN_ASSET, deserializeTx, serializeTx, txHash, witnessesHash, hex, unhex } from '../src/serialize.js';

test('Bitcoin addresses become output scripts (BIP173/BIP350 vectors, legacy)', () => {
  assert.equal(btcScript('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'), '0014751e76e8199196d454941c45d1b3a323f1433bd6');
  assert.equal(btcScript('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'), '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(btcScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');
  assert.equal(btcScript('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), 'a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87');
  assert.equal(btcScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'test'), '0014751e76e8199196d454941c45d1b3a323f1433bd6');
  assert.throws(() => btcScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), /testnet address/);
  assert.throws(() => btcScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'), /check every character/);   // one character changed
  assert.throws(() => btcScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kV8f3t4'), /Mixed/);
  assert.throws(() => btcScript('zen1qxyz'), /check every character|Not a/);
  // bech32 checksum on a v1 program (BIP350: must be bech32m)
  assert.throws(() => btcScript('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx'));
});

test('prices and ids', () => {
  assert.equal(parseBTC('0.0005'), 50000n); assert.equal(parseBTC('1 BTC'), 100000000n);
  assert.throws(() => parseBTC('0.000001'), /at least/); assert.throws(() => parseBTC('1,5'), /Enter the price/);
  assert.throws(() => checkOfferId('chain'), /reserved/); assert.throws(() => checkOfferId('u3')); assert.throws(() => checkOfferId('A b'), /3 to 24/);
  assert.throws(() => offerBody({ id: 'o-1', sats: 1000n, scripts: ['0014aa', '0014aa'].map(s => s + '00'.repeat(19)), returnHash: new Uint8Array(32) }), /different/);
});

const SWAP = '00000001' + 'ab'.repeat(32);
const phrase = Array(23).fill('abandon').concat('art').join(' ');
function fixture({ tamper, contractAdds } = {}) {
  const w = openWallet({ id: 'a', name: 'a', network: 'test', kind: 'mnemonic' }, phrase);
  const k = deriveKey(w.account, 0, 0);
  const utxos = [3n, 2n].map((z, i) => ({ outpoint: { txHash: new Uint8Array(32).fill(7 + i), index: i }, lock: { type: 'PK', hash: k.pkHash }, spend: { asset: '00', amount: z * 100000000n } }));
  const calls = [];
  const node = {
    executeContract: async b => {
      calls.push(b);
      const r = new Reader(unhex(b.tx));
      const n = VarInt.read(r), inputs = [];
      for (let i = 0; i < n; i++) { assert.equal(r.u8(), 1); inputs.push({ type: 'outpoint', outpoint: Outpoint.read(r) }); Output.read(r); }
      const m = VarInt.read(r), outputs = []; for (let i = 0; i < m; i++) outputs.push(Output.read(r));
      const body = Data.read(new Reader(unhex(b.messageBody)));
      const add = contractAdds(body);
      let tx = { version: 0, inputs: [...inputs, ...add.inputs], outputs: [...outputs, ...add.outputs], contract: null, witnesses: [{ type: 'Contract',
        contractId: { version: 1, hash: unhex(SWAP.slice(8)) }, command: b.command, messageBody: body, stateCommitment: { type: 'NotCommitted' },
        beginInputs: inputs.length, beginOutputs: outputs.length, inputsLength: add.inputs.length, outputsLength: add.outputs.length, signature: null, cost: 4156n }] };
      if (tamper) tx = tamper(tx);
      return hex(serializeTx(tx));
    },
  };
  return { w, k, state: { tip: 2100, utxos }, node, calls };
}
const swapLock = { type: 'Contract', contractId: { version: 1, hash: unhex(SWAP.slice(8)) } };
const scripts = [btcScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), btcScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')];
// as BitZenSwap does (finish/withMarker): the offer's ZP to the swap, plus 1 of the swap's own token minted and locked to it
const swapAsset = { contract: { version: 1, hash: unhex(SWAP.slice(8)) }, subtype: new Uint8Array(32) };
const offerAdds = amount => () => ({ inputs: [{ type: 'mint', spend: { asset: swapAsset, amount: 1n } }],
  outputs: [{ lock: swapLock, spend: { asset: ZEN_ASSET, amount } }, { lock: swapLock, spend: { asset: swapAsset, amount: 1n } }] });

// what ContractV0.fs getSender checks: SHA3(txHash ‖ Serialization.Message.serialize {recipient, command, body})
const senderMsg = (tx, cw) => { const w = new Writer(); ContractId.write(w, cw.contractId); Str.write(w, cw.command); w.u8(1); Data.write(w, cw.messageBody); return sha3_256(Uint8Array.from([...txHash(tx), ...w.out()])); };

test('an offer: ZP for the contract from two inputs, the seller signs the call, the last PK witness covers it', async () => {
  const amount = 400000000n, f = fixture({ contractAdds: offerAdds(amount) });
  const out = await prepareOffer({ w: f.w, state: f.state, node: f.node, swapContractId: SWAP, id: 'o-test', amount, sats: 50000n, scripts });
  assert.equal(f.calls[0].options.sender, hex(f.k.publicKey));
  const tx = deserializeTx(unhex(out.hex));
  assert.deepEqual(tx.witnesses.map(x => x.type + ':' + (x.sigHash || '')), ['PK:TxHash', 'PK:FollowingWitnesses', 'Contract:']);
  assert.ok(verifyDigest(tx.witnesses[0].signature, txHash(tx), f.k.publicKey));
  assert.ok(verifyDigest(tx.witnesses[1].signature, sha3_256(Uint8Array.from([...txHash(tx), ...witnessesHash([tx.witnesses[2]])])), f.k.publicKey));
  const cw = tx.witnesses[2];
  assert.equal(hex(cw.signature.publicKey), hex(f.k.publicKey));
  assert.ok(verifyDigest(cw.signature.signature, senderMsg(tx, cw), f.k.publicKey));
  // change 0.99999999 ZP, fee 1 kalapa, 4 ZP locked in the contract
  assert.deepEqual(tx.outputs.map(o => [o.lock.type, o.spend.amount]), [['PK', 99999999n], ['Fee', 1n], ['Contract', amount], ['Contract', 1n]]);
  assert.equal(tx.inputs.length, 3); assert.equal(tx.inputs[2].type, 'mint');
  const body = Object.fromEntries(cw.messageBody.v.map(([k, v]) => [k, v]));
  assert.equal(body.id.v, 'o-test'); assert.equal(body.sats.v, 50000n); assert.equal(body.s0.v, scripts[0]); assert.equal(body.s1.v, scripts[1]); assert.equal(body.s2, undefined);
  assert.equal(hex(body.returnAddress.v.hash), hex(signerOf(f.w).pkHash));
});

test('a node or contract that sends the offer’s ZP elsewhere, or changes our part, is refused', async () => {
  const amount = 400000000n;
  const thief = { type: 'PK', hash: new Uint8Array(32).fill(9) };
  const run = (contractAdds, tamper) => { const f = fixture({ contractAdds, tamper });
    return prepareOffer({ w: f.w, state: f.state, node: f.node, swapContractId: SWAP, id: 'o-test', amount, sats: 50000n, scripts }); };
  await assert.rejects(run(() => ({ inputs: [], outputs: [{ lock: thief, spend: { asset: ZEN_ASSET, amount } }] })), /not signed/);
  await assert.rejects(run(offerAdds(amount - 1n)), /not signed/);
  const otherAsset = { contract: { version: 1, hash: new Uint8Array(32).fill(5) }, subtype: new Uint8Array(32) };
  await assert.rejects(run(() => ({ inputs: [{ type: 'mint', spend: { asset: swapAsset, amount: 1n } }],   // the marker sent elsewhere
    outputs: [{ lock: swapLock, spend: { asset: ZEN_ASSET, amount } }, { lock: thief, spend: { asset: swapAsset, amount: 1n } }] })), /not signed/);
  await assert.rejects(run(() => ({ inputs: [{ type: 'mint', spend: { asset: otherAsset, amount: 1n } }],  // a mint of another contract's token
    outputs: [{ lock: swapLock, spend: { asset: ZEN_ASSET, amount } }, { lock: swapLock, spend: { asset: otherAsset, amount: 1n } }] })), /not signed/);
  await assert.rejects(run(offerAdds(amount), tx => ({ ...tx, outputs: [{ ...tx.outputs[0], lock: thief }, ...tx.outputs.slice(1)] })), /changed the outputs/);
  await assert.rejects(run(offerAdds(amount), tx => ({ ...tx, witnesses: [{ ...tx.witnesses[0], messageBody: { t: 'Dict', v: [] } }] })), /changed the message/);
  await assert.rejects(run(offerAdds(amount), tx => ({ ...tx, witnesses: [{ ...tx.witnesses[0], outputsLength: 0 }] })), /unexpected contract witness/);
  const f = fixture({ contractAdds: offerAdds(amount) });
  await assert.rejects(prepareOffer({ w: f.w, state: f.state, node: f.node, swapContractId: SWAP, id: 'o-test', amount: 500000000n, sats: 1n, scripts }), /Not enough/);
});

test('cancel: only the fee from us, the offer’s ZP back to the signer', async () => {
  const amount = 400000000n, me = signerOf(openWallet({ id: 'a', name: 'a', network: 'test', kind: 'mnemonic' }, phrase));
  const back = () => ({ inputs: [{ type: 'outpoint', outpoint: { txHash: new Uint8Array(32).fill(1), index: 0 } }], outputs: [{ lock: { type: 'PK', hash: me.pkHash }, spend: { asset: ZEN_ASSET, amount } }] });
  const f = fixture({ contractAdds: back });
  const out = await prepareCancel({ w: f.w, state: f.state, node: f.node, swapContractId: SWAP, id: 'o-test', amount });
  const tx = deserializeTx(unhex(out.hex));
  assert.equal(tx.inputs.length, 2); assert.equal(tx.witnesses.length, 2);   // one wallet input pays the fee
  assert.ok(verifyDigest(tx.witnesses[1].signature.signature, senderMsg(tx, tx.witnesses[1]), f.k.publicKey));
  const g = fixture({ contractAdds: () => ({ inputs: [], outputs: [{ lock: { type: 'PK', hash: new Uint8Array(32).fill(9) }, spend: { asset: ZEN_ASSET, amount } }] }) });
  await assert.rejects(prepareCancel({ w: g.w, state: g.state, node: g.node, swapContractId: SWAP, id: 'o-test', amount }), /not signed/);
});

test('a price per ZP becomes the total in satoshis', async () => {
  const { totalFromPerZp } = await import('../src/swap.js');
  const zp80k = 80000n * 100000000n;
  assert.equal(totalFromPerZp('1250', zp80k, 'sat'), 100000000n);            // 80,000 ZP at 1,250 sat = 1 BTC
  assert.equal(totalFromPerZp('1', zp80k, 'usd', 80000), 100000000n);         // $1 per ZP with BTC at $80,000 = 1 BTC
  assert.equal(totalFromPerZp('$1.25', zp80k, 'usd', 100000), 100000000n);
  assert.equal(totalFromPerZp('0.5', 2000n * 100000000n, 'sat'), 1000n);
  assert.throws(() => totalFromPerZp('1', zp80k, 'usd', null), /No Bitcoin price/);
  assert.throws(() => totalFromPerZp('1', 100n, 'sat'), /at least/);
  assert.throws(() => totalFromPerZp('1,25', zp80k, 'usd', 1), /Enter the price/);
});

test('an offer can be funded by mining rewards once they are mature (as the balance counts them); immature ones are not used', async () => {
  const amount = 400000000n, f = fixture({ contractAdds: offerAdds(amount) });
  // only coinbase outputs: one mature (block 2000 at tip 2100), one immature (block 2095; testnet maturity 10)
  f.state.utxos = [{ outpoint: { txHash: new Uint8Array(32).fill(9), index: 0 }, lock: { type: 'Coinbase', blockNumber: 2000, pkHash: f.k.pkHash }, spend: { asset: '00', amount: 5n * 100000000n } },
                   { outpoint: { txHash: new Uint8Array(32).fill(10), index: 0 }, lock: { type: 'Coinbase', blockNumber: 2095, pkHash: f.k.pkHash }, spend: { asset: '00', amount: 50n * 100000000n } }];
  const out = await prepareOffer({ w: f.w, state: f.state, node: f.node, swapContractId: SWAP, id: 'o-cb', amount, sats: 50000n, scripts });
  const tx = deserializeTx(unhex(out.hex));
  assert.equal(hex(tx.inputs[0].outpoint.txHash), '09'.repeat(32)); assert.equal(tx.inputs.length, 2);   // the mature reward and the swap's mint
  assert.ok(verifyDigest(tx.witnesses[0].signature, sha3_256(Uint8Array.from([...txHash(tx), ...witnessesHash([tx.witnesses[1]])])), f.k.publicKey));
  await assert.rejects(prepareOffer({ w: f.w, state: f.state, node: f.node, swapContractId: SWAP, id: 'o-cb2', amount: 6n * 100000000n, sats: 50000n, scripts }), /Not enough spendable ZP/);
});

test('Bitcoin addresses must be new: used here before, used in the market, or already funded on Bitcoin', async () => {
  const a1 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', a2 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const s1 = btcScript(a1), s2 = btcScript(a2);
  assert.match((await checkFresh([s1], [a1], { known: [s1], fetchFn: async () => { throw new Error('not asked'); } })).bad[0], /earlier offer/);
  assert.match((await checkFresh([s1], [a1], { market: [s1] })).bad[0], /in the market/);
  const chain = { [a1]: { chain_stats: { funded_txo_count: 0 }, mempool_stats: { funded_txo_count: 0 } }, [a2]: { chain_stats: { funded_txo_count: 3 }, mempool_stats: { funded_txo_count: 0 } } };
  const f = async url => new Response(JSON.stringify(chain[decodeURIComponent(url.split('/').pop())]));
  const r = await checkFresh([s1, s2], [a1, a2], { fetchFn: f });
  assert.deepEqual(r, { bad: [`${a2} already received bitcoin`], checked: true });
  assert.deepEqual(await checkFresh([s1], [a1], { fetchFn: async () => { throw new Error('offline'); } }), { bad: [], checked: false });
});

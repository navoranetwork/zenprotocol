// Why does the explorer not list Dex Makes and Cancels while they are in the mempool? Waits (up to 10 minutes) for a
// Dex call in the node's mempool, then shows what site/dex-fresh.mjs makes of it, step by step.
// usage (in the explorer container, which has ZEN_DEX):
//   docker compose … exec -T explorer node /r/scripts/v1/dex-mempool-probe.mjs [node api] [net]
import { rowsOfMempool } from '../../site/dex-fresh.mjs';
import { encodeAddress } from '../../wallet/src/keys.js';

const API = process.argv[2] || 'http://127.0.0.1:31567', NET = process.argv[3] || 'test';
const DEX = process.env.ZEN_DEX || '';
console.log('ZEN_DEX', DEX || '(not set)', DEX ? encodeAddress(Uint8Array.from(Buffer.from(DEX, 'hex')), NET, true) : '');
for (let i = 0; i < 120; i++) {
  const list = await (await fetch(API + '/blockchain/mempool')).json();
  for (const entry of list) for (const [hash, tx] of Object.entries(entry)) {
    const cws = (tx.witness || []).map(w => w.ContractWitness).filter(Boolean);
    const cw = cws.find(c => ['Make', 'Cancel', 'Take'].includes(c.command) && c.contractId?.slice(0, 16) === (DEX || '00000001fd5aa884').slice(0, 16));
    if (!cw) continue;
    console.log('tx', hash, cw.command, 'contractId', cw.contractId, cw.contractId === DEX ? '(= ZEN_DEX)' : '(NOT ZEN_DEX)', 'messageBodyRaw', cw.messageBodyRaw ? cw.messageBodyRaw.length + ' hex' : 'missing');
    for (const o of tx.outputs || []) console.log('  out', JSON.stringify(o).slice(0, 220));
    const rows = rowsOfMempool([{ [hash]: tx }], DEX, NET);
    console.log('rows', JSON.stringify(rows, null, 1).slice(0, 1500));
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 5000));
}
console.log('no Dex call seen in the mempool for 10 minutes');

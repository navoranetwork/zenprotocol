// Contracts made by the contract engine (zp-contracts-v1 tools/engine/server.py, docs/SERVICE.md), served on the
// community site under /engine/. The engine makes, checks and tries contracts; it never signs. The wallet:
// - computes the contract id from the source itself and refuses to sign when it differs from the engine's report,
// - builds and signs the activation with the user's key (wallet.js prepareActivateV1).
import { sha3_256 } from '@noble/hashes/sha3.js';
import { hex } from './serialize.js';

export const MAX_V1_SOURCE = 65536;   // TransactionValidation.fs maxV1SourceBytes
const enc = new TextEncoder();

// the source as the activation carries it: canonical UTF-8 (ContractV1.decodeSource), at most 65,536 bytes
export function v1SourceBytes(source) {
  if (typeof source !== 'string' || !source) throw new Error('The contract has no source');
  const bytes = enc.encode(source);
  if (bytes.length > MAX_V1_SOURCE) throw new Error(`The contract is ${bytes.length.toLocaleString('en-US')} bytes; at most ${MAX_V1_SOURCE.toLocaleString('en-US')}`);
  let back; try { back = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { back = null; }
  if (back !== source) throw new Error('The contract text has characters that are not valid UTF-8');
  return bytes;
}
// Contract.fs makeContractId: SHA3-256(BE32 version || UTF-8 source); the full id is the version (8 hex) + the hash
export function v1ContractId(source) {
  const b = v1SourceBytes(source), m = new Uint8Array(4 + b.length);
  m.set([0, 0, 0, 1]); m.set(b, 4);
  return '00000001' + hex(sha3_256(m));
}
// TransactionValidation.fs getSacrificeBlocks: kalapas per block = String.length of the source (UTF-16 units, as in JS)
export const activationCost = (source, blocks) => BigInt(source.length) * BigInt(blocks);

// form values for a family's parameters (the engine checks every value again)
export function checkParam(name, p, raw) {
  const v = String(raw ?? '').trim();
  if (!v) { if (p.default !== undefined) return null; throw new Error(`${name}: required`); }
  if (/[\r\n]/.test(v)) throw new Error(`${name}: one line only`);
  const num = () => { if (!/^\d+$/.test(v)) throw new Error(`${name}: a whole number`); const n = BigInt(v);
    if (p.min != null && n < BigInt(p.min)) throw new Error(`${name}: at least ${p.min}`);
    if (p.max != null && n > BigInt(p.max)) throw new Error(`${name}: at most ${p.max}`);
    if (p.type === 'u32' && n > 4294967295n) throw new Error(`${name}: too large`);
    if (n > 18446744073709551615n) throw new Error(`${name}: too large`); return v; };
  switch (p.type) {
    case 'hash': if (!/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${name}: 64 hex characters`); return v.toLowerCase();
    case 'publickey': if (!/^0[23][0-9a-f]{64}$/i.test(v)) throw new Error(`${name}: a public key, 66 hex characters starting 02 or 03`); return v.toLowerCase();
    case 'u32': case 'u64': return num();
    case 'amount': if (!/^\d+$/.test(v) && !/^\d+(\.\d{1,8})?\s*zp$/i.test(v)) throw new Error(`${name}: kalapas, or an amount like 2.5 ZP`); return v;
    case 'asset': if (!/^(zp|[0-9a-f]{64}(:[0-9a-f]{1,64})?)$/i.test(v)) throw new Error(`${name}: zp, or a contract hash (64 hex), optionally :subtype`); return v.toLowerCase();
    case 'string': if (!/^[\x20-\x7e]*$/.test(v) || /["\\]/.test(v)) throw new Error(`${name}: plain letters, digits and punctuation, no quotes or backslashes`);
      if (v.length > (p.max ?? 64)) throw new Error(`${name}: at most ${p.max ?? 64} characters`); return v;
    case 'options': { const xs = v.split(',').map(x => x.trim()).filter(Boolean);
      if (p.min_count != null && xs.length < p.min_count) throw new Error(`${name}: at least ${p.min_count}`);
      if (p.max_count != null && xs.length > p.max_count) throw new Error(`${name}: at most ${p.max_count}`);
      return xs.join(','); }
    default: return v;
  }
}

export class EngineClient {
  constructor(base, fetchFn) { this.base = base.replace(/\/+$/, '') + '/engine'; this.fetch = fetchFn || ((...a) => globalThis.fetch(...a)); }
  async req(path, body) {
    let r;
    try { r = await this.fetch(this.base + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new Error('The contract engine is not answering'); }
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || (r.status === 429 ? 'The daily limit for described contracts is reached: try again tomorrow' : r.status === 503 ? 'The contract engine is busy: try again in a few minutes' : `The contract engine answered ${r.status}`));
    return j;
  }
  families() { return this.req('/families'); }
  make(family, params) { return this.req('/make', { family, params }); }
  ask(text) { return this.req('/ask', { text }); }
  check(source) { return this.req('/check', { source }); }
  job(id) { if (!/^[0-9a-f]{8,64}$/.test(id)) throw new Error('bad job id'); return this.req('/job/' + id); }
  // poll a job until it ends; onStep(job) after every answer; stop() from the caller ends the wait
  async wait(id, onStep, { everyMs = 1500, maxMs = 16 * 60000, stopped = () => false } = {}) {
    const end = Date.now() + maxMs;
    for (;;) {
      const j = await this.job(id); onStep?.(j);
      if (['done', 'failed', 'timeout'].includes(j.status)) return j;
      if (stopped()) return null;
      if (Date.now() > end) throw new Error('The contract engine did not finish in time');
      await new Promise(r => setTimeout(r, everyMs));
    }
  }
}

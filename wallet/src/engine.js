// Contracts made by the contract engine (zp-contracts-v1 tools/engine/server.py, docs/SERVICE.md), served on the
// community site under /engine/. The engine makes, checks and tries contracts; it never signs. The wallet:
// - computes the contract id from the source itself and refuses to sign when it differs from the engine's report,
// - builds and signs the activation with the user's key (wallet.js prepareActivateV1).
import { sha3_256 } from '@noble/hashes/sha3.js';
import { hex, unhex, Writer, Data } from './serialize.js';

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

// ---------------------------------------------------------------- trying a call (POST /engine/try)
// "2.5 ZP" or "250000000" (kalapas) -> kalapas as a decimal string
export function kalapasOf(text, what = 'Amount') {
  const v = String(text ?? '').trim();
  if (/^\d+$/.test(v)) { if (BigInt(v) > 18446744073709551615n) throw new Error(`${what}: too large`); return BigInt(v).toString(); }
  const m = v.match(/^(\d+)(?:\.(\d{1,8}))?\s*zp$/i);
  if (!m) throw new Error(`${what}: kalapas, or an amount like 2.5 ZP`);
  const k = BigInt(m[1]) * 100_000_000n + BigInt((m[2] || '').padEnd(8, '0'));
  if (k > 18446744073709551615n) throw new Error(`${what}: too large`);
  return k.toString();
}
const isZp = a => a === 'zp' || a === '00' || (a && typeof a === 'object' && /^0*$/.test(String(a.contract?.hash ?? a.contract ?? '')) && /^0*$/.test(String(a.subtype ?? '')));
// an asset as the engine writes it -> a short label
export function assetLabel(a) {
  if (isZp(a)) return 'ZP';
  if (a === 'self') return 'its token';
  const s = typeof a === 'string' ? a : String(a?.contract?.hash ?? a?.contract ?? '') + (a?.subtype && !/^0*$/.test(a.subtype) ? ':' + a.subtype : '');
  return 'token ' + s.slice(0, 8) + '…';
}
// kalapas (decimal string, maybe negative) -> "2.5 ZP"; other assets in whole units
export function formatAmount(amount, asset) {
  let n = BigInt(String(amount)); const neg = n < 0n; if (neg) n = -n;
  if (!isZp(asset)) return (neg ? '-' : '') + n.toLocaleString('en-US') + ' ' + assetLabel(asset);
  const whole = n / 100_000_000n, frac = (n % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toLocaleString('en-US') + (frac ? '.' + frac : '') + ' ZP';
}

// a family's commands (GET /engine/families "commands"), as a list the form can use
export function commandsOf(family) {
  const c = family?.commands; if (!c || typeof c !== 'object') return [];
  const list = Array.isArray(c) ? c : Object.entries(c).map(([name, x]) => ({ name, ...x }));
  return list.filter(x => x && typeof x.name === 'string' && /^[\w-]{1,64}$/.test(x.name)).map(x => {
    const body = Array.isArray(x.body) ? x.body.filter(f => f && typeof f.name === 'string').map(f => [f.name, f])
      : x.body && typeof x.body === 'object' ? Object.entries(x.body).map(([n, f]) => [n, typeof f === 'string' ? { type: f } : f || {}]) : [];
    const signedBy = Array.isArray(x.signedBy) ? x.signedBy.map(String) : typeof x.signedBy === 'string' ? [x.signedBy] : [];
    return { name: x.name, description: typeof x.description === 'string' ? x.description : '', sends: x.sends, signedBy, body };
  });
}
// the message body from form values -> bodyHex (the serialized Data, a Dict in key order), or null for no body
export function bodyHexOf(fields, values) {
  if (!fields.length) return null;
  const entries = fields.map(([name, f]) => {
    const raw = String(values[name] ?? '').trim();
    if (!raw) { if (f.optional) return null; throw new Error(`${name}: required`); }
    const t = String(f.type || '').toLowerCase();
    switch (t) {
      case 'u64': case 'amount': return [name, { t: 'U64', v: BigInt(kalapasOf(raw, name)) }];
      case 'u32': { if (!/^\d+$/.test(raw) || BigInt(raw) > 4294967295n) throw new Error(`${name}: a whole number`); return [name, { t: 'U32', v: Number(raw) }]; }
      case 'i64': { if (!/^-?\d+$/.test(raw)) throw new Error(`${name}: a whole number`); return [name, { t: 'I64', v: BigInt(raw) }]; }
      case 'string': if (!/^[\x20-\x7e]*$/.test(raw)) throw new Error(`${name}: plain text`); return [name, { t: 'String', v: raw }];
      case 'hash': if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error(`${name}: 64 hex characters`); return [name, { t: 'Hash', v: unhex(raw.toLowerCase()) }];
      case 'publickey': if (!/^0[23][0-9a-f]{64}$/i.test(raw)) throw new Error(`${name}: a public key, 66 hex characters`); return [name, { t: 'PublicKey', v: unhex(raw.toLowerCase()) }];
      case 'lock': case 'address': if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error(`${name}: a public key hash, 64 hex characters`); return [name, { t: 'Lock', v: { type: 'PK', hash: unhex(raw.toLowerCase()) } }];
      default: throw new Error(`${name}: the wallet cannot fill a "${t}" yet`);
    }
  }).filter(Boolean);
  const w = new Writer(); Data.write(w, { t: 'Dict', v: entries }); return hex(w.out());
}
// what the contract holds, by asset, from a try's next.wallet
export function holdings(wallet) {
  const m = new Map();
  for (const c of Array.isArray(wallet) ? wallet : []) { const k = JSON.stringify(c.asset); m.set(k, { asset: c.asset, amount: (m.get(k)?.amount ?? 0n) + BigInt(String(c.amount)) }); }
  return [...m.values()];
}

export class EngineClient {
  constructor(base, fetchFn) { this.base = base.replace(/\/+$/, '') + '/engine'; this.fetch = fetchFn || ((...a) => globalThis.fetch(...a)); }
  async req(path, body) {
    let r;
    try { r = await this.fetch(this.base + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new Error('The contract engine is not answering'); }
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(j?.error || (r.status === 429 ? 'The daily limit for described contracts is reached: try again tomorrow' : r.status === 503 ? 'The contract engine is busy: try again in a few minutes' : `The contract engine answered ${r.status}`)); e.status = r.status; throw e; }
    return j;
  }
  families() { return this.req('/families'); }
  health() { return this.req('/health'); }
  make(family, params) { return this.req('/make', { family, params }); }
  ask(text) { return this.req('/ask', { text }); }
  check(source) { return this.req('/check', { source }); }
  // one call, as a node would run it. With sourceId (a contract the engine made, checked or tried today) the source is
  // not sent again; the engine answers 404 when it no longer has it, and the call is sent with the source.
  async try({ source, sourceId, call, roles }) {
    const body = { call, ...(roles && Object.keys(roles).length ? { roles } : {}) };
    if (sourceId) { try { return await this.req('/try', { sourceId, ...body }); } catch (e) { if (e.status !== 404 || !source) throw e; } }
    return this.req('/try', { source, ...body });
  }
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

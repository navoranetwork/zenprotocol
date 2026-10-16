// The CGP interval as a timeline, and the tally so far from the site's cgp-history.json (site/chain-index.mjs).
// The rules are the node's (src/Blockchain/Tally_Voting.fs, Tally_Nomination.fs):
// - allocation: the weighted median of the valid votes (allocationRange), weight = the voter's ZP at the snapshot;
// - payout: the candidate with the most weight wins, a tie pays nobody;
// - a nomination becomes a candidate with at least 3% of the ZP issued at the snapshot behind it.
// Only the first ballot of a key per phase counts; the index marks it `counted`.
import { phasesOf, snapshotBlock } from './cgp.js';

const K = 100000000n;
const kal = zp => BigInt(Math.round(Number(zp) * 1e8));

// the four parts of interval i: before the snapshot, nominations, voting; `at` is the next block (tip + 1)
export function timeline(p, i, at) {
  const start = (i - 1) * p.intervalLength + 1, snap = snapshotBlock(p, i), n1 = snap + phasesOf(p, i).nomination, end = i * p.intervalLength;
  const parts = [
    { key: 'before', label: 'Before snapshot', short: 'Snapshot', from: start, to: snap },
    { key: 'Nomination', label: 'Nominations', short: 'Nominate', from: snap + 1, to: n1 },
    { key: 'Vote', label: 'Voting', short: 'Vote', from: n1 + 1, to: end },
  ];
  for (const x of parts) { x.blocks = x.to - x.from + 1; x.state = at > x.to ? 'done' : at >= x.from ? 'now' : 'next'; x.left = Math.max(0, x.to - at + 1); }
  return { start, end, snapshot: snap, parts, done: Math.min(1, Math.max(0, (at - start) / (end - start + 1))) };
}

// Tally_Voting.fs weightedMedian: sort by value; the values where neither side holds more than half; their weighted mean
export function weightedMedian(votes) {
  const v = [...votes].filter(([, w]) => w > 0n).sort((a, b) => a[0] - b[0]);
  if (!v.length) return null;
  const total = v.reduce((s, [, w]) => s + w, 0n);
  let before = 0n; const ok = [];
  for (const [x, w] of v) { const after = total - before - w; if (2n * before <= total && 2n * after <= total) ok.push([x, w]); before += w; }
  const [l, wl] = ok[0], [h, wh] = ok[ok.length - 1];
  return l === h ? l : Number((BigInt(l) * wl + BigInt(h) * wh) / (wl + wh));
}

export const proposalKey = (recipient, spends) => recipient + '|' + spends.map(([a, n]) => a + ':' + n).sort().join(',');

// the interval's row of cgp-history.json -> what each vote adds up to so far
export function tallyInterval(row, { range = null, threshold = null } = {}) {
  const votes = (row?.votes || []).filter(v => v && v.counted);
  const weightsKnown = votes.every(v => v.weight != null);
  const voters = new Set(votes.map(v => v.voter)).size;
  // allocation
  const alloc = new Map();
  for (const v of votes) if (v.command === 'Allocation' && Number.isInteger(v.ballot?.allocation)) {
    const pct = v.ballot.allocation;
    if (range && (pct < range.min || pct > range.max)) continue;   // the tally ignores values outside the range
    const a = alloc.get(pct) || { pct, weight: 0n, voters: 0 }; a.weight += kal(v.weight || 0); a.voters++; alloc.set(pct, a);
  }
  const allocRows = [...alloc.values()].sort((a, b) => a.pct - b.pct), allocTotal = allocRows.reduce((s, a) => s + a.weight, 0n);
  // proposals: nominations and payout votes for the same recipient and amounts are one proposal
  const props = new Map();
  const prop = b => { const k = proposalKey(b.recipient, b.spends); if (!props.has(k)) props.set(k, { key: k, recipient: b.recipient, spends: b.spends, nominated: 0n, nominators: 0, votes: 0n, voters: 0 }); return props.get(k); };
  for (const v of votes) {
    if (!v.ballot?.recipient || !Array.isArray(v.ballot.spends)) continue;
    const p = prop(v.ballot), w = kal(v.weight || 0);
    if (v.command === 'Nomination') { p.nominated += w; p.nominators++; }
    if (v.command === 'Payout') { p.votes += w; p.voters++; }
  }
  const list = [...props.values()].map(p => ({ ...p, candidate: threshold == null ? null : p.nominated >= threshold }));
  const payTotal = list.reduce((s, p) => s + p.votes, 0n);
  const top = [...list].sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : 0));
  const leader = top.length && top[0].votes > 0n ? (top[1] && top[1].votes === top[0].votes ? { tie: true } : { key: top[0].key }) : null;
  return {
    voters, weightsKnown,
    allocation: { rows: allocRows, total: allocTotal, result: weightedMedian(allocRows.map(a => [a.pct, a.weight])) },
    proposals: list.sort((a, b) => (b.votes - a.votes > 0n ? 1 : b.votes < a.votes ? -1 : b.nominated > a.nominated ? 1 : -1)),
    payTotal, leader,
  };
}
export const zpOfKal = k => Number(k) / 1e8;
export const share = (part, total) => total > 0n ? Number(part * 1000n / total) / 10 : 0;
export const thresholdOf = issuedZp => issuedZp == null ? null : BigInt(Math.round(Number(issuedZp) * 1e8)) * 3n / 100n;
export { K };

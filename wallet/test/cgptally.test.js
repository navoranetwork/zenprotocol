// The CGP timeline and the tally so far: the node's weighted median, the unique leader, the 3% nomination threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline, weightedMedian, tallyInterval, thresholdOf, share } from '../src/cgptally.js';
import { CGP_PARAMS } from '../src/cgp.js';

const Z = n => BigInt(n) * 100000000n;

test('timeline: the parts of a testnet interval (from 22: snapshot 70, nominations 71-80, voting 81-100)', () => {
  const t = timeline(CGP_PARAMS.test, 30, 2931);
  assert.deepEqual(t.parts.map(x => [x.key, x.from, x.to, x.state]), [['before', 2901, 2970, 'now'], ['Nomination', 2971, 2980, 'next'], ['Vote', 2981, 3000, 'next']]);
  assert.equal(t.parts[0].left, 40); assert.equal(t.snapshot, 2970);
  assert.equal(timeline(CGP_PARAMS.test, 30, 2975).parts[1].state, 'now');
  const m = timeline(CGP_PARAMS.main, 106, 1059001);
  assert.deepEqual(m.parts.map(x => [x.from, x.to]), [[1050001, 1059000], [1059001, 1059500], [1059501, 1060000]]);
});

test('weighted median as Tally_Voting.fs: one middle value, or the weighted mean of the two', () => {
  assert.equal(weightedMedian([[10, Z(5)], [12, Z(1)], [15, Z(1)]]), 10);
  assert.equal(weightedMedian([[10, Z(1)], [20, Z(1)]]), 15);          // half and half: the mean
  assert.equal(weightedMedian([[10, Z(1)], [20, Z(3)]]), 20);
  assert.equal(weightedMedian([]), null);
});

test('tally of an interval: counted votes only, the range, proposals, the leader and a tie', () => {
  const R = 'tzn1qrecipient', S = [['00', '100000000000']];
  const row = { votes: [
    { command: 'Allocation', voter: 'a', counted: true, weight: 500, ballot: { allocation: 10 } },
    { command: 'Allocation', voter: 'b', counted: true, weight: 100, ballot: { allocation: 12 } },
    { command: 'Allocation', voter: 'c', counted: true, weight: 900, ballot: { allocation: 50 } },   // outside the range: ignored
    { command: 'Allocation', voter: 'a', counted: false, weight: 500, ballot: { allocation: 12 } },  // a second ballot of a key
    { command: 'Nomination', voter: 'a', counted: true, weight: 500, ballot: { recipient: R, spends: S } },
    { command: 'Payout', voter: 'b', counted: true, weight: 100, ballot: { recipient: R, spends: S } },
    { command: 'Payout', voter: 'd', counted: true, weight: 40, ballot: { recipient: 'tzn1qother', spends: S } },
  ] };
  const t = tallyInterval(row, { range: { min: 0, max: 25 }, threshold: thresholdOf(10000) });
  assert.deepEqual(t.allocation.rows.map(r => [r.pct, Number(r.weight / 100000000n)]), [[10, 500], [12, 100]]);
  assert.equal(t.allocation.result, 10); assert.equal(share(t.allocation.rows[0].weight, t.allocation.total), 83.3);
  assert.equal(t.voters, 4);
  assert.equal(t.proposals[0].recipient, R); assert.equal(t.proposals[0].candidate, true);   // 500 ZP >= 3% of 10,000
  assert.equal(t.proposals[1].candidate, false);
  assert.equal(t.leader.key, t.proposals[0].key);
  const tie = tallyInterval({ votes: [...row.votes, { command: 'Payout', voter: 'e', counted: true, weight: 60, ballot: { recipient: 'tzn1qother', spends: S } }] });
  assert.deepEqual(tie.leader, { tie: true });
  assert.equal(tallyInterval({ votes: [{ command: 'Allocation', voter: 'x', counted: true, weight: null, ballot: { allocation: 5 } }] }).weightsKnown, false);
});

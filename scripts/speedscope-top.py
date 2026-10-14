#!/usr/bin/env python3
"""Top frames of a dotnet-trace speedscope file (cpu-sampling): per thread the sample count, then the frames with
the most inclusive and self samples overall and on the busiest threads. Thread-pool idle waits are dropped.
  python3 scripts/speedscope-top.py trace.speedscope.json [top N]"""
import json, sys, collections
d = json.load(open(sys.argv[1])); N = int(sys.argv[2]) if len(sys.argv) > 2 else 30
frames = [f['name'] for f in d['shared']['frames']]
IDLE = ('WaitHandle', 'Monitor.Wait', 'Thread.Sleep', 'SemaphoreSlim.Wait', 'LowLevelLifoSemaphore', 'WaitOne',
        'PortableThreadPool', 'Socket.Poll', 'epoll', 'ManualResetEventSlim.Wait', 'NetMQ.Core', 'Poller')
incl, selfc, per_thread = collections.Counter(), collections.Counter(), collections.Counter()
thread_incl = collections.defaultdict(collections.Counter)
total = 0
for p in d['profiles']:
    name = p.get('name', '?')
    for stack, w in zip(p.get('samples', []), p.get('weights', [])):
        if not stack: continue
        leaf = frames[stack[-1]]
        if any(k in leaf for k in IDLE): continue
        total += w; per_thread[name] += w
        selfc[leaf] += w
        for f in set(frames[i] for i in stack):
            incl[f] += w; thread_incl[name][f] += w
print(f'busy samples (weight): {total:,.0f}')
print('\nthreads by busy samples:')
for t, w in per_thread.most_common(8): print(f'  {100 * w / total:5.1f}%  {t}')
def short(f): return f if len(f) < 140 else f[:137] + '...'
print(f'\ntop {N} frames by SELF time:')
for f, w in selfc.most_common(N): print(f'  {100 * w / total:5.1f}%  {short(f)}')
print(f'\ntop {N} ZP frames by INCLUSIVE time (Consensus/Blockchain/Api/Wallet/Miner/Infrastructure/AddressDB):')
zp = [(f, w) for f, w in incl.most_common() if any(f.startswith(k) or ('!' + k) in f for k in
      ('Consensus', 'Blockchain', 'Api', 'Wallet', 'Miner', 'Infrastructure', 'AddressDB', 'Network', 'DataAccess'))]
for f, w in zp[:N]: print(f'  {100 * w / total:5.1f}%  {short(f)}')
for t, _ in per_thread.most_common(2):
    print(f'\nthread {t}: top inclusive ZP frames')
    tz = [(f, w) for f, w in thread_incl[t].most_common() if any(k in f for k in ('Consensus', 'Blockchain', 'Wallet', 'Miner', 'AddressDB', 'DataAccess'))]
    for f, w in tz[:15]: print(f'  {100 * w / per_thread[t]:5.1f}%  {short(f)}')

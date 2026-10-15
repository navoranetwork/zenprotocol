#!/usr/bin/env python3
"""Per-rate report of a lab-throughput.sh run: for each node (A, B) and each total rate, the median and the range
(min-max) over the runs of that rate. Each step's first minute is warm-up and is left out.
Per step: achieved transfers/min (both senders, accepted), publish latency median/p95 (ms, pooled over both senders),
seconds per block on the chain (new tips), blocks mined on a stale template (log: "added to a fork chain"), mempool
average, node CPU % (median of docker stats, of 400) and RAM (max MiB).
  python3 scripts/throughput-report.py <run folder>"""
import csv, gzip, json, os, re, statistics, sys
from datetime import datetime, timedelta

WARMUP = 60
run = sys.argv[1]

def secs(hms):
    h, m, s = map(int, hms.split(':')); return h * 3600 + m * 60 + s

def inwin(t, a, b):  # times of day in seconds; a window may cross midnight
    return a <= t <= b if a <= b else (t >= a or t <= b)

def pct(xs, p):
    if not xs: return None
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

def mib(s):
    m = re.match(r'([\d.]+)\s*([KMG]i?B)', s.strip())
    if not m: return None
    v, u = float(m.group(1)), m.group(2)
    return v * {'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024, 'kB': 1 / 1024, 'MB': 1, 'GB': 1024}.get(u, 1)

def node(K):
    D = os.path.join(run, K)
    if not os.path.isdir(D): return None
    sums = [json.load(open(os.path.join(D, f's{s}', 'summary.json'))) for s in (1, 2)
            if os.path.exists(os.path.join(D, f's{s}', 'summary.json'))]
    if not sums: return None
    steps = sums[0]['steps']
    loads = []
    for s in (1, 2):
        p = os.path.join(D, f's{s}', 'load.csv')
        if os.path.exists(p): loads += [r for r in csv.DictReader(open(p))]
    blocks = [r for r in csv.DictReader(open(os.path.join(D, 's1' if os.path.exists(os.path.join(D, 's1', 'blocks.csv')) else 's2', 'blocks.csv')))]
    stats = [r for r in csv.DictReader(open(os.path.join(D, 'stats.csv')))] if os.path.exists(os.path.join(D, 'stats.csv')) else []
    forks, tips = [], []
    lp = os.path.join(D, 'node0.log.gz')
    if os.path.exists(lp):
        for line in gzip.open(lp, 'rt', errors='replace'):
            m = re.match(r'\[(\d\d:\d\d:\d\d)', line)
            if not m: continue
            if 'added to a fork chain' in line: forks.append(secs(m.group(1)))
            elif 'BlockHandler: New tip' in line: tips.append(secs(m.group(1)))
    out = []
    for st in steps:
        a = datetime.fromisoformat(st['start'].replace('Z', '+00:00')) + timedelta(seconds=WARMUP)
        b = datetime.fromisoformat(st['end'].replace('Z', '+00:00'))
        span = (b - a).total_seconds()
        if span <= 30: continue
        A_, B_ = secs(a.strftime('%H:%M:%S')), secs(b.strftime('%H:%M:%S'))
        ok = [float(r['latency_ms']) for r in loads if r['ok'] == '1' and inwin(secs(r['time']), A_, B_)]
        heights = {r['block'] for r in blocks if inwin(secs(r['time']), A_, B_)}
        mem = [float(r['mempool']) for r in blocks if r['mempool'] and inwin(secs(r['time']), A_, B_)]
        cpu = [float(r['cpu_percent'].rstrip('%')) for r in stats if r['cpu_percent'] and inwin(secs(r['time']), A_, B_)]
        ram = [x for x in (mib(r['mem_usage'].split('/')[0]) for r in stats if inwin(secs(r['time']), A_, B_)) if x]
        ntips = sum(1 for t in tips if inwin(t, A_, B_)) or len(heights)
        out.append({'rate': st['rate_per_min'] * len(sums) if len(sums) == 2 else st['rate_per_min'] * 2,
                    'achieved': len(ok) / span * 60, 'pub_med': pct(ok, .5), 'pub_p95': pct(ok, .95),
                    's_per_block': span / ntips if ntips else None,
                    'stale': sum(1 for t in forks if inwin(t, A_, B_)),
                    'mempool': statistics.mean(mem) if mem else None,
                    'cpu': statistics.median(cpu) if cpu else None, 'ram': max(ram) if ram else None,
                    'senders': len(sums)})
    return out

def fmt(xs, nd=0):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    f = (lambda v: f'{v:,.{nd}f}')
    return f'{f(statistics.median(xs))} ({f(min(xs))}-{f(max(xs))})' if len(xs) > 1 else f(xs[0])

cols = [('achieved/min', 'achieved', 0), ('publish ms med', 'pub_med', 0), ('publish ms p95', 'pub_p95', 0),
        ('s/block', 's_per_block', 1), ('stale blocks', 'stale', 0), ('mempool avg', 'mempool', 0),
        ('CPU % (of 400)', 'cpu', 0), ('RAM MiB max', 'ram', 0)]
print(f'{run}: median (min-max) over the runs of each rate; first {WARMUP} s of each step not measured')
names = {'A': 'A = original (upstream a0191cbc)', 'B': 'B = ours'}
dirs = sorted((d for d in os.listdir(run) if os.path.isdir(os.path.join(run, d)) and (d in names or d.startswith('B-'))),
              key=lambda d: (d != 'A', d))
for K, name in ((d, names.get(d, f'{d} = ours, ZP_TEMPLATE_INTERVAL_MS={d[3:]}' if d.startswith('B-t') else d)) for d in dirs):
    steps = node(K)
    if not steps: print(f'\n{name}: no data'); continue
    print(f'\n{name}  (senders: {steps[0]["senders"]})')
    print('rate/min | ' + ' | '.join(c[0] for c in cols))
    for rate in sorted({s['rate'] for s in steps}):
        rs = [s for s in steps if s['rate'] == rate]
        print(f'{rate:>8} | ' + ' | '.join(fmt([s[k] for s in rs], nd) for _, k, nd in cols) + f'   [{len(rs)} runs]')

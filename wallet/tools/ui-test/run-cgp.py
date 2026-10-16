"""Browser test of the CGP screen's timeline, results so far and proposals (cgp-history.json from the site).
Setup as run.py (dist on :8081, mock-node.mjs on :8082)."""
import sys, os, urllib.request
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 900})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2984, alloc=10, zp=5000, reset=1, utxo=0, cgphist=1, snapzp=4000.5)      # next block 2985: voting (2981-3000) of interval 30
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=vote]'); pg.wait_for_timeout(800); pg.click('button[data-go=vote]'); pg.wait_for_selector('text=Results so far'); pg.wait_for_selector('text=Proposals', timeout=15000)
    t = pg.inner_text('main')
    ok(len(pg.query_selector_all('.timeline .tlseg')) == 3 and pg.query_selector('.tlseg.now .tllabel').inner_text() == '● Vote' and 'Voting: 16 blocks left' in t, 'timeline: three parts, voting now, 16 blocks left')
    ok('2,971–2,980' in t and '2,981–3,000' in t, 'timeline: the block ranges of nominations and voting')
    ok('3 wallets voted' in t and 'CGP 10%' in t and 'miners 90%' in t, 'results: 3 voters, the weighted median 10%')
    ok('55.5% · 500 ZP' in t and '33.3% · 300 ZP' in t, 'results: each value with its share of the weight')
    ok('Payout if voting ended now' in t and '1,000 ZP' in t, 'results: the leading payout')
    pg.wait_for_timeout(1500); t = pg.inner_text('main')
    ok('Vote weight: ZP at the snapshot (block 2,970)' in t and '4,000.50 ZP' in t and '5,000.00 ZP' not in t, 'after the snapshot: the weight is the balance at block 2,970 (4,000.50), not now (5,000), with two decimals')
    props = pg.query_selector_all('.prop')
    ok(len(props) == 2 and '✓ a candidate' in props[0].inner_text() and '● leading' in props[0].inner_text(), 'proposals: the 1,000 ZP request is a candidate and leads')
    ok('16.6% of the 3% needed' in props[1].inner_text() and props[1].query_selector('button') is None, 'proposals: the 50 ZP request is short of 3% (100 of 600 ZP) and cannot be voted for')
    ok('7.6% of the fund' in props[0].inner_text() or 'of the fund' in props[0].inner_text(), 'proposals: the share of the fund')
    pg.screenshot(path=f'{OUT}/cgp1.png', full_page=True)
    pg.click('button[data-act=load-cands]'); pg.wait_for_timeout(800)
    ok('No payout' in pg.inner_text('main') and 'The fund keeps its ZP' in pg.inner_text('main'), 'the node\'s default candidate (the fund paying itself 1 kalapa) is shown as No payout')
    pg.click('.prop button[data-act=prop-vote]'); pg.wait_for_selector('.modal', timeout=15000)
    ok('payout vote' in pg.inner_text('.modal').lower() or 'Pay 1,000 ZP' in pg.inner_text('.modal'), 'Vote for this opens the review of a payout vote for 1,000 ZP')
    pg.screenshot(path=f'{OUT}/cgp2-review.png')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

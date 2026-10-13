"""Browser test: the CGP vote screen opens the voting forms by itself when the voting phase starts (no navigation).
Setup as run.py (dist on :8081, mock-node.mjs on :8082)."""
import sys, urllib.request
from playwright.sync_api import sync_playwright
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 420, 'height': 900})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s', main:'%s'}}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=93, alloc=0, zp=5000, reset=1, utxo=0)       # next block 94: nominations (91-95)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=vote]'); pg.wait_for_timeout(800); pg.click('button[data-go=vote]'); pg.wait_for_selector('h1:has-text("CGP vote")'); pg.wait_for_timeout(800)
    ok(pg.query_selector('#alloc-go') is None, 'nominations: the split vote is closed')
    mock(tip=95)                                           # next block 96: voting
    pg.wait_for_selector('#alloc-go', timeout=30000)
    ok(pg.query_selector('#alloc-go') is not None, 'the split vote opened by itself when voting started')
    ok('Block 95' in pg.inner_text('.top'), 'the block number followed the chain')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

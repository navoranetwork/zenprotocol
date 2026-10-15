"""Browser test of buying ZP with bitcoin from the wallet (Markets -> ZP <-> BTC): reserve for this wallet's address,
the payment screen (amount, address, QR, time left), confirmations, the proof, done. Setup as run-swap.py."""
import sys, json, urllib.request, os
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def get(p): return json.load(urllib.request.urlopen(NODE + p))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}, mtab:'swap'}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=contracts]'); pg.wait_for_timeout(500)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('text=Buy ZP with bitcoin', timeout=15000)
    t = pg.inner_text('main'); ok('7 ZP' in t and pg.query_selector('button[data-act=buy][data-id=o-other]') is not None and pg.query_selector('button[data-act=buy][data-id=o-mine1]') is None, "others' offers can be bought, own offers not")
    pg.click('button[data-act=buy][data-id=o-other]'); pg.wait_for_selector('text=Buy 7 ZP')
    t = pg.inner_text('.sheet'); ok('0.00090000 BTC' in t and '1 h 20 min' in t and '32 min' in t, 'reserve sheet: the price, held 1 h 20 min, pay within 32 min')
    pg.click('button[data-act=buy-reserve]'); pg.wait_for_selector('text=Reserving', timeout=15000)
    addr = get('/__addr')['wallet']; ok(True, 'reserved for this wallet (' + addr[:12] + '…)')
    mock(buystage=1); pg.evaluate('document.dispatchEvent(new Event("visibilitychange"))'); pg.wait_for_selector("text=Pay 0.00090000 BTC", timeout=20000)
    t = pg.inner_text('main'); ok('bc1qmockseller' in t and 'Pay within' in t and pg.query_selector('.card.buy .qr svg') is not None and pg.query_selector('a[href^="bitcoin:bc1qmockseller"]') is not None, 'payment screen: amount, address, QR, time to pay, open in a Bitcoin wallet')
    pg.screenshot(path=f'{OUT}/b1-pay.png', full_page=True)
    mock(buystage=3); pg.wait_for_selector('text=Payment received', timeout=20000)
    ok('1 of 2' in pg.inner_text('main'), 'confirmations: 1 of 2')
    pg.screenshot(path=f'{OUT}/b2-confs.png', full_page=True)
    mock(buystage=5); pg.wait_for_selector('text=Releasing your ZP', timeout=20000)
    mock(buystage=9); pg.wait_for_selector('text=You received the ZP', timeout=20000); ok(True, 'proof sent, then the offer leaves: "You received the ZP"')
    pg.click('button[data-act=buy-done]'); pg.wait_for_timeout(300); ok('You received the ZP' not in pg.inner_text('main'), 'Done clears the purchase')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

"""Browser test of buying ZP with bitcoin from the wallet (Markets -> ZP <-> BTC): reserve for this wallet's address,
the payment screen (amount, address, QR, time left), confirmations, the proof, done. Setup as run-swap.py.
--pay: the wallet built with BTC_WALLET_PAY=1: "Pay with <Bitcoin wallet>" sends the exact amount to the exact address
through the wallet's own confirm (a fake WBIP004 provider here). Without it: no such button, the QR code only."""
import sys, json, urllib.request, os
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
PAY = '--pay' in sys.argv
SELLER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def get(p): return json.load(urllib.request.urlopen(NODE + p))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}, mtab:'swap'}))" % (NODE, NODE))
    ctx.add_init_script("""window.__sent = []; window.FakeBtc = { request: async (m, p) => m === 'getAddresses' ? { result: { addresses: [{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', purpose: 'payment' }] } } : m === 'sendTransfer' ? (window.__sent.push(p), { result: { txid: 'ab'.repeat(32) } }) : { error: { message: 'no' } } };
      window.btc_providers = [{ id: 'FakeBtc', name: 'Fake Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjZjkwIi8+PC9zdmc+' }];""")
    ctx.route('https://mempool.space/**', lambda r: r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps({'1': 12.2, '2': 9})))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=contracts]'); pg.wait_for_timeout(500)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('h2:has-text("Offers")', timeout=15000)
    ok('Real bitcoin, test ZP' in pg.inner_text('main') and pg.query_selector('[data-act=stab][data-v=buy].on') is not None, 'opens on Buy ZP, with the "real bitcoin, test ZP" banner')
    ok('about 30 min in all' in pg.inner_text('main'), 'each offer says how long the whole purchase takes')
    ok(pg.query_selector('.offer img.ticon[src^="data:image/svg+xml"]') is not None and pg.query_selector('[data-mtab=swap] img.ticon') is not None, 'the Bitcoin logo next to BTC amounts and on the ZP ⇄ BTC tab')
    pg.screenshot(path=f'{OUT}/b0-offers.png', full_page=True)
    t = pg.inner_text('main'); ok('7 ZP' in t and pg.query_selector('button[data-act=buy][data-id=o-other]') is not None and pg.query_selector('button[data-act=buy][data-id=o-mine1]') is None, "others' offers can be bought, own offers not")
    pg.click('button[data-act=buy][data-id=o-other]'); pg.wait_for_selector('text=Buy 7 ZP')
    t = pg.inner_text('.sheet'); ok('About 30 min in all' in t and '0.00090000 BTC' in t and '≈ $90' in t, 'reserve sheet: about 30 min in all first, the price in BTC and dollars')
    ok('up to 32 min to pay' in t and '1 h 20 min in all' in t and 'Large' not in t, 'the longest times only as a small line; no large-amount warning')
    ok(pg.inner_text('button[data-act=buy-reserve]') == ('Reserve and pay' if PAY else 'Reserve'), 'one click when a Bitcoin wallet can pay: "Reserve and pay"')
    pg.screenshot(path=f'{OUT}/b0b-reserve.png')
    pg.click('button[data-act=buy-reserve]'); pg.wait_for_selector('text=Reserving', timeout=15000)
    addr = get('/__addr')['wallet']; ok(True, 'reserved for this wallet (' + addr[:12] + '…)')
    mock(buystage=1); pg.evaluate('document.dispatchEvent(new Event("visibilitychange"))'); pg.wait_for_selector("text=Pay 0.00090000 BTC", timeout=20000)
    if PAY:
        pg.wait_for_selector('button[data-act=btc-pay-go]', timeout=5000); ok(True, 'once reserved, the Bitcoin wallet\'s pay screen opens by itself')
        pg.click('.sheet button[data-act=close]'); pg.wait_for_timeout(300)
    t = pg.inner_text('main'); ok(SELLER in t and 'Pay within' in t and pg.query_selector('.card.buy .qr svg') is not None and pg.query_selector(f'a[href="bitcoin:{SELLER}?amount=0.0009"]') is not None, 'payment screen: amount, address, QR, time to pay, a bitcoin: link')
    ok('at least 13 sat/vB' in t and 'may not be released' in t, 'the network fee to pay with: the next-block rate, and why')
    ok('Reserved for you' in t and 'Bitcoin confirmations 0 of 2' in t and 'ZP received' in t, 'the steps of the purchase, with their times')
    pg.screenshot(path=f'{OUT}/b1-pay.png', full_page=True)
    if PAY:
        pg.click('button[data-act=btc-pay]'); pg.wait_for_selector('button[data-act=btc-pay-go]')
        t = pg.inner_text('.sheet'); ok('Pay with Fake Wallet' in t and SELLER in t and '0.00090000 BTC' in t and 'Same address and amount as your reservation' in t, 'before the Bitcoin wallet opens: address and amount, and that they match the reservation')
        pg.screenshot(path=f'{OUT}/b1b-pay-with-wallet.png')
        pg.click('button[data-act=btc-pay-go]'); pg.wait_for_selector('text=Sent from Fake Wallet', timeout=10000)
        ok(pg.evaluate('window.__sent') == [{'recipients': [{'address': SELLER, 'amount': 90000}]}], 'the Bitcoin wallet was asked for exactly 90,000 sats to the reservation\'s address')
        ok(pg.query_selector('button[data-act=btc-pay]') is None, 'no second payment button after sending')
    else:
        ok(pg.query_selector('button[data-act=btc-pay], button[data-act=btcw-choose]') is None, 'paying from a connected wallet is off in this build: the QR code and link only')
    mock(buystage=3); pg.wait_for_selector('text=Payment received', timeout=20000)
    ok('1 of 2' in pg.inner_text('main'), 'confirmations: 1 of 2')
    pg.screenshot(path=f'{OUT}/b2-confs.png', full_page=True)
    mock(buystage=5); pg.wait_for_selector('text=Releasing your ZP', timeout=20000)
    mock(buystage=9); pg.wait_for_selector('text=You received the ZP', timeout=20000); ok(True, 'proof sent, then the offer leaves: "You received the ZP"')
    pg.click('button[data-act=buy-done]'); pg.wait_for_timeout(300); ok('You received the ZP' not in pg.inner_text('main'), 'Done clears the purchase')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

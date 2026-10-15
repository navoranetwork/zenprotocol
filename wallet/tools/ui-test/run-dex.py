"""Browser test of trading on the Dex from the Markets tab: Take (whole and part), Cancel of an own order, Make.
Setup as run-swap.py (dist on :8081, mock-node.mjs on :8082)."""
import sys, json, urllib.request, os, subprocess
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
ZU = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577'
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def get(p): return json.load(urllib.request.urlopen(NODE + p))
WALLET = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def witness(txhex):   # the contract witness of a published transaction: command and whether it is signed
    r = subprocess.run(['node', '-e', "import('./src/serialize.js').then(({deserializeTx, unhex}) => { const t = deserializeTx(unhex(process.argv[1])); const c = t.witnesses.find(w => w.type === 'Contract'); console.log(JSON.stringify({ command: c.command, signed: !!c.signature, pk: t.witnesses.filter(w => w.type === 'PK').map(w => w.sigHash) })) })", txhex], capture_output=True, text=True, cwd=WALLET)
    return json.loads(r.stdout or '{}')
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}, mtab:'dex'}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=200, utxo=0, reset=1, zusdc=1, dexmine=1, book=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('text=Tokens', timeout=15000)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('.book', timeout=15000)
    t = pg.inner_text('.book')
    asks = [e.inner_text().split('\n')[0] for e in pg.query_selector_all('.asks .lvl')]; bids = [e.inner_text().split('\n')[0] for e in pg.query_selector_all('.bids .lvl')]
    ok(asks == ['0.1500', '0.1040', '0.1015', '0.1010'] and bids == ['0.0990', '0.0985'], f'the book: asks high to low above, bids below, best prices in the middle ({asks} / {bids})')
    ok('Spread 0.0020 · 2.0%' in t and pg.inner_text('.midp') == '0.1010 ↑' and 'up' in pg.get_attribute('.midp', 'class'), 'the middle: the last trade price large (green, up), the spread beside it')
    ok('mine' in pg.get_attribute('.asks .lvl:nth-child(1)', 'class') and pg.query_selector('.asks .lvl:nth-child(1) .dot') is not None and pg.is_disabled('.asks .lvl:nth-child(1)'), 'the own order is marked with a dot and cannot be taken from the book')
    ok('pend' in pg.get_attribute('.asks .lvl:nth-child(2)', 'class') and pg.is_disabled('.asks .lvl:nth-child(2)'), 'a mempool order shows faded and cannot be taken')
    ok('Trades' in pg.inner_text('main') and pg.query_selector('.trade .bid') is not None, 'recent trades: a buy in green')
    ok(pg.query_selector('button[data-act=dex-cancel]') is not None, 'Your orders: Cancel')
    pg.screenshot(path=f'{OUT}/d1-orders.png', full_page=True)
    # take part of the bid: give 10 ZP, get 0.99 zUSDC; anonymous call
    pg.click('.bids .lvl[data-i="0"]'); pg.wait_for_selector('form[data-form=dex-take]')
    pg.fill('form[data-form=dex-take] input[name=give]', '10'); pg.wait_for_timeout(200)
    ok(pg.inner_text('#dex-get') == '0.99 zUSDC', 'take: the payout shows as you type (10 ZP -> 0.99 zUSDC)')
    pg.click('form[data-form=dex-take] button.primary'); pg.wait_for_selector('text=Confirm take', timeout=15000)
    t = pg.inner_text('.sheet'); ok('10 ZP' in t and '0.99 zUSDC' in t and 'Left in the order' in t and '8.91 zUSDC for 90 ZP' in t, 'confirm: give, get, and what is left of the order')
    pg.screenshot(path=f'{OUT}/d2-confirm.png')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your take is on its way', timeout=15000)
    w = witness(get('/__published')[-1]); L = get('/__lastdex')
    ok(L == {'command': 'Take', 'provided': '1000000000', 'payout': '990000', 'signed': False} and w.get('command') == 'Take' and w.get('signed') is False and w.get('pk', [])[-1] == 'FollowingWitnesses',
       'Take sent anonymous: 10 ZP for 990000 units, the last input signature covers the contract witness ' + json.dumps(w))
    pg.click('button[data-act=close]'); pg.wait_for_timeout(300)
    ok('busy' in pg.get_attribute('.bids .lvl[data-i="0"]', 'class') and pg.is_disabled('.bids .lvl[data-i="0"]'), 'the taken order is marked in the book until it leaves')
    # an order the book still shows but that is gone on the chain: refused before signing
    mock(goneLive='a2' * 32); pg.click('.asks .lvl[data-i="1"]'); pg.wait_for_selector('form[data-form=dex-take]')
    pg.fill('form[data-form=dex-take] input[name=give]', '1'); pg.click('form[data-form=dex-take] button.primary'); pg.wait_for_selector('.sheet .err', timeout=15000)
    ok('Someone took it first' in pg.inner_text('.sheet'), 'a stale row: "Someone took it first", nothing signed'); pg.click('.sheet button[data-act=close]'); pg.wait_for_timeout(300)
    # take the ask with zUSDC: more than the wallet has is refused, 1 zUSDC works
    pg.click('.asks .lvl[data-i="0"]'); pg.wait_for_selector('form[data-form=dex-take]')
    pg.click('button[data-act=dex-all]'); ok(pg.input_value('form[data-form=dex-take] input[name=give]') == '10.10', 'Whole order fills 10.10 zUSDC')
    pg.click('form[data-form=dex-take] button.primary'); pg.wait_for_selector('.sheet .err', timeout=15000)
    ok('Not enough of that token' in pg.inner_text('.sheet'), 'giving more zUSDC than the wallet holds is refused before anything is signed')
    pg.fill('form[data-form=dex-take] input[name=give]', '1'); pg.click('form[data-form=dex-take] button.primary'); pg.wait_for_selector('text=Confirm take', timeout=15000)
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your take is on its way', timeout=15000)
    ok(get('/__lastdex')['provided'] == '1000000', 'Take paid with 1 zUSDC (token inputs)'); pg.click('button[data-act=close]')
    # cancel the own order: signed
    pg.click('button[data-act=dex-cancel]'); pg.wait_for_selector('text=Cancel order', timeout=15000)
    ok('2 ZP' in pg.inner_text('.sheet'), 'cancel: 2 ZP back')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Order cancelled', timeout=15000)
    ok('2 ZP comes back to your balance with the next block' in pg.inner_text('.sheet'), 'cancel: "Order cancelled", and the 2 ZP come back with the next block')
    w = witness(get('/__published')[-1]); ok(get('/__lastdex') == {'command': 'Cancel', 'signed': True} and w.get('signed') is True, 'Cancel signed by the maker key'); pg.click('button[data-act=close]')
    # a limit order from the book's form: sell 5 ZP at 0.0980 crosses the best bid (0.0990): warned, still possible
    pg.click('button[data-act=dex-side][data-v=sell]'); pg.fill('form[data-form=dex-limit] input[name=price]', '0.098'); pg.fill('form[data-form=dex-limit] input[name=amount]', '5'); pg.wait_for_timeout(150)
    ok(pg.inner_text('#dex-total') == 'You get 0.49 zUSDC', 'the limit form shows what you get as you type (' + pg.inner_text('#dex-total') + ')')
    pg.screenshot(path=f'{OUT}/d3-limit.png', full_page=True)
    pg.click('form[data-form=dex-limit] button.primary'); pg.wait_for_selector('text=Confirm order', timeout=15000)
    t = pg.inner_text('.sheet'); ok('5 ZP' in t and '0.49 zUSDC' in t and 'Someone already buys at 0.0990' in t, 'confirm: 5 ZP for 0.49 zUSDC, with the crossing warning')
    pg.screenshot(path=f'{OUT}/d4-limit-confirm.png')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your order is on its way', timeout=15000)
    ok(get('/__lastdex') == {'command': 'Make', 'signed': True}, 'the limit order is a Make signed by the maker key'); pg.click('button[data-act=close]'); pg.wait_for_timeout(200)
    lv = [(e.inner_text(), e.get_attribute('class')) for e in pg.query_selector_all('.asks .lvl')]
    ok(any(x.startswith('0.0980') and 'mine' in c and 'pend' in c for x, c in lv) and pg.input_value('form[data-form=dex-limit] input[name=amount]') == '' and 'Waiting for its block' in pg.inner_text('main'), 'the sent order shows in the book at once (yours, faded until its block) and under Your orders; the form is cleared')
    pg.click('button[data-act=dex-side][data-v=buy]'); pg.fill('form[data-form=dex-limit] input[name=price]', '0.5'); pg.fill('form[data-form=dex-limit] input[name=amount]', '0.5')
    pg.click('form[data-form=dex-limit] button.primary'); pg.wait_for_timeout(400); ok('At least 1 ZP' in pg.inner_text('main'), 'less than 1 ZP is refused')
    # any pair: give 1 ZP for 0.5 zUSDC
    pg.click('details.how summary >> text=All orders and other pairs'); pg.wait_for_timeout(100)
    pg.click('form[data-form=dex-make] button[data-name=dgive][data-asset="00"]'); pg.wait_for_timeout(100)
    pg.fill('form[data-form=dex-make] input[name=give]', '1'); pg.fill('form[data-form=dex-make] input[name=want]', '0.5')
    pg.click('form[data-form=dex-make] button.primary'); pg.wait_for_selector('text=Confirm order', timeout=15000)
    ok('1 ZP' in pg.inner_text('.sheet') and '0.50 zUSDC' in pg.inner_text('.sheet'), 'make: give 1 ZP, want 0.50 zUSDC')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your order is on its way', timeout=15000)
    ok(get('/__lastdex') == {'command': 'Make', 'signed': True}, 'Make signed by the maker key')
    ok(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll at 390px')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

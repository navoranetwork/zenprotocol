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
    mock(tip=2100, zp=200, utxo=0, reset=1, zusdc=1, dexmine=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('text=Tokens', timeout=15000)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('text=Open orders')
    pg.click('button[data-mtab=dex]') if pg.query_selector('button[data-mtab=dex]') else None
    pg.wait_for_selector('button[data-act=dex-take]', timeout=15000)
    t = pg.inner_text('main')
    ok('Sells 9.90 zUSDC for 100 ZP' in t and 'Sells 100 ZP for 10.10 zUSDC' in t and 'Your order' in t and pg.query_selector('button[data-act=dex-cancel]') is not None,
       'order list: the bid, the ask, an own order with Cancel, the others with Take')
    pg.screenshot(path=f'{OUT}/d1-orders.png', full_page=True)
    # take part of the bid: give 10 ZP, get 0.99 zUSDC; anonymous call
    pg.click('button[data-act=dex-take][data-tx="%s"]' % ('b1' * 32)); pg.wait_for_selector('form[data-form=dex-take]')
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
    ok('Being taken' in pg.inner_text('main'), 'the taken order is marked until it leaves the list')
    # take the ask with zUSDC: more than the wallet has is refused, 1 zUSDC works
    pg.click('button[data-act=dex-take][data-tx="%s"]' % ('a1' * 32)); pg.wait_for_selector('form[data-form=dex-take]')
    pg.click('button[data-act=dex-all]'); ok(pg.input_value('form[data-form=dex-take] input[name=give]') == '10.10', 'Whole order fills 10.10 zUSDC')
    pg.click('form[data-form=dex-take] button.primary'); pg.wait_for_selector('.sheet .err', timeout=15000)
    ok('Not enough of that token' in pg.inner_text('.sheet'), 'giving more zUSDC than the wallet holds is refused before anything is signed')
    pg.fill('form[data-form=dex-take] input[name=give]', '1'); pg.click('form[data-form=dex-take] button.primary'); pg.wait_for_selector('text=Confirm take', timeout=15000)
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your take is on its way', timeout=15000)
    ok(get('/__lastdex')['provided'] == '1000000', 'Take paid with 1 zUSDC (token inputs)'); pg.click('button[data-act=close]')
    # cancel the own order: signed
    pg.click('button[data-act=dex-cancel]'); pg.wait_for_selector('text=Cancel order', timeout=15000)
    ok('2 ZP' in pg.inner_text('.sheet'), 'cancel: 2 ZP back')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=The cancel is on its way', timeout=15000)
    w = witness(get('/__published')[-1]); ok(get('/__lastdex') == {'command': 'Cancel', 'signed': True} and w.get('signed') is True, 'Cancel signed by the maker key'); pg.click('button[data-act=close]')
    # make: give 1 ZP for 0.5 zUSDC
    pg.click('form[data-form=dex-make] button[data-name=dgive][data-asset="00"]'); pg.wait_for_timeout(100)
    pg.fill('form[data-form=dex-make] input[name=give]', '1'); pg.fill('form[data-form=dex-make] input[name=want]', '0.5')
    pg.click('form[data-form=dex-make] button.primary'); pg.wait_for_selector('text=Confirm order', timeout=15000)
    ok('1 ZP' in pg.inner_text('.sheet') and '0.50 zUSDC' in pg.inner_text('.sheet'), 'make: give 1 ZP, want 0.50 zUSDC')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your order is on its way', timeout=15000)
    ok(get('/__lastdex') == {'command': 'Make', 'signed': True}, 'Make signed by the maker key')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

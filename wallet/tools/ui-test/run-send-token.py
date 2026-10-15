"""Browser test of sending a token (zUSDC, 6 decimals) from the Send screen, and of token rows in the activity.
Setup as run-swap.py (dist on :8081, mock-node.mjs on :8082)."""
import sys, json, urllib.request, os, subprocess
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
ZUSDC = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577'
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def get(p): return json.load(urllib.request.urlopen(NODE + p))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1, zusdc=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('text=Tokens', timeout=15000)
    t = pg.inner_text('main'); ok('zUSDC' in t and '2.00' in t, 'Tokens card: zUSDC by name, 2.00 (6 decimals, names built into the wallet)')
    pg.click('text=Send'); pg.wait_for_selector('form[data-form=send]')
    ok(pg.query_selector('select[name=asset]') is not None, 'Send offers a choice of ZP or a token when the wallet holds one')
    pg.select_option('select[name=asset]', ZUSDC); pg.wait_for_selector('text=Amount (zUSDC)')
    ok('Available 2.00' in pg.inner_text('main') and 'Send zUSDC' in pg.inner_text('body'), 'choosing zUSDC: title, unit and available amount follow it')
    to = get('/__addr')['other']
    pg.fill('input[name=to]', to); pg.click('button[data-act=max]'); ok(pg.input_value('input[name=amount]') == '2.00', 'Max fills the token balance')
    pg.fill('input[name=amount]', '1.2345678'); pg.click('form[data-form=send] button.primary'); pg.wait_for_selector('.err', timeout=5000)
    ok('at most 6 decimals' in pg.inner_text('.err'), 'more than 6 decimals is refused')
    pg.fill('input[name=amount]', '1.5'); pg.click('form[data-form=send] button.primary'); pg.wait_for_selector('text=Confirm transfer')
    ok('1.50 zUSDC' in pg.inner_text('.sheet'), 'confirm shows 1.50 zUSDC')
    pg.screenshot(path=f'{OUT}/st1-confirm.png')
    pg.click('button[data-act=confirm-send]'); pg.wait_for_selector('text=is on its way', timeout=15000)
    ok('1.50 zUSDC is on its way' in pg.inner_text('.sheet'), 'sent: 1.50 zUSDC')
    pub = get('/__published')
    dec = subprocess.run(['node', '-e', """
import('./src/serialize.js').then(({deserializeTx, unhex, hex}) => { const tx = deserializeTx(unhex(process.argv[1]));
  console.log(JSON.stringify(tx.outputs.map(o => [o.spend.asset.contract.version, hex(o.spend.asset.contract.hash), String(o.spend.amount)]))) })""", pub[-1]], capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    outs = json.loads(dec.stdout or '[]')
    ok(outs == [[1, ZUSDC[8:], '1500000'], [1, ZUSDC[8:], '500000']], 'published transaction: 1,500,000 units of zUSDC to the address, 500,000 change, no ZP moved ' + dec.stdout.strip() + dec.stderr[-200:])
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

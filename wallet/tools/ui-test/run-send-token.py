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
    mock(tip=2100, zp=10, utxo=0, reset=1, zusdc=1, bridge=1, hist=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('text=Tokens', timeout=15000)
    t = pg.inner_text('main'); ok('zUSDC' in t and '2.00' in t, 'Tokens card: zUSDC by name, 2.00 (6 decimals, names built into the wallet)')
    pg.wait_for_selector('text=the USDC bridge (deposit)', timeout=15000)
    t = pg.inner_text('main'); ok('+2.00 zUSDC' in t and pg.query_selector('.tname img.ticon') is not None and pg.evaluate("[...document.querySelectorAll('img.ticon')].every(i => i.naturalWidth > 0)"), 'activity: the deposit is named, +2.00 zUSDC, the icon loads (inside app.js)')
    pg.screenshot(path=f'{OUT}/st0-home.png')
    # Activity filters
    def shown(k):
        pg.click(f'button[data-act=afilter][data-v={k}]'); pg.wait_for_timeout(250)
        return [e.inner_text().split('\n')[0] for e in pg.query_selector_all('.item.act .act-main')]
    ok(len(shown('all')) == 5 and any('Moved within this wallet' in x for x in shown('all')), 'All: every row, the move within the wallet too')
    ok(shown('mining') == ['Mining reward'], 'Mining: the mining reward only')
    ok(len(shown('received')) == 1 and len(shown('sent')) == 1, 'Received and Sent: one each, the move within the wallet in neither')
    ok(any('USDC bridge' in x for x in shown('trading')) and len(shown('trading')) == 1, 'Trading: the bridge deposit')
    ok(pg.evaluate("JSON.parse(localStorage.getItem('zp-wallet.settings.v1')).afilter") == 'trading', 'the chosen filter is kept')
    pg.screenshot(path=f'{OUT}/st0b-filter.png')
    shown('all')
    # the token's sheet: balance, Send, Receive, Withdraw (the bridge's token), its own activity
    pg.click('button[data-act=token]'); pg.wait_for_selector('.sheet .tokbal')
    t = pg.inner_text('.sheet'); ok('2.00' in pg.inner_text('.tokbal') and 'Withdraw' in t and 'Deposit USDC' in t and 'the USDC bridge (deposit)' in t, 'token sheet: balance, Withdraw, Deposit USDC, its activity')
    pg.screenshot(path=f'{OUT}/st0-sheet.png')
    pg.click('.sheet button[data-act=token-send]'); pg.wait_for_selector('form[data-form=send]')
    ok(pg.query_selector('.tokpick') is not None and pg.get_attribute('button[data-act=send-asset][data-asset="%s"]' % ZUSDC, 'aria-checked') == 'true', 'Send from the sheet: zUSDC already chosen, tokens as icon buttons')
    pg.click('button[data-act=send-asset][data-asset="00"]'); pg.wait_for_selector('text=Amount (ZP)')
    pg.click('button[data-act=send-asset][data-asset="%s"]' % ZUSDC); pg.wait_for_selector('text=Amount (zUSDC)')
    ok('Available 2.00' in pg.inner_text('main') and 'Send zUSDC' in pg.inner_text('body'), 'choosing zUSDC: title, unit and available amount follow it')
    to = get('/__addr')['other']
    pg.fill('input[name=to]', 'tzn1q27ngrump3ahlrtrys9y03c84hj9j8pjupsz0f6qrach80j3jjy6sn0732d'); pg.wait_for_selector('text=not the USDC bridge', timeout=5000)
    ok('Market maker' in pg.inner_text('main'), 'a named address (the testnet market maker) says it is not the bridge')
    pg.fill('input[name=to]', to); pg.wait_for_selector('text=Withdrawal to USDC', timeout=5000)
    ok('pays the same amount of USDC' in pg.inner_text('main') and 'about 8 to 10 minutes' in pg.inner_text('main'), 'sending zUSDC to the bridge address: shown as a withdrawal with the wait')
    pg.click('button[data-act=send-asset][data-asset="00"]'); pg.wait_for_selector('text=It takes only zUSDC'); ok(True, 'sending ZP to the bridge: warned that only zUSDC is taken')
    pg.click('button[data-act=send-asset][data-asset="%s"]' % ZUSDC); pg.wait_for_selector('text=Withdrawal to USDC')
    ok(pg.input_value('input[name=to]') == to, 'the address is kept when the asset changes')
    pg.click('button[data-act=max]'); ok(pg.input_value('input[name=amount]') == '2.00', 'Max fills the token balance')
    pg.fill('input[name=amount]', '1.2345678'); pg.click('form[data-form=send] button.primary'); pg.wait_for_selector('.err', timeout=5000)
    ok('at most 6 decimals' in pg.inner_text('.err'), 'more than 6 decimals is refused')
    pg.fill('input[name=amount]', '1.5'); pg.click('form[data-form=send] button.primary'); pg.wait_for_selector('text=Confirm transfer')
    ok('1.50 zUSDC' in pg.inner_text('.sheet') and 'USDC bridge' in pg.inner_text('.sheet'), 'confirm shows 1.50 zUSDC to the USDC bridge')
    pg.screenshot(path=f'{OUT}/st1-confirm.png')
    pg.click('button[data-act=confirm-send]'); pg.wait_for_selector('text=is on its way', timeout=15000)
    ok('1.50 zUSDC is on its way' in pg.inner_text('.sheet'), 'sent: 1.50 zUSDC')
    ok('the bridge pays the USDC' in pg.inner_text('.sheet') and pg.query_selector('.sheet button[data-act=copy]') is not None, 'sent: the withdrawal wait, and a Copy button for the transaction id')
    pub = get('/__published')
    dec = subprocess.run(['node', '-e', """
import('./src/serialize.js').then(({deserializeTx, unhex, hex}) => { const tx = deserializeTx(unhex(process.argv[1]));
  console.log(JSON.stringify(tx.outputs.map(o => [o.spend.asset.contract.version, hex(o.spend.asset.contract.hash), String(o.spend.amount)]))) })""", pub[-1]], capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    outs = json.loads(dec.stdout or '[]')
    ok(outs == [[1, ZUSDC[8:], '1500000'], [1, ZUSDC[8:], '500000']], 'published transaction: 1,500,000 units of zUSDC to the address, 500,000 change, no ZP moved ' + dec.stdout.strip() + dec.stderr[-200:])
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

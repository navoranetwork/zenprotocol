"""Browser test of selling ZP for bitcoin from the wallet's Markets screen: own offers, a new offer, taking one back.
Setup:  node build.mjs && (cd dist && python3 -m http.server 8081 &) && node tools/ui-test/mock-node.mjs --port 8082 &
        python3 tools/ui-test/run-swap.py [--out DIR]
The wallet's node is http://localhost:8082/node, so the wallet reads the site's /swap/status next to it (the mock serves it)."""
import sys, json, urllib.request, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'node_modules'))
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
def published(): return json.load(urllib.request.urlopen(NODE + '/__published'))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=markets]'); pg.wait_for_timeout(800)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('h2:has-text("Sell ZP for bitcoin")'); pg.wait_for_timeout(800)
    card = pg.inner_text('.card:has(h2:has-text("Sell ZP for bitcoin"))')
    ok('3 ZP for 0.00060000 BTC' in card and '1 ZP for 0.00020000 BTC' in card, 'own offers listed')
    ok('0.00020000 BTC per ZP' in card and '≈ $20.00' in card, 'each offer shows its price per ZP, in dollars from the oracle\'s BTC price')
    ok('7 ZP' not in card, 'another seller\'s offer is not listed as mine')
    ok(pg.query_selector('button[data-act=swap-cancel][data-id=o-mine1]') is not None and pg.query_selector('button[data-act=swap-cancel][data-id=o-mine2]') is None, 'Take back only on the open offer, not the reserved one')
    pg.screenshot(path=f'{OUT}/s1-markets.png', full_page=True)
    # new offer
    pg.click('button[data-act=swap-new]'); pg.wait_for_selector('form[data-form=offer]')
    pg.fill('input[name=zp]', '4'); pg.fill('input[name=btc]', '0.0008')
    ok('0.00020000 BTC per ZP (20,000 sat)' in pg.inner_text('#offer-rate'), 'rate shown: ' + pg.inner_text('#offer-rate'))
    pg.click('button[data-act=price-mode][data-v=usd]'); pg.fill('input[name=per]', '1')
    ok('Total 0.00004000 BTC' in pg.inner_text('#offer-rate') and pg.input_value('input[name=zp]') == '4', '$1 per ZP at $100,000 per BTC: 4 ZP = 0.00004 BTC (' + pg.inner_text('#offer-rate') + ')')
    pg.click('button[data-act=price-mode][data-v=sat]'); pg.fill('input[name=per]', '20000')
    ok('Total 0.00080000 BTC' in pg.inner_text('#offer-rate'), '20,000 sat per ZP: 4 ZP = 0.0008 BTC')
    pg.screenshot(path=f'{OUT}/s1b-offer-per-zp.png')
    pg.fill('textarea[name=addrs]', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'); pg.click('form[data-form=offer] button.primary'); pg.wait_for_timeout(500)
    ok('testnet address' in pg.inner_text('.sheet'), 'a Bitcoin testnet address is refused (the contract follows mainnet)')
    pg.fill('textarea[name=addrs]', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4\n1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'); pg.click('form[data-form=offer] button.primary')
    pg.wait_for_selector('button[data-act=confirm-offer]'); t = pg.inner_text('.sheet')
    ok('4 ZP' in t and '0.00080000 BTC' in t and 'Bitcoin address 2' in t, 'confirm shows amount, price and both addresses')
    pg.screenshot(path=f'{OUT}/s2-confirm-offer.png')
    pg.click('button[data-act=confirm-offer]'); pg.wait_for_selector('h2:has-text("Broadcast successfully")')
    pub = published(); ok(len(pub) == 1, 'one transaction published')
    # check the published transaction with the wallet's own reader (node), outside the browser
    import subprocess
    chk = subprocess.run(['node', '-e', '''
      import('./src/serialize.js').then(({ deserializeTx, unhex, hex }) => {
        const tx = deserializeTx(unhex(process.argv[1]));
        const c = tx.witnesses.find(w => w.type === 'Contract'), out = tx.outputs.find(o => o.lock.type === 'Contract' && o.spend.asset.contract.version === 0);
        console.log(JSON.stringify({ cmd: c.command, signed: !!c.signature, locked: String(out.spend.amount), pk: tx.witnesses.filter(w => w.type === 'PK').length }));
      });''', pub[0]], capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), '..', '..'))
    info = json.loads(chk.stdout or '{}'); print('   ', info)
    ok(info.get('cmd') == 'offer' and info.get('signed') and info.get('locked') == '400000000', 'the offer transaction locks 4 ZP and carries the seller\'s signature')
    pg.click('button[data-act=close]')
    # take back
    pg.click('button[data-act=swap-cancel][data-id=o-mine1]'); pg.wait_for_timeout(1200)
    ok('still waiting for its block' in pg.inner_text('main'), 'the output spent by the offer is not used again before its block')
    mock(utxo=1)   # the offer is in a block: the wallet has a new output
    pg.click('button[data-act=swap-cancel][data-id=o-mine1]'); pg.wait_for_selector('button[data-act=confirm-cancel]')
    ok('3 ZP for 0.00060000 BTC' in pg.inner_text('.sheet'), 'take back confirm names the offer')
    pg.screenshot(path=f'{OUT}/s3-confirm-cancel.png')
    pg.click('button[data-act=confirm-cancel]'); pg.wait_for_selector('h2:has-text("Broadcast successfully")')
    ok(len(published()) == 2, 'cancel published')
    ok(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll at 390px')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

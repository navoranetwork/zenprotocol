"""Browser test of selling ZP for bitcoin without typing Bitcoin addresses: new receive addresses from the account key
(BIP84 zpub, the published vectors), a used one skipped, never the same address twice (across reloads too), a
connected Bitcoin wallet that gives one fixed address (one reservation, explained), a wallet on the wrong Bitcoin
network refused, and the Bitcoin data settings. Setup as run-swap.py (mock-node on :8082, dist/ on :8081)."""
import sys, json, urllib.request, os, subprocess, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
WALLET_ADDR = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
HERE = os.path.join(os.path.dirname(__file__), '..', '..')
A = json.loads(subprocess.run(['node', '-e', f'''import('./src/btc.js').then(({{ parseAccount, accountAddress }}) => {{ const a = parseAccount('{ZPUB}'); console.log(JSON.stringify([0,1,2,3,4].map(i => accountAddress(a, i)))); }});'''], capture_output=True, text=True, cwd=HERE).stdout)
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def published(): return json.load(urllib.request.urlopen(NODE + '/__published'))
ICON = 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="#7a5cff"/></svg>').decode()
FAKE = """
window.__btcCalls = [];
window.FakeBtc = { request: async (m, p) => { window.__btcCalls.push([m, p]); return m === 'getAddresses' ? { jsonrpc: '2.0', result: { addresses: [{ address: '%s', purpose: 'payment' }] } } : { error: { code: -32601, message: 'no' } }; } };
window.TestnetBtc = { request: async () => ({ result: { addresses: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', purpose: 'payment' }] } }) };
window.unisat = { requestAccounts: async () => ['%s'], sendBitcoin: async () => 'cc'.repeat(32) };
window.btc_providers = [{ id: 'FakeBtc', name: 'Fake Wallet', icon: '%s' }, { id: 'TestnetBtc', name: 'Testnet Wallet' }];
""" % (WALLET_ADDR, WALLET_ADDR, ICON)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("if (!localStorage.getItem('zp-wallet.settings.v1')) localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}, mtab:'swap', stab:'sell'}))" % (NODE, NODE))
    ctx.add_init_script(FAKE)
    asked = []
    def esplora(r):
        a = r.request.url.rsplit('/', 1)[1]; asked.append(a)
        r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps({'chain_stats': {'funded_txo_count': 1 if a == A[1] else 0}, 'mempool_stats': {'funded_txo_count': 0}}))
    ctx.route('https://mempool.space/**', esplora)
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=markets]'); pg.wait_for_timeout(600)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('h2:has-text("Your offers")', timeout=15000)
    ok('Real bitcoin, test ZP' in pg.inner_text('main'), 'the "real bitcoin, test ZP" banner on the Sell tab')
    # 1. account key, 2 reservations: index 0, then 2 (index 1 received bitcoin before)
    pg.click('button[data-act=swap-new]'); pg.wait_for_selector('form[data-form=offer]')
    pg.click('button[data-act=price-mode][data-v=total]'); pg.fill('input[name=zp]', '2'); pg.fill('input[name=btc]', '0.0004')
    pg.fill('input[name=xpub]', 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi')
    pg.click('form[data-form=offer] button.primary'); pg.wait_for_timeout(500)
    ok('private key' in pg.inner_text('.sheet') and pg.query_selector('input[name=xpub].invalid, input[name=xpub][aria-invalid=true]') is not None, 'a private key is refused, and the field is marked')
    ok(pg.query_selector('button[data-act=addr-count][data-v="2"].on') is not None, 'an offer has 2 reservations by default (the gap limit)')
    pg.fill('input[name=xpub]', ZPUB); pg.click('button[data-act=addr-count][data-v="2"]')
    ok(pg.input_value('input[name=zp]') == '2' and pg.input_value('input[name=btc]') == '0.0004', 'choosing the number of reservations keeps what was typed')
    pg.screenshot(path=f'{OUT}/k1-account-key.png')
    pg.click('form[data-form=offer] button.primary'); pg.wait_for_selector('button[data-act=confirm-offer]', timeout=10000)
    t = pg.inner_text('.sheet'); ok(A[0] in t and A[2] in t and A[1] not in t, 'two new addresses from the key: index 0 and 2; index 1 (received bitcoin before) skipped')
    ok('New, from your account key' in t and 'Bitcoin address 2' in t and 'Bitcoin address 3' not in t, 'confirm says where they come from')
    ok(ZPUB not in ' '.join(asked), 'mempool.space is asked about addresses, never the account key')
    pg.screenshot(path=f'{OUT}/k2-confirm.png')
    pg.click('button[data-act=confirm-offer]'); pg.wait_for_selector('h2:has-text("Broadcast successfully")')
    ok(len(published()) == 1, 'offer published')
    acc = pg.evaluate("JSON.parse(localStorage.getItem('zp-wallet.btc-account.v1')).main"); ok(acc['key'] == ZPUB and acc['lastUsed'] == 1, f'the key is kept on this device, with the last address used on Bitcoin (1) ({acc})')
    pg.click('button[data-act=close]')
    # 2. after a reload the next offer continues at index 3; the key is not asked again
    mock(utxo=1)
    pg.reload(); pg.wait_for_selector('form[data-form=unlock]'); pg.fill('input[name=p]', 'password123'); pg.click('form[data-form=unlock] button.primary')
    pg.wait_for_selector('[data-go=markets]'); pg.click('nav >> text=Markets'); pg.wait_for_selector('h2:has-text("Your offers")', timeout=15000)
    pg.click('button[data-act=swap-new]'); pg.wait_for_selector('form[data-form=offer]')
    ok(pg.query_selector('input[name=xpub]') is None and 'GutZYs' in pg.inner_text('.sheet'), 'the saved key shows shortened; it is not asked again')
    pg.click('button[data-act=price-mode][data-v=total]'); pg.fill('input[name=zp]', '1'); pg.fill('input[name=btc]', '0.0002'); pg.click('button[data-act=addr-count][data-v="1"]')
    pg.click('form[data-form=offer] button.primary'); pg.wait_for_selector('button[data-act=confirm-offer]', timeout=10000)
    t = pg.inner_text('.sheet'); ok(A[3] in t and A[0] not in t and A[2] not in t, 'after a reload the next offer gets index 3: never an address twice')
    pg.click('.sheet button[data-act=close]'); pg.wait_for_timeout(300)
    # 3. a connected Bitcoin wallet: its own icon and name, one fixed address, one reservation
    pg.click('button[data-act=swap-new]'); pg.wait_for_selector('form[data-form=offer]')
    pg.click('button[data-act=addr-src][data-v=wallet]'); pg.wait_for_selector('.wtile')
    ok(pg.query_selector('.wtile img.wicon[src^="data:image/svg+xml"]') is not None and 'Fake Wallet' in pg.inner_text('.sheet') and 'Testnet Wallet' in pg.inner_text('.sheet'), 'Bitcoin wallets listed with the icon each gives')
    ok(pg.query_selector('.wtile:has-text("UniSat") img.wicon.brand[src^="data:image/png"]') is not None, 'UniSat, which gives no icon, shows its original logo (bundled)')
    pg.screenshot(path=f'{OUT}/k3-wallets.png')
    pg.click('button[data-act=btcw-sell] >> text=Testnet Wallet'); pg.wait_for_timeout(400)
    ok('is on Bitcoin testnet' in pg.inner_text('.sheet'), 'a wallet on Bitcoin testnet is refused clearly')
    pg.click('button[data-act=btcw-sell] >> text=Fake Wallet'); pg.wait_for_timeout(400)
    t = pg.inner_text('.sheet'); ok(WALLET_ADDR in t and 'can be reserved once' in t, 'the wallet\'s one address is used, and the one-reservation limit is explained')
    ok(any(c[0] == 'getAddresses' for c in pg.evaluate('window.__btcCalls')) and all(c[0] == 'getAddresses' for c in pg.evaluate('window.__btcCalls')), 'the wallet was only asked for its address')
    pg.screenshot(path=f'{OUT}/k4-wallet-address.png')
    pg.click('button[data-act=price-mode][data-v=total]'); pg.fill('input[name=zp]', '1'); pg.fill('input[name=btc]', '0.0002')
    pg.click('form[data-form=offer] button.primary'); pg.wait_for_selector('button[data-act=confirm-offer]', timeout=10000)
    ok(WALLET_ADDR in pg.inner_text('.sheet') and 'Bitcoin address 2' not in pg.inner_text('.sheet'), 'confirm: that one address')
    pg.click('.sheet button[data-act=close]'); pg.wait_for_timeout(300)
    # 4. Settings: the Bitcoin data source and the saved key
    pg.click('nav >> text=Settings'); pg.wait_for_selector('form[data-form=btcapi]')
    t = pg.inner_text('form[data-form=btcapi]'); ok('sees those addresses and your IP address' in t and 'GutZYs' in t, 'Settings: what the Bitcoin service learns, and the saved key')
    ok('Wallet names and logos are trademarks of their owners' in pg.inner_text('main'), 'Settings: the trademark line')
    pg.fill('form[data-form=btcapi] input[name=url]', 'ftp://example.org'); pg.click('form[data-form=btcapi] button.primary'); pg.wait_for_timeout(300)
    ok('Use https://' in pg.inner_text('form[data-form=btcapi]'), 'a bad Esplora address is refused')
    pg.route('https://esplora.example.org/**', lambda r: r.fulfill(status=200, content_type='text/plain', headers={'Access-Control-Allow-Origin': '*'}, body='900123'))
    pg.fill('form[data-form=btcapi] input[name=url]', 'https://esplora.example.org/api'); pg.click('form[data-form=btcapi] button.primary'); pg.wait_for_selector('text=900,123')
    ok(pg.evaluate("JSON.parse(localStorage.getItem('zp-wallet.settings.v1')).btcApi") == 'https://esplora.example.org/api', 'another Esplora API saved after it answered')
    pg.screenshot(path=f'{OUT}/k5-settings.png', full_page=True)
    pg.click('button[data-act=btc-acc-forget]'); pg.wait_for_timeout(200)
    ok(pg.evaluate("JSON.parse(localStorage.getItem('zp-wallet.btc-account.v1')).main") is None, 'Forget removes the key from this device')
    ok(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll at 390px')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

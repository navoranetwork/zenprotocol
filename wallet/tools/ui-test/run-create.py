"""Browser test of creating a contract with the contract engine (Contracts -> Create a contract).
Setup as run-swap.py (dist on :8081, mock-node.mjs on :8082 with V1H=2000 so V1 is open at tip 2100)."""
import sys, json, urllib.request, os, subprocess
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
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=contracts]'); pg.wait_for_timeout(800)
    pg.click('nav >> text=Contracts'); pg.wait_for_selector('button[data-act=cc-family]')
    ok('Time-locked vault' in pg.inner_text('main') and 'experimental' in pg.inner_text('main'), 'families from the engine, and Describe it (experimental)')
    ok('Anyone deposits; only the owner withdraws' in pg.inner_text('.fams'), 'each family is a card with what it does')
    pg.screenshot(path=f'{OUT}/k0-families.png', full_page=True)
    pg.click('button[data-act=cc-family]'); pg.wait_for_selector('form[data-form=cc-make]')
    pg.click('button[data-act=cc-fill]'); v = pg.input_value('input[name=p_owner]')
    ok(len(v) == 64, 'My address fills the owner hash')
    pg.fill('input[name=p_unlock_block]', '0'); pg.click('form[data-form=cc-make] button.primary'); pg.wait_for_timeout(300)
    ok('at least 1' in pg.inner_text('main'), 'a value below the minimum is explained before sending')
    pg.fill('input[name=p_unlock_block]', '2500'); pg.click('form[data-form=cc-make] button.primary')
    pg.wait_for_selector('text=Made and checked', timeout=15000)
    t = pg.inner_text('main'); ok('accepted' in t and '2 tests pass' in t, 'result: a node accepts it, tests pass')
    pg.screenshot(path=f'{OUT}/k1-result.png', full_page=True)
    # edit to something a node refuses, then back
    pg.click('summary:has-text("Source")'); pg.click('button[data-act=cc-edit]'); pg.fill('textarea[name=source]', 'let main = 1\nlet rec spin n = spin n\n')
    pg.click('form[data-form=cc-check] button.btn'); pg.wait_for_selector('text=A node would refuse it', timeout=15000)
    ok('Use a Zulib loop' in pg.inner_text('main') and 'Check the changed source first' in pg.inner_text('main'), 'refusal shows rule, fix; activation waits for a passing check')
    pg.screenshot(path=f'{OUT}/k2-refused.png', full_page=True)
    pg.click('button[data-act=cc-reset]'); pg.wait_for_timeout(300)
    pg.fill('input[name=blocks]', '100'); pg.click('form[data-form=cc-activate] button.primary'); pg.wait_for_selector('button[data-act=confirm-activate]')
    t = pg.inner_text('.sheet'); ok('100 blocks' in t and 'ZP' in t, 'activation review: blocks and cost')
    pg.screenshot(path=f'{OUT}/k3-review.png')
    pg.click('button[data-act=confirm-activate]'); pg.wait_for_selector('h2:has-text("Broadcast successfully")')
    pub = published(); ok(len(pub) == 1, 'activation published')
    chk = subprocess.run(['node', '-e', '''import('./src/serialize.js').then(({ deserializeTx, unhex }) => { import('./src/engine.js').then(({ v1ContractId }) => {
        const tx = deserializeTx(unhex(process.argv[1])); const src = new TextDecoder().decode(tx.contract.bytes);
        const sac = tx.outputs.find(o => o.lock.type === 'ActivationSacrifice');
        console.log(JSON.stringify({ v: tx.contract.version, len: src.length, sac: String(sac.spend.amount), id: v1ContractId(src) })); }); });''', pub[0]],
        capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), '..', '..'))
    info = json.loads(chk.stdout or '{}'); print('   ', info)
    ok(info.get('v') == 1 and info.get('sac') == str(info.get('len', 0) * 100), 'the transaction carries the source (V1) and pays length x 100 blocks')
    ok(info.get('id', '')[8:16] in pg.inner_text('.sheet') or 'ctzn1' in pg.inner_text('.sheet'), 'the new contract address is shown')
    pg.click('button[data-act=close]')
    # described contract
    pg.click('nav >> text=Contracts'); pg.wait_for_selector('button[data-act=cc-ask]'); pg.click('button[data-act=cc-ask]')
    ok('Experimental' in pg.inner_text('main'), 'Describe it warns that the tests are the model\'s')
    pg.fill('textarea[name=text]', 'a vault that pays the owner after block 2500'); pg.click('form[data-form=cc-ask] button.primary')
    pg.wait_for_selector('text=Made and checked', timeout=15000); ok('Written by an AI model in 2 rounds' in pg.inner_text('main'), 'result of a described contract is marked')
    ok(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll at 390px')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

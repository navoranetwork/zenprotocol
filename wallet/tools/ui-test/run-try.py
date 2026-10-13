"""Browser test of trying a contract's calls (Contracts -> Escrow -> Try it) and of a contract job surviving a reload.
Setup as run-swap.py (dist on :8081, mock-node.mjs on :8082 with V1H=2000)."""
import sys, json, urllib.request, os
from playwright.sync_api import sync_playwright
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
SELLER, ARBITER = '03' + '42' * 32, '02' + '16' * 32
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def last(): return json.load(urllib.request.urlopen(NODE + '/__lasttry'))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 860})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1, askLeft=4)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=contracts]'); pg.wait_for_timeout(800)
    pg.click('nav >> text=Contracts'); pg.wait_for_selector('button[data-act=cc-family]')
    ok('4 of 5 left today' in pg.inner_text('main'), 'Describe it shows what is left today')
    pg.click('button[data-act=cc-family][data-id=escrow]'); pg.wait_for_selector('form[data-form=cc-make]')
    pg.click('button[data-act=cc-fill][data-name=buyer]'); buyer = pg.input_value('input[name=p_buyer]')
    pg.fill('input[name=p_seller]', SELLER); pg.fill('input[name=p_arbiter]', ARBITER); pg.fill('input[name=p_timeout_block]', '5000')
    pg.click('form[data-form=cc-make] button.primary'); pg.wait_for_selector('text=Made and checked', timeout=15000)
    t = pg.inner_text('main'); ok('gas · fee: none required' in t, 'result: gas per call, no fee required')
    pg.click('button[data-act=cc-try-open]'); pg.wait_for_selector('form[data-form=cc-try]')
    ok('holds nothing yet' in pg.inner_text('main') and 'Sends in (ZP)' in pg.inner_text('main') and pg.input_value('select[name=signer]') == '', 'try starts empty; deposit sends the escrow asset (ZP), anyone may call it')
    # deposit 6 ZP, unsigned
    pg.select_option('select[name=signer]', ''); pg.fill('input[name=spend]', '6 ZP'); pg.click('form[data-form=cc-try] button.primary')
    pg.wait_for_selector('text=What happens', timeout=15000)
    t = pg.inner_text('main'); ok('this contract gets 6 ZP' in t and 'holds 6 ZP' in t, 'deposit: the contract gets 6 ZP and holds it')
    L = last(); ok(L['call']['spend'] == [{'asset': 'zp', 'amount': '600000000'}] and 'source' not in L and L.get('sourceId', '').startswith('00000001'), 'deposit sent as kalapa strings, by sourceId (no source)')
    # release 2.5 ZP signed by the buyer
    pg.click('button[data-act=cc-cmd][data-name=release]'); pg.wait_for_selector('input[name=t_amount]')
    ok(pg.input_value('select[name=signer]') == 'buyer', 'release defaults to a signer it allows (the buyer)')
    pg.fill('input[name=t_amount]', '2.5 ZP'); pg.click('form[data-form=cc-try] button.primary'); pg.wait_for_selector('text=the seller gets', timeout=15000)
    t = pg.inner_text('main'); ok('the seller gets 2.5 ZP' in t and 'this contract pays 2.5 ZP' in t and 'holds 3.5 ZP' in t, 'release: net effect, and the contract keeps the change')
    L = last()['call']; ok(L['sender']['publicKey'] == buyer and L['bodyHex'].startswith('0c01') and L['wallet'] == [{'asset': 'zp', 'amount': '600000000'}] and L['context']['blockNumber'] == 2101,
        'release: buyer key as sender, body as Data hex, the session wallet, next block')
    ok(last()['roles'] == {'buyer': buyer, 'seller': SELLER, 'arbiter': ARBITER}, 'roles sent so moves can name them')
    pg.click('details.how summary'); ok('In' in pg.inner_text('details.how') and 'Out' in pg.inner_text('details.how'), 'raw inputs and outputs behind Details')
    pg.screenshot(path=f'{OUT}/t1-release.png', full_page=True)
    # the seller may not release
    pg.select_option('select[name=signer]', 'seller'); pg.click('form[data-form=cc-try] button.primary'); pg.wait_for_selector('text=Refused', timeout=15000)
    t = pg.inner_text('main'); ok('only the buyer or the arbiter can release' in t and 'Nothing moves' in t and 'holds 3.5 ZP' in t, 'a refused call: the reason, nothing moves, holdings unchanged')
    pg.screenshot(path=f'{OUT}/t2-refused.png', full_page=True)
    # refund signed by the buyer: refused before the timeout, allowed from it
    pg.click('button[data-act=cc-cmd][data-name=refund]'); pg.wait_for_selector('input[name=t_amount]')
    ok('From block 5,000 on, anyone can call it.' in pg.inner_text('main'), 'refund shows its timeout window')
    pg.select_option('select[name=signer]', 'buyer'); pg.fill('input[name=t_amount]', '1 ZP'); pg.click('form[data-form=cc-try] button.primary'); pg.wait_for_selector('text=can refund', timeout=15000); pg.wait_for_selector('form[data-form=cc-try] button.primary')
    ok('only the seller or the arbiter can refund' in pg.inner_text('main'), 'refund by the buyer before the timeout is refused')
    pg.click('button[data-act=cc-block][data-v="5000"]'); ok(pg.input_value('input[name=block]') == '5000' and pg.input_value('input[name=t_amount]') == '1 ZP', 'the block chip sets block 5,000 and keeps the form')
    pg.click('form[data-form=cc-try] button.primary'); pg.wait_for_selector('text=the buyer gets', timeout=15000)
    t = pg.inner_text('main'); ok('the buyer gets 1 ZP' in t and 'holds 2.5 ZP' in t and last()['call']['context']['blockNumber'] == 5000, 'from the timeout the buyer\'s refund goes through, at block 5,000')
    pg.screenshot(path=f'{OUT}/t3-refund.png', full_page=True)
    pg.click('button[data-act=cc-try-reset]'); ok('holds nothing yet' in pg.inner_text('main'), 'Start over empties the session')
    ok(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll at 390px')
    pg.click('button[data-act=cc-try-back]'); ok('Made and checked' in pg.inner_text('main'), 'back goes to the result')
    # a contract job survives a reload
    pg.reload(); pg.wait_for_selector('form[data-form=unlock]'); pg.fill('input[name=p]', 'password123'); pg.click('form[data-form=unlock] button.primary')
    pg.wait_for_selector('[data-go=contracts]'); pg.click('nav >> text=Contracts')
    pg.wait_for_selector('button[data-act=cc-open]', timeout=15000); ok('Back to your last contract' in pg.inner_text('main'), 'after a reload the last contract comes back from its job id')
    pg.click('button[data-act=cc-open]'); pg.wait_for_selector('text=Made and checked'); ok('Escrow with an arbiter' in pg.inner_text('main'), 'it is the escrow, with its family')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'FAILED {len(bad)}'); sys.exit(1 if bad else 0)

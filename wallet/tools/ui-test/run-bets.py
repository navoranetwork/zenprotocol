"""Browser test of Up / Down bets in the Oracle tab: the note before the contract is active, the open markets with
the Dex price of each side, a bet (a Dex Take of Up tokens), and collecting the winnings of a settled market (a signed
Redeem with the oracle's proof). Setup as run-swap.py (dist on :8081, mock-node.mjs on :8082)."""
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
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'test', nodes:{test:'%s/node', main:'%s/node'}, mtab:'oracle', ocat:'crypto'}))" % (NODE, NODE))
    pg = ctx.new_page(); errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    mock(tip=2100, zp=10, utxo=0, reset=1, zusdc=1, bets=0)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('text=Tokens', timeout=15000)
    pg.click('nav >> text=Markets'); pg.wait_for_selector('text=Up or down?', timeout=15000)
    ok('open when the bet contract is active' in pg.inner_text('main'), 'before the contract: a short note, no bet buttons')
    pg.screenshot(path=f'{OUT}/bt0-before.png')

    mock(bets=1); pg.click('nav >> text=Wallet'); pg.click('button[data-act=refresh]'); pg.wait_for_timeout(2000); pg.click('nav >> text=Markets'); pg.wait_for_selector('.bet .betrow', timeout=15000)
    t = pg.inner_text('main')
    ok('BTC at or above 105,000' in t and 'ETH at or above 3,800' in t and 'closes' in t, 'open markets: ticker, strike, close time')
    ok(pg.query_selector('button[data-act=bet][data-side=up]') is not None and '0.60' in t and '0.42' in t and '0.35' in t, 'Up and Down show the Dex price of a token')
    ok(pg.query_selector_all('.betbtn.off') != [], 'a side with no offer is shown, but cannot be tapped')
    ok('Your bets' in t and 'Collect 5.00 zUSDC' in t, 'Your bets: the settled market\'s Up tokens can be collected (5.00 zUSDC)')
    pg.screenshot(path=f'{OUT}/bt1-markets.png', full_page=True)

    # a bet: Up on BTC 105,000 at 0.60
    pg.click('.bet >> nth=0 >> button[data-side=up]'); pg.wait_for_selector('form[data-form=bet]')
    ok('You win if BTC is at or above 105,000' in pg.inner_text('.sheet'), 'the bet sheet says when you win')
    pg.fill('form[data-form=bet] input[name=stake]', '1.2'); pg.wait_for_timeout(200)
    ok(pg.inner_text('#bet-win') == '2.00 zUSDC (+0.80)', 'as you type: 1.20 zUSDC at 0.60 wins 2.00 zUSDC (+0.80)')
    pg.screenshot(path=f'{OUT}/bt2-sheet.png')
    pg.fill('form[data-form=bet] input[name=stake]', '7'); pg.click('form[data-form=bet] button.primary'); pg.wait_for_selector('.sheet .err', timeout=15000)
    ok('More than this offer' in pg.inner_text('.sheet') or 'You have' in pg.inner_text('.sheet'), 'more than the offer or the balance is refused')
    pg.fill('form[data-form=bet] input[name=stake]', '1.2'); pg.click('form[data-form=bet] button.primary'); pg.wait_for_selector('text=Confirm bet', timeout=15000)
    t = pg.inner_text('.sheet'); ok('▲ Up: BTC ≥ 105,000' in t and 'If right you get' in t and '2.00 zUSDC' in t, 'confirm: the bet, the stake and the winnings')
    pg.screenshot(path=f'{OUT}/bt3-confirm.png')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your bet is on its way', timeout=15000)
    ok(get('/__lastdex') == {'command': 'Take', 'provided': '1200000', 'payout': '2000000', 'signed': False}, 'sent as a Dex Take: 1.20 zUSDC for 2 Up tokens')
    pg.click('button[data-act=close]'); pg.wait_for_timeout(500)

    # collect the winnings of the settled market
    pg.click('button[data-act=bet-redeem]')
    try: pg.wait_for_selector('text=Collect winnings', timeout=15000)
    except Exception: print(pg.inner_text('body')[-800:]); pg.screenshot(path=f'{OUT}/bt-err.png'); raise
    t = pg.inner_text('.sheet'); ok('You get' in t and '5.00 zUSDC' in t and '101,234.5' in t, 'collect: 5.00 zUSDC, with the close price from the oracle')
    pg.screenshot(path=f'{OUT}/bt4-collect.png')
    pg.click('button[data-act=dex-send]'); pg.wait_for_selector('text=Your winnings are on their way', timeout=15000)
    ok(get('/__lastbet') == {'command': 'Redeem', 'tokens': '5000000'}, 'sent as a signed Redeem of the 5 Up tokens, proof included')
    pg.click('button[data-act=close]'); pg.wait_for_timeout(500)
    ok('Collecting' in pg.inner_text('main'), 'meanwhile Your bets says Collecting…')
    ok(not errors, 'no page errors ' + '; '.join(errors))
    b.close()
print('ALL PASS' if not bad else f'{len(bad)} FAILED')
sys.exit(1 if bad else 0)

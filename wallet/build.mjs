// Builds the static wallet into dist/: one bundled app.js plus index.html and style.css.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));   // the release number (CHANGELOG.md), shown in Settings
// token names known when the wallet is built (the site's asset-names.json); a site's assets.json adds to them at run time
// BTC_WALLET_PAY=1 switches on paying a ZP <-> BTC purchase from a Bitcoin wallet in the browser (after Alon's go-ahead)
// token icons go inside app.js as data URIs: a site that copies only the top of dist/ still shows them
// (web/icons/README.md: where each comes from; Bitcoin wallet logos only for wallets that give no icon of their own)
const icons = Object.fromEntries([['zusdc', 'svg', 'svg+xml'], ['usdc', 'svg', 'svg+xml'], ['btc', 'svg', 'svg+xml'], ['zp', 'png', 'png'], ['unisat', 'png', 'png'], ['okx', 'webp', 'webp']]
  .map(([n, ext, mime]) => [n, `data:image/${mime};base64,` + readFileSync(`web/icons/${n}.${ext}`).toString('base64')]));
let names = {}; try { names = Object.fromEntries(Object.entries(JSON.parse(readFileSync('../site/asset-names.json', 'utf8'))).filter(([k, v]) => /^[0-9a-f]{72}([0-9a-f]{64})?$/.test(k) && typeof v === 'string')); } catch { /* no site next to the wallet */ }
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: 'dist/app.js', legalComments: 'eof', define: { __WALLET_VERSION__: JSON.stringify(version), __ASSET_NAMES__: JSON.stringify(names), __ICONS__: JSON.stringify(icons), __BTC_WALLET_PAY__: JSON.stringify(process.env.BTC_WALLET_PAY === '1') } });
copyFileSync('web/style.css', 'dist/style.css');
// the page links its files with a version taken from their content, so a browser that cached an old build fetches the new one
const ver = f => createHash('sha1').update(readFileSync(`dist/${f}`)).digest('hex').slice(0, 8);
writeFileSync('dist/index.html', readFileSync('web/index.html', 'utf8').replace('href="style.css"', `href="style.css?v=${ver('style.css')}"`).replace('src="app.js"', `src="app.js?v=${ver('app.js')}"`));
console.log(`dist/ ready (ZP Wallet ${version})`);

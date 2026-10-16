// Wallets made from public test phrases: anyone can derive their keys. A service that signs with the node wallet
// (bridge, oracle, market maker, bets) refuses to start when the wallet is one of them: always on mainnet, and on the
// testnet unless ZP_ALLOW_TEST_KEYS=1 (only for a throwaway devnet). Checked by the wallet's first key, m/44'/258'/0'/0/0.
// The phrases (24 or 12 words, BIP39 test vectors and tool defaults) and the compressed key of their 0/0:
export const KNOWN_TEST_WALLETS = {
  '03486f683630b750a936db6e20241ff88af43a910a58d2a1e0360d07c074757b62': 'abandon x23 art (the wallet tests, docs, devnet; the testnet stack until 2026-10-17)',
  '0254bf718a67aa0b7a88665f3d514bd45b605859337f95a39c790b1d81bace3526': 'abandon x11 about',
  '03919e5692b45537bdc76e34555e66f4a9bae9f4b938649bbf0f16dbda1f3f4b08': 'test x11 junk',
  '0236d15e0699f885ea79e3f04f5f43f440eaaebd965f2811c0e682b8df59436b03': 'zoo x11 wrong',
  '03e395aa8a497607e2c3984d858cfcfe91181e17a78f6a9d43d0c4bc6a02af74cb': 'legal winner thank year … yellow',
};
export const isKnownTestKey = pk => Object.hasOwn(KNOWN_TEST_WALLETS, String(pk || '').replace(/"/g, '').trim().toLowerCase());

// asks the node; exits the process (code 3) when the wallet is a known test wallet and that is not allowed
export async function refuseTestWallet(nodeApi, password, label) {
  const post = async (p, b) => (await (await fetch(nodeApi + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).text()).replace(/"/g, '').trim();
  const pk = await post('/wallet/publickey', { path: "m/44'/258'/0'/0/0", password });
  const address = (await (await fetch(nodeApi + '/wallet/address')).text()).replace(/"/g, '').trim();
  if (!isKnownTestKey(pk)) return;
  const mainnet = address.startsWith('zen1');
  const why = `${label}: the node wallet is the public test phrase "${KNOWN_TEST_WALLETS[pk.toLowerCase()]}": anyone can derive its keys`;
  if (!mainnet && process.env.ZP_ALLOW_TEST_KEYS === '1') { console.error(`WARNING ${why} (allowed by ZP_ALLOW_TEST_KEYS=1, testnet only)`); return; }
  console.error(`${why}. Refused${mainnet ? ' (mainnet: never allowed)' : '; make a wallet of its own (docs/DEPLOY.md, "The node wallet")'}.`);
  process.exit(3);
}

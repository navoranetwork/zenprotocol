// Refuses (exit 3) a node wallet made from a public test phrase (site/known-wallets.mjs). For services that are not
// Node programs (the oracle): run it before them.  usage: node scripts/check-wallet.mjs [node api] [password] [label]
import { refuseTestWallet } from '../site/known-wallets.mjs';
await refuseTestWallet(process.argv[2] || 'http://127.0.0.1:31567', process.argv[3] || process.env.TESTNET_PASSWORD || 'testnet', process.argv[4] || 'service');

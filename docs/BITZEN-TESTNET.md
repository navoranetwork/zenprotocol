# BitZen on the testnet: "Bitcoin in ZP"

A ZP testnet contract that follows Bitcoin's main chain by itself (the BitZen header chain contract, tests T1-T4 in
the BitZen repository), a relayer that feeds it Bitcoin headers, and a page on the testnet site (/bitzen.html).

| Piece | Where |
|---|---|
| Contract | `BitcoinHeaderChainFork.fst` (BitZen repository): commands `add` (next header) and `reorg` (a branch of up to 6 headers inside one difficulty period); cost 13,735 per call |
| Node API | `GET /contract/state?address=<contract address>`: the contract's state in the last block (this branch) |
| Relayer | `site/bitzen/relayer.mjs`, service `bitzen` in `docker-compose.testnet-stack.yml`; writes `bitzen.json` |
| Page | `site/bitzen.html` (Explore menu: "Bitcoin in ZP"), published by `site/setup-testnet-web.sh` |

The relayer only carries headers: the contract checks each one (proof of work, difficulty and retarget, links, the
longer branch), so a wrong header is refused. One call at a time, each waits for its block (two calls on one contract
in the mempool at once hit the template bug fixed in docs/MEMPOOL-CONTRACT-ORDER.md; the node must have that fix).

## Deployment on the testnet server (91.98.3.17)
Needs the node built from a commit that has both the mempool fix and `/contract/state`.

1. Node: build and start the testnet node image from that commit (see the node upgrade steps).
2. Activate the contract (F* verifies it: about 30-40 minutes). From a zenprotocol checkout with the contract copied
   into `src/ContractExamples/`:
   `CONTRACT=src/ContractExamples/BitcoinHeaderChainFork.fst EXECUTE=0 NUMBLOCKS=20000 RLIMIT=80000000 bash scripts/testnet-contract.sh http://127.0.0.1:31567 testnet`
   It prints `CONTRACT_ADDRESS=ctzn1…`.
3. `echo BITZEN_CONTRACT=ctzn1… >> testnet-stack.env` and `docker compose -f docker-compose.testnet-stack.yml up -d bitzen`.
   The first call is the checkpoint (6 blocks below Bitcoin's tip), then one header per call until the tip.
4. `bash site/setup-testnet-web.sh` publishes the page and copies `bitzen.json` every minute.
5. Extend the contract before its expiry (the page warns 2,000 blocks ahead).

Logs: `docker compose -f docker-compose.testnet-stack.yml logs -f bitzen`. Status: `/bitzen.json`.

## After the testnet's V1 fork (block 2050): the V1 contracts, the swap and the prover

The V1 contracts (navoranetwork/bitzen `contracts/v1/`): `BitZenChain` (header chain with batches of up to 6 headers,
payment proof `pay`) and `BitZenSwap` (ZP for bitcoin: offer, reserve, paid, cancel). A V1 activation is built by
every node in seconds (no Z3), so it does not block the node's API as the V0 one did.

1. On the testnet server, once `/blockchain/info` shows block 2050 or later:
   `cd ~/bitzen && git pull -q && node scripts/testnet-v1-deploy.mjs http://127.0.0.1:31567 testnet`
   It activates both contracts, initialises the swap with the chain contract and prints four lines.
2. Put them in `~/zenprotocol-testnet/testnet-stack.env` (`BITZEN_CONTRACT` replaces the V0 contract's address;
   `BITZEN_BATCH=6`; `PROVER_CHAIN`, `PROVER_SWAP`), delete the relayer's state so it starts with a new checkpoint
   (`docker compose -f docker-compose.testnet-stack.yml run --rm --entrypoint rm bitzen -f /data/bitzen-relayer.json`),
   then `docker compose -f docker-compose.testnet-stack.yml up -d bitzen` and
   `docker compose -f docker-compose.testnet-stack.yml --profile v1 up -d prover` (the prover is in the `v1` profile;
   never `down -v`, never `--remove-orphans`).
3. The V0 header chain contract stops getting headers; it expires by itself (about block 21,600).
4. The prover logs each reserved offer it watches and each proof it sends:
   `docker compose -f docker-compose.testnet-stack.yml logs -f prover`.

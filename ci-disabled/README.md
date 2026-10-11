# Workflows kept out of GitHub Actions

GitHub's terms do not allow cryptocurrency mining on Actions runners, and its automatic detection does not tell a test
from real mining: Actions was disabled for this account on 2026-10-11 after workflows ran a miner. So nothing that mines
runs on GitHub, not even a private devnet or testnet whose node mines blocks for a test. GitHub ignores this folder.
Run these on your own server with Docker instead.

| File | What it tested | Run it yourself |
|---|---|---|
| `cgp-devnet.yml` | a whole CGP cycle on a one-node devnet (the miner creates the payout), and the relay mode | `bash scripts/cgp-devnet-test.sh miner` or `relay` |
| `testnet.yml` | two testnet nodes from the new genesis, the miner, the wallet and the CGP contracts | the steps of the file on a Docker host (`docker build -f Docker/Dockerfile.net10 ...`), or the public testnet itself |
| GPU miner check (was the `miner` job of `build.yml`) | the OpenCL kernel against Python's SHA3 and a 5 s benchmark | `pip install pyopencl numpy && python miner/zpminer.py selftest && python miner/zpminer.py bench --seconds 5` |

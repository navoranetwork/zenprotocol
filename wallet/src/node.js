// Client for a ZP node's public API (the community node's /node/ path, or a local node).
// Only read-only chain/address endpoints plus publishtransaction are used.

export class NodeError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Reads that may be asked again when the node is busy. Sending and contract execution are never repeated here.
const RETRYABLE = /^\/(blockchain\/(info|cgp|candidates)|addressdb\/|contract\/active)/;

export class NodeClient {
  // retries: how many more times a read is asked when the node did not answer in time or the proxy gave up on it
  // (502/503/504). onRetry is called before each repeat, so the page can say the node is busy; onRecover when a repeat answered.
  constructor(baseUrl, { timeoutMs = 30000, fetchFn, retries = 1, retryDelayMs = 2000, onRetry, onRecover } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.retries = retries; this.retryDelayMs = retryDelayMs; this.onRetry = onRetry; this.onRecover = onRecover;
    this.fetch = fetchFn || ((...a) => globalThis.fetch(...a));   // unbound window.fetch throws "Illegal invocation"
  }

  async request(path, body) {
    for (let attempt = 0; ; attempt++) {
      try { const r = await this.once(path, body); if (attempt) this.onRecover?.(path); return r; }
      catch (e) {
        const busy = e instanceof NodeError && (e.busy || [502, 503, 504].includes(e.status));
        if (!busy || attempt >= this.retries || !RETRYABLE.test(path)) {
          if (busy && e.busy) e.message = 'The node is busy and did not answer in time. Try again in a minute.';
          throw e;
        }
        this.onRetry?.(path, attempt + 1);
        await new Promise(r => setTimeout(r, this.retryDelayMs));
      }
    }
  }

  async once(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.base + path, body === undefined
        ? { signal: ctrl.signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw e.name === 'AbortError' ? Object.assign(new NodeError('Node did not answer in time', 0), { busy: true }) : new NodeError('Node unreachable', 0);
    } finally { clearTimeout(timer); }
    const text = await res.text();
    if (!res.ok) throw new NodeError(text.replace(/<[^>]*>/g, ' ').trim().slice(0, 200) || `HTTP ${res.status}`, res.status);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  info() { return this.request('/blockchain/info'); }
  cgp() { return this.request('/blockchain/cgp'); }
  // [{asset, balance}] - unspent, includes immature coinbase outputs
  balance(addresses) { return this.request('/addressdb/balance', { addresses }); }
  // [{outpoint:{txHash,index}, lock, spend:{asset,amount}}]
  outputs(addresses) { return this.request('/addressdb/outputs', { addresses, mode: 'unspentOnly' }); }
  // [{txHash, asset, amount (signed string), confirmations, timestamp, lock}]
  history(addresses, skip = 0, take = 50) { return this.request('/addressdb/transactions', { addresses, skip, take }); }
  // [{address, hasBalance, hasTxs}]
  discovery(addresses) { return this.request('/addressdb/discovery', { addresses, full: false }); }
  // [{contractId, address, expire, code}]
  activeContracts() { return this.request('/contract/active'); }
  // text/plain hex of the transaction with the contract witness added by the node
  executeContract(body) { return this.request('/blockchain/contract/execute', body); }
  candidates() { return this.request('/blockchain/candidates'); }
  publish(txHex) { return this.request('/blockchain/publishtransaction', { tx: txHex }); }
}

export const DEFAULT_NODES = {
  main: ['https://navora.network/node'],
  test: ['https://testnet.navora.network/node'],
};

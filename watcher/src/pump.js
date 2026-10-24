// Reads which X account a pump.fun wallet has linked, and who follows a profile, through
// pump.fun's own (unofficial, undocumented) web API. Endpoints come from the 2026-06-17 capture
// of https://github.com/BankkRoll/pumpfun-apis:
//   POST /x/public-handles  {addresses:[...]} -> { <address>: { handle, verified } }
//   GET  /users/<address>                      -> { ..., x_username, x_id }
//   GET  /following/followers/<address>        -> [ { address, username, timestamp, ... } ]

const PROBE_ADDRESS = '11111111111111111111111111111111';

export class RetryableError extends Error {}

const BROWSER_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

// Profile lists (followers, following): a bare array or one wrapped in an object.
export function parseProfileList(body) {
  const list = Array.isArray(body) ? body : body?.followers ?? body?.data ?? body?.items ?? body?.users ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map(e => ({ address: e?.address ?? e?.wallet ?? e?.user ?? e?.follower ?? e?.userId, timestamp: e?.timestamp ?? e?.created_at ?? null }))
    .filter(e => typeof e.address === 'string' && e.address.length >= 32);
}

// Accepts both the observed object shape and an array shape, in case pump.fun changes it.
export function parsePublicHandles(body) {
  const out = new Map();
  const add = (address, v) => {
    const handle = typeof v === 'string' ? v : v?.handle ?? v?.x_username ?? v?.username;
    if (address && handle) out.set(address, { handle: String(handle).replace(/^@/, ''), verified: !!v?.verified });
  };
  if (Array.isArray(body)) for (const v of body) add(v?.address ?? v?.wallet, v);
  else if (body && typeof body === 'object') for (const [address, v] of Object.entries(body)) add(address, v);
  return out;
}

export class PumpClient {
  constructor({ hosts, jwt = '', concurrency = 4, fetchImpl = fetch, log = console.log, timeoutMs = 10_000 }) {
    this.hosts = hosts;
    this.jwt = jwt;
    this.concurrency = concurrency;
    this.fetch = fetchImpl;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.batchHost = null;
    this.usersHost = hosts[0];
    this.probedAt = 0;
    this.reprobeMs = 10 * 60_000;
  }

  get mode() {
    return this.batchHost ? 'batch' : 'single';
  }

  async request(url, init = {}) {
    const headers = { ...BROWSER_HEADERS };
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const res = await this.fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status} ${url}`);
    return res;
  }

  // Finds a host that answers /x/public-handles; otherwise falls back to one /users call per wallet.
  async init() {
    this.probedAt = Date.now();
    for (const host of this.hosts) {
      try {
        const res = await this.request(`${host}/x/public-handles`, {
          method: 'POST',
          body: JSON.stringify({ addresses: [PROBE_ADDRESS] }),
        });
        if (res.ok) {
          await res.json();
          this.batchHost = host;
          this.log(`[pump] mode batch via ${host}/x/public-handles`);
          return;
        }
        this.log(`[pump] ${host}/x/public-handles -> HTTP ${res.status}`);
      } catch (e) {
        this.log(`[pump] ${host}/x/public-handles -> ${e.message}`);
      }
    }
    this.log(`[pump] mode single via ${this.usersHost}/users/<wallet> (plus lent)`);
  }

  // Returns Map(address -> {handle, verified} | null). Throws RetryableError on 429/5xx/network errors.
  async lookup(addresses) {
    if (!this.batchHost && Date.now() - this.probedAt > this.reprobeMs) await this.init();
    try {
      return this.batchHost ? await this.lookupBatch(addresses) : await this.lookupSingle(addresses);
    } catch (e) {
      if (e instanceof RetryableError) throw e;
      throw new RetryableError(e.message);
    }
  }

  async lookupBatch(addresses) {
    const res = await this.request(`${this.batchHost}/x/public-handles`, {
      method: 'POST',
      body: JSON.stringify({ addresses }),
    });
    if (!res.ok) {
      this.log(`[pump] /x/public-handles -> HTTP ${res.status}, passage en mode single`);
      this.batchHost = null;
      return this.lookupSingle(addresses);
    }
    const found = parsePublicHandles(await res.json());
    return new Map(addresses.map(a => [a, found.get(a) ?? null]));
  }

  async lookupSingle(addresses) {
    const out = new Map();
    let i = 0;
    const worker = async () => {
      while (i < addresses.length) {
        const address = addresses[i++];
        out.set(address, await this.user(address));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, addresses.length) }, worker));
    return out;
  }

  // Who follows a profile, as its Followers tab shows. The first host that answers is kept.
  async followers(address) {
    let status = 0;
    for (const host of this.followersHost ? [this.followersHost] : this.hosts) {
      const res = await this.request(`${host}/following/followers/${address}`);
      if (res.status === 404 && !this.followersHost) {
        status = 404;
        continue;
      }
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status} /following/followers`);
      this.followersHost = host;
      return parseProfileList(await res.json());
    }
    throw new Error(`HTTP ${status} /following/followers`);
  }

  async user(address) {
    const res = await this.request(`${this.usersHost}/users/${address}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new RetryableError(`HTTP ${res.status} /users`);
    const body = await res.json();
    return body?.x_username ? { handle: String(body.x_username).replace(/^@/, ''), verified: false } : null;
  }
}

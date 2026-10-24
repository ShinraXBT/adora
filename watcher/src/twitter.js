// X follower counts. Providers are tried in order: twitterapi.io (if a key is set),
// the official X API v2 (if a bearer token is set), then the free FxTwitter API.

export class TwitterClient {
  constructor({ twitterApiIoKey = '', xBearerToken = '', fetchImpl = fetch, cacheTtlMs = 6 * 3600_000, timeoutMs = 8_000, now = Date.now }) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
    this.providers = [];
    if (twitterApiIoKey) this.providers.push(['twitterapi.io', h => this.twitterApiIo(h, twitterApiIoKey)]);
    if (xBearerToken) this.providers.push(['x-api', h => this.xApi(h, xBearerToken)]);
    this.providers.push(['fxtwitter', h => this.fxTwitter(h)]);
  }

  // Returns {followers, name, verified, source} or null when no provider answered.
  async profile(handle) {
    const key = handle.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheTtlMs) return hit.value;
    for (const [source, get] of this.providers) {
      try {
        const value = await get(handle);
        if (value && Number.isFinite(value.followers)) {
          const result = { ...value, source };
          this.cache.set(key, { at: this.now(), value: result });
          return result;
        }
      } catch {
        // try the next provider
      }
    }
    return null;
  }

  async getJson(url, headers = {}) {
    const res = await this.fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async fxTwitter(handle) {
    const body = await this.getJson(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`);
    const u = body?.user;
    if (!u) return null;
    return { followers: u.followers, name: u.name, verified: !!u.verification?.verified };
  }

  async twitterApiIo(handle, key) {
    const body = await this.getJson(`https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(handle)}`, { 'x-api-key': key });
    const u = body?.data;
    if (!u) return null;
    return { followers: u.followers, name: u.name, verified: !!(u.isBlueVerified || u.isVerified) };
  }

  async xApi(handle, token) {
    const body = await this.getJson(
      `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,verified`,
      { authorization: `Bearer ${token}` },
    );
    const u = body?.data;
    if (!u) return null;
    return { followers: u.public_metrics?.followers_count, name: u.name, verified: !!u.verified };
  }
}

// X follower counts. The free FxTwitter API is tried first; twitterapi.io and the official
// X API v2 (paid per request) are only used as fallbacks when their credentials are set.

export class TwitterClient {
  constructor({
    twitterApiIoKey = '',
    xBearerToken = '',
    xApiKey = '',
    xApiSecret = '',
    fetchImpl = fetch,
    cacheTtlMs = 6 * 3600_000,
    timeoutMs = 8_000,
    now = Date.now,
  }) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
    this.xBearerToken = xBearerToken;
    this.xApiKey = xApiKey;
    this.xApiSecret = xApiSecret;
    this.providers = [['fxtwitter', h => this.fxTwitter(h)]];
    if (twitterApiIoKey) this.providers.push(['twitterapi.io', h => this.twitterApiIo(h, twitterApiIoKey)]);
    if (xBearerToken || (xApiKey && xApiSecret)) this.providers.push(['x-api', h => this.xApi(h)]);
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
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
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

  // App-only bearer token from the API Key + API Key Secret, cached as X asks.
  // https://docs.x.com/fundamentals/authentication/oauth-2-0/bearer-tokens
  async xToken(refresh = false) {
    if (this.xBearerToken && !refresh) return this.xBearerToken;
    if (!this.xApiKey || !this.xApiSecret) return this.xBearerToken;
    const basic = Buffer.from(`${encodeURIComponent(this.xApiKey)}:${encodeURIComponent(this.xApiSecret)}`).toString('base64');
    const res = await this.fetch('https://api.x.com/oauth2/token', {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`oauth2/token HTTP ${res.status}`);
    this.xBearerToken = (await res.json()).access_token;
    return this.xBearerToken;
  }

  async xApi(handle, retried = false) {
    const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,verified`;
    let body;
    try {
      body = await this.getJson(url, { authorization: `Bearer ${await this.xToken()}` });
    } catch (e) {
      // A revoked bearer token can be replaced when the API key and secret are known.
      if (e.status === 401 && !retried && this.xApiKey && this.xApiSecret) {
        await this.xToken(true);
        return this.xApi(handle, true);
      }
      throw e;
    }
    const u = body?.data;
    if (!u) return null;
    return { followers: u.public_metrics?.followers_count, name: u.name, verified: !!u.verified };
  }
}

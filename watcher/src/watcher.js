// Core logic: queues wallets seen on pump.fun, asks pump.fun which X account each one has
// linked, and alerts on watchlisted handles or on accounts above the follower threshold.
// X accounts verified on-chain by a fee claim are handled right away, and a patrol keeps
// re-checking idle wallets seen without X.

import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, SOCIAL_PLATFORM_X } from './decode.js';

const IGNORED = new Set(['11111111111111111111111111111111', PUMP_PROGRAM, PUMP_AMM_PROGRAM]);

export function normalizeHandle(h) {
  return String(h ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();
}

const freshStats = () => ({ observed: 0, checked: 0, linked: 0, claims: 0, patrolled: 0, alerts: 0, dropped: 0 });

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms, null).unref?.())]);

export class Watcher {
  constructor({ pump, twitter, notifier, store, options = {}, log = console.log, now = Date.now }) {
    this.pump = pump;
    this.twitter = twitter;
    this.notifier = notifier;
    this.store = store;
    this.log = log;
    this.now = now;
    this.seen = new Map(); // wallet -> { at, handle } (LRU)
    this.high = new Map(); // wallet -> ctx, coin creators: checked first
    this.low = new Map(); // wallet -> ctx, traders
    this.busy = new Set();
    this.inflightWallets = new Set();
    this.watchIds = new Map(); // numeric X id -> watched handle
    this.inflight = 0;
    this.failures = 0;
    this.paused = false;
    this.timer = null;
    this.stats = freshStats();
    this.setOptions(options);
  }

  setOptions(options) {
    const previous = this.watch;
    this.opts = {
      batchSize: 50,
      parallel: 2,
      flushMs: 300,
      recheckMs: 5 * 60_000,
      linkedRecheckMs: 6 * 3600_000,
      followersRefreshMs: 7 * 86400_000,
      watchFollowersTimeoutMs: 2500,
      profileRetryMs: 60_000,
      retryBaseMs: 1000,
      maxQueue: 20_000,
      maxSeen: 300_000,
      patrolMinAgeMs: 2 * 60_000,
      ...options,
    };
    this.watch = new Set((options.watchHandles ?? []).map(normalizeHandle).filter(Boolean));
    this.minFollowers = Number(options.minFollowers) || 0;
    if (previous) for (const h of this.watch) if (!previous.has(h)) this.alertKnown(h);
    for (const [id, key] of this.watchIds) if (!this.watch.has(key)) this.watchIds.delete(id);
  }

  // Learns the numeric X id of each watched handle: fee claims only carry the id, and the id
  // survives a handle change.
  async resolveWatchIds() {
    for (const [id, key] of this.store.xIdEntries()) if (this.watch.has(key)) this.watchIds.set(id, key);
    const known = new Set(this.watchIds.values());
    for (const key of this.watch) {
      if (known.has(key)) continue;
      const p = await this.twitter.profile(key).catch(() => null);
      if (!p?.id) continue;
      this.watchIds.set(String(p.id), key);
      this.store.setXId(String(p.id), key);
    }
  }

  observe(wallet, ctx = {}, priority = false) {
    if (!wallet || IGNORED.has(wallet)) return;
    this.stats.observed++;
    const s = this.seen.get(wallet);
    if (s && this.now() - s.at < (s.handle ? this.opts.linkedRecheckMs : this.opts.recheckMs)) return;
    if (this.high.has(wallet) || this.inflightWallets.has(wallet)) return;
    if (this.low.has(wallet)) {
      if (!priority) return;
      this.low.delete(wallet);
    }
    (priority ? this.high : this.low).set(wallet, ctx);
    if (this.low.size > this.opts.maxQueue) {
      this.low.delete(this.low.keys().next().value);
      this.stats.dropped++;
    }
    this.schedule();
  }

  get queued() {
    return this.high.size + this.low.size;
  }

  schedule() {
    if (!this.queued) return;
    if ((this.high.size || this.queued >= this.opts.batchSize) && this.inflight < this.opts.parallel) return this.drain();
    if (!this.timer) this.timer = setTimeout(() => this.drain(), this.opts.flushMs);
  }

  drain() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.paused) return;
    while (this.inflight < this.opts.parallel && this.queued) {
      const batch = this.take(this.opts.batchSize);
      this.inflight++;
      this.process(batch)
        .catch(e => this.log(`[watcher] ${e.stack ?? e}`))
        .finally(() => {
          this.inflight--;
          this.schedule();
        });
    }
  }

  take(n) {
    const batch = [];
    for (const [queue, priority] of [[this.high, true], [this.low, false]]) {
      for (const [wallet, ctx] of queue) {
        if (batch.length >= n) break;
        queue.delete(wallet);
        batch.push({ wallet, ctx, priority });
      }
    }
    return batch;
  }

  async process(batch) {
    let found;
    for (const b of batch) this.inflightWallets.add(b.wallet);
    try {
      found = await this.pump.lookup(batch.map(b => b.wallet));
      this.failures = 0;
    } catch (e) {
      this.failures++;
      const delay = Math.min(60_000, this.opts.retryBaseMs * 2 ** Math.min(this.failures, 6));
      this.paused = true;
      setTimeout(() => {
        this.paused = false;
        this.schedule();
      }, delay);
      this.log(`[pump] ${e.message}, nouvel essai dans ${delay / 1000}s`);
      for (const { wallet, ctx, priority } of batch) {
        if (!this.high.has(wallet) && !this.low.has(wallet)) (priority ? this.high : this.low).set(wallet, ctx);
      }
      return;
    } finally {
      for (const b of batch) this.inflightWallets.delete(b.wallet);
    }
    this.stats.checked += batch.length;
    const at = this.now();
    for (const { wallet, ctx } of batch) {
      const info = found.get(wallet) ?? null;
      const prev = this.seen.get(wallet);
      this.remember(wallet, { at, handle: info?.handle ?? null });
      if (info) this.onLinked(wallet, info, ctx, prev).catch(e => this.log(`[watcher] ${e.stack ?? e}`));
    }
  }

  remember(wallet, value) {
    this.seen.delete(wallet);
    this.seen.set(wallet, value);
    if (this.seen.size > this.opts.maxSeen) this.seen.delete(this.seen.keys().next().value);
  }

  // A fee claim proves on-chain that this X id was just verified by pump.fun for this wallet.
  async onSocialClaim({ userId, platform, recipient }, signature) {
    if (platform !== SOCIAL_PLATFORM_X || !userId || !recipient) return;
    this.stats.claims++;
    const id = String(userId);
    let key = this.watchIds.get(id) ?? this.store.keyForXId(id);
    let handle = key && (this.store.get(key)?.handle ?? key);
    let profile = null;
    if (!key) {
      profile = await this.twitter.profileById(id).catch(() => null);
      handle = profile?.handle;
    }
    if (!handle) {
      const found = await this.pump.lookup([recipient]).catch(() => null);
      handle = found?.get(recipient)?.handle;
    }
    key = normalizeHandle(handle);
    if (!key) return this.log(`[claim] X id ${id} -> ${recipient}: @ introuvable`);
    this.store.setXId(id, key);
    const prev = this.seen.get(recipient);
    this.remember(recipient, { at: this.now(), handle });
    await this.onLinked(recipient, { handle, verified: true }, { type: 'social-claim', signature }, prev, profile);
  }

  // Re-checks wallets seen without X, least recently checked first, so a link is caught even
  // when the wallet stays idle.
  patrol(n = this.opts.batchSize) {
    if (this.paused || this.queued >= this.opts.batchSize) return 0;
    const cutoff = this.now() - this.opts.patrolMinAgeMs;
    let added = 0;
    for (const [wallet, s] of this.seen) {
      if (added >= n || s.at > cutoff) break; // `seen` is ordered by last check
      if (s.handle || this.low.has(wallet) || this.high.has(wallet) || this.inflightWallets.has(wallet)) continue;
      this.low.set(wallet, { type: 'patrol' });
      added++;
    }
    this.stats.patrolled += added;
    if (added) this.schedule();
    return added;
  }

  async onLinked(wallet, info, ctx, prev, profile = null) {
    const key = normalizeHandle(info.handle);
    if (!key) return;
    this.stats.linked++;
    const rec = this.store.get(key) ?? { handle: info.handle, wallets: [], firstSeen: this.now(), notified: {} };
    rec.handle = info.handle;
    rec.verifiedOnPump = !!info.verified;
    rec.lastSeen = this.now();
    if (!rec.wallets.includes(wallet)) rec.wallets.push(wallet);
    if (profile && Number.isFinite(profile.followers)) {
      rec.profile = { followers: profile.followers, name: profile.name, verified: profile.verified };
      rec.profileAt = this.now();
    }
    this.store.set(key, rec);
    // Seen earlier in this run without this handle: the link happened while we were watching.
    const justLinked = !!prev && normalizeHandle(prev.handle) !== key;
    await this.evaluate(key, wallet, ctx, justLinked);
  }

  async evaluate(key, wallet, ctx, justLinked, attempt = 0) {
    if (this.busy.has(key)) return;
    const rec = this.store.get(key);
    const watched = this.watch.has(key) && !rec.notified.watchlist;
    const needFollowers = this.minFollowers > 0 && !rec.notified.followers;
    if (!watched && !needFollowers) return;
    this.busy.add(key);
    try {
      let profile = rec.profile ?? null;
      if (!profile || this.now() - (rec.profileAt ?? 0) > this.opts.followersRefreshMs) {
        const lookup = this.twitter.profile(rec.handle).catch(() => null);
        const fresh = await (watched ? withTimeout(lookup, this.opts.watchFollowersTimeoutMs) : lookup);
        if (fresh) {
          profile = { followers: fresh.followers, name: fresh.name, verified: fresh.verified };
          rec.profile = profile;
          rec.profileAt = this.now();
          this.store.set(key, rec);
        } else if (!watched && attempt < 3) {
          const retry = () => this.evaluate(key, wallet, ctx, justLinked, attempt + 1).catch(e => this.log(`[watcher] ${e.stack ?? e}`));
          setTimeout(retry, this.opts.profileRetryMs).unref?.();
        }
      }
      // The handle may have been added to the watchlist (and alerted) during the lookup.
      if (!watched && rec.notified.followers) return;
      const reasons = [];
      if (watched) reasons.push('watchlist');
      if (needFollowers && profile && profile.followers >= this.minFollowers) reasons.push('followers');
      if (!reasons.length) return;
      const at = this.now();
      if (watched) rec.notified.watchlist = at;
      rec.notified.followers = at; // a watchlist alert already covers the follower alert
      this.store.set(key, rec);
      this.stats.alerts++;
      await this.notifier.send({ handle: rec.handle, wallet, reasons, profile, ctx, justLinked });
    } finally {
      this.busy.delete(key);
    }
  }

  // A handle just added to the watchlist may already be known from earlier sightings.
  alertKnown(key) {
    const rec = this.store.get(key);
    if (!rec || rec.notified.watchlist) return;
    rec.notified.watchlist = this.now();
    rec.notified.followers ??= this.now();
    this.store.set(key, rec);
    this.stats.alerts++;
    this.notifier
      .send({ handle: rec.handle, wallet: rec.wallets.at(-1), reasons: ['watchlist', 'already-known'], profile: rec.profile ?? null, ctx: {} })
      .catch(e => this.log(`[notify] ${e.message}`));
  }

  takeStats() {
    const s = { ...this.stats, queued: this.queued, known: this.store.size };
    this.stats = freshStats();
    return s;
  }
}

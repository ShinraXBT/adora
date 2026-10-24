// Social side of the pump.fun app: new accounts start by following people. Polls the Followers
// list of seed profiles (the biggest X accounts already found, plus configured wallets) and has
// every new follower's profile checked right away.

const shortWallet = w => `${w.slice(0, 4)}…${w.slice(-4)}`;

export class SocialGraph {
  constructor({ pump, watcher, store, seedWallets = [], autoSeeds = 20, maxKnown = 200_000, log = console.log }) {
    this.pump = pump;
    this.watcher = watcher;
    this.store = store;
    this.seedWallets = seedWallets;
    this.autoSeeds = autoSeeds;
    this.maxKnown = maxKnown;
    this.log = log;
    this.known = new Map(); // seed wallet -> Set of follower wallets already seen
    this.errors = new Map(); // seed wallet -> last error logged
    this.running = false;
    this.fresh = 0;
  }

  // Configured wallets first, then the wallets of the most followed X accounts found so far.
  seeds() {
    const seeds = new Map(this.seedWallets.map(w => [w, shortWallet(w)]));
    const top = this.store
      .records()
      .filter(r => r.wallets?.length && Number.isFinite(r.profile?.followers))
      .sort((a, b) => b.profile.followers - a.profile.followers)
      .slice(0, this.autoSeeds);
    for (const r of top) if (!seeds.has(r.wallets.at(-1))) seeds.set(r.wallets.at(-1), `@${r.handle}`);
    return seeds;
  }

  async poll(wallet, label) {
    const list = await this.pump.followers(wallet);
    let known = this.known.get(wallet);
    const first = !known;
    if (first) this.known.set(wallet, (known = new Set()));
    let fresh = 0;
    for (const { address } of list) {
      if (known.has(address)) continue;
      if (known.size >= this.maxKnown) known.delete(known.values().next().value);
      known.add(address);
      // Existing followers join the patrol pool; followers who appear later are checked at once.
      if (first) this.watcher.observe(address, { type: 'social' });
      else {
        fresh++;
        this.watcher.observe(address, { type: 'follow', seed: label }, true);
      }
    }
    return { total: list.length, fresh, first };
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const [wallet, label] of this.seeds()) {
        try {
          const r = await this.poll(wallet, label);
          if (r.first) this.log(`[social] ${label}: ${r.total} followers chargés, nouveaux followers surveillés`);
          this.fresh += r.fresh;
          this.errors.delete(wallet);
        } catch (e) {
          if (this.errors.get(wallet) !== e.message) this.log(`[social] ${label}: ${e.message}`);
          this.errors.set(wallet, e.message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  takeFresh() {
    const n = this.fresh;
    this.fresh = 0;
    return n;
  }
}

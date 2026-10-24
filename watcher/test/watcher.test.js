import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetryableError } from '../src/pump.js';
import { Store } from '../src/store.js';
import { normalizeHandle, Watcher } from '../src/watcher.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function setup({ linked = {}, followers = {}, options = {}, pumpFailures = 0, twitterDelayMs = 0 } = {}) {
  let clock = 1_000_000;
  const alerts = [];
  const lookups = [];
  let failures = pumpFailures;
  const pump = {
    async lookup(addresses) {
      lookups.push(addresses);
      if (failures-- > 0) throw new RetryableError('HTTP 429');
      return new Map(addresses.map(a => [a, linked[a] ? { handle: linked[a], verified: true } : null]));
    },
  };
  const twitter = {
    async profile(handle) {
      if (twitterDelayMs) await tick(twitterDelayMs);
      const n = followers[handle.toLowerCase()];
      return n == null ? null : { followers: n, name: handle, verified: false, source: 'fake' };
    },
  };
  const notifier = { send: async a => void alerts.push(a) };
  const watcher = new Watcher({
    pump,
    twitter,
    notifier,
    store: new Store(null),
    options: { minFollowers: 100_000, flushMs: 1, retryBaseMs: 5, watchFollowersTimeoutMs: 50, ...options },
    log: () => {},
    now: () => clock,
  });
  return { watcher, alerts, lookups, linked, advance: ms => (clock += ms) };
}

async function settle(watcher) {
  for (let i = 0; i < 100; i++) {
    await tick(2);
    if (!watcher.queued && !watcher.inflight && !watcher.busy.size) return;
  }
  throw new Error('watcher did not settle');
}

test('normalizes handles from @, URLs and casing', () => {
  assert.equal(normalizeHandle('@Naseem'), 'naseem');
  assert.equal(normalizeHandle('https://x.com/Naseem/status/1'), 'naseem');
  assert.equal(normalizeHandle(' twitter.com/foo '), 'foo');
  assert.equal(normalizeHandle('https://twitter.com/foo?s=20'), 'foo');
});

test('alerts when a watchlisted handle shows up, with its follower count', async () => {
  const { watcher, alerts } = setup({ linked: { W1: 'Naseem' }, followers: { naseem: 4200 }, options: { watchHandles: ['@naseem'] } });
  watcher.observe('W1', { type: 'buy', mint: 'M1', sol: 0.5 });
  await settle(watcher);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].reasons, ['watchlist']);
  assert.equal(alerts[0].handle, 'Naseem');
  assert.equal(alerts[0].profile.followers, 4200);
  assert.equal(alerts[0].ctx.mint, 'M1');
});

test('alerts on accounts above the follower threshold only', async () => {
  const { watcher, alerts } = setup({ linked: { A: 'bigkol', B: 'smallkol' }, followers: { bigkol: 150_000, smallkol: 5_000 } });
  watcher.observe('A');
  watcher.observe('B');
  await settle(watcher);
  assert.deepEqual(alerts.map(a => [a.handle, a.reasons]), [['bigkol', ['followers']]]);
});

test('sends one alert per handle, across rechecks and multiple wallets', async () => {
  const { watcher, alerts, advance } = setup({ linked: { A: 'bigkol', A2: 'BigKol' }, followers: { bigkol: 150_000 } });
  watcher.observe('A');
  await settle(watcher);
  advance(7 * 3600_000);
  watcher.observe('A');
  watcher.observe('A2');
  await settle(watcher);
  assert.equal(alerts.length, 1);
});

test('does not recheck an unlinked wallet before the cooldown', async () => {
  const { watcher, lookups, advance } = setup({ options: { recheckMs: 60_000 } });
  watcher.observe('W');
  await settle(watcher);
  watcher.observe('W');
  await settle(watcher);
  assert.equal(lookups.flat().length, 1);
  advance(61_000);
  watcher.observe('W');
  await settle(watcher);
  assert.equal(lookups.flat().length, 2);
});

test('flags a wallet that links its X while being watched', async () => {
  const { watcher, alerts, linked, advance } = setup({ followers: { naseem: 10 }, options: { watchHandles: ['naseem'], recheckMs: 60_000 } });
  watcher.observe('W');
  await settle(watcher);
  assert.equal(alerts.length, 0);
  linked.W = 'naseem';
  advance(61_000);
  watcher.observe('W', { type: 'create', symbol: 'NSM', mint: 'M' }, true);
  await settle(watcher);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].justLinked, true);
  assert.equal(alerts[0].ctx.symbol, 'NSM');
});

test('alerts right away when a handle already seen is added to the watchlist', async () => {
  const { watcher, alerts } = setup({ linked: { W: 'friend' }, followers: { friend: 300 } });
  watcher.observe('W');
  await settle(watcher);
  assert.equal(alerts.length, 0);
  watcher.setOptions({ watchHandles: ['friend'], minFollowers: 100_000, flushMs: 1 });
  await tick(5);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].reasons, ['watchlist', 'already-known']);
  assert.equal(alerts[0].wallet, 'W');
});

test('retries a batch after a pump.fun rate limit', async () => {
  const { watcher, alerts, lookups } = setup({ linked: { A: 'bigkol' }, followers: { bigkol: 200_000 }, pumpFailures: 2 });
  watcher.observe('A');
  await settle(watcher);
  assert.equal(lookups.length, 3);
  assert.equal(alerts.length, 1);
});

test('does not hold a watchlist alert for a slow follower lookup', async () => {
  const { watcher, alerts } = setup({ linked: { W: 'naseem' }, followers: { naseem: 1 }, twitterDelayMs: 500, options: { watchHandles: ['naseem'] } });
  watcher.observe('W');
  await settle(watcher);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].profile, null);
});

test('checks coin creators before traders', async () => {
  const { watcher, lookups } = setup({ options: { batchSize: 2, parallel: 1, flushMs: 50 } });
  watcher.observe('T1');
  watcher.observe('C1', {}, true);
  await settle(watcher);
  assert.equal(lookups[0][0], 'C1');
});

test('does not look up a wallet again while its lookup is in flight', async () => {
  const { watcher, lookups } = setup();
  const slow = watcher.pump.lookup;
  watcher.pump.lookup = async addresses => {
    await tick(30);
    return slow(addresses);
  };
  watcher.observe('W');
  await tick(5);
  watcher.observe('W');
  await settle(watcher);
  assert.equal(lookups.flat().length, 1);
});

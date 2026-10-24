import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMessage } from '../src/notify.js';
import { parseProfileList, PumpClient } from '../src/pump.js';
import { SocialGraph } from '../src/social.js';
import { Store } from '../src/store.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const W = n => `${n}`.padEnd(44, 'x');

test('parses follower lists in array and wrapped shapes', () => {
  assert.deepEqual(parseProfileList([{ address: W('a'), username: 'a', timestamp: 5 }]), [{ address: W('a'), timestamp: 5 }]);
  assert.deepEqual(parseProfileList({ followers: [{ wallet: W('b') }, { address: 'short' }] }), [{ address: W('b'), timestamp: null }]);
  assert.deepEqual(parseProfileList({ nope: 1 }), []);
});

test('reads followers from the first pump.fun host that has the route', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.startsWith('https://a/')) return json(404, {});
    return json(200, [{ address: W('f1') }]);
  };
  const pump = new PumpClient({ hosts: ['https://a', 'https://b'], fetchImpl, log: () => {} });
  assert.deepEqual(await pump.followers(W('seed')), [{ address: W('f1'), timestamp: null }]);
  assert.equal(pump.followersHost, 'https://b');
  await pump.followers(W('seed2'));
  assert.equal(urls.at(-1), `https://b/following/followers/${W('seed2')}`);
});

function setup(lists) {
  const observed = [];
  const watcher = { observe: (wallet, ctx, priority = false) => observed.push({ wallet, ctx, priority }) };
  const pump = { followers: async wallet => (lists[wallet] ?? []).map(address => ({ address })) };
  const store = new Store(null);
  return { observed, store, social: g => new SocialGraph({ pump, watcher, store, log: () => {}, ...g }) };
}

test('checks new followers of a seed at once, existing ones at normal priority', async () => {
  const lists = { SEED: ['old1', 'old2'] };
  const { observed, social: make } = setup(lists);
  const social = make({ seedWallets: ['SEED'], autoSeeds: 0 });
  await social.tick();
  assert.deepEqual(observed.map(o => [o.wallet, o.ctx.type, o.priority]), [['old1', 'social', false], ['old2', 'social', false]]);
  lists.SEED = ['newbie', 'old1', 'old2'];
  await social.tick();
  assert.deepEqual(observed.at(-1), { wallet: 'newbie', ctx: { type: 'follow', seed: 'SEED…SEED' }, priority: true });
  assert.equal(observed.length, 3);
  assert.equal(social.takeFresh(), 1);
});

test('uses the most followed X accounts found so far as seeds', () => {
  const { store, social: make } = setup({});
  store.set('small', { handle: 'small', wallets: ['WS'], profile: { followers: 10 }, notified: {} });
  store.set('big', { handle: 'Big', wallets: ['WB'], profile: { followers: 900_000 }, notified: {} });
  store.set('nofollowers', { handle: 'x', wallets: ['WX'], notified: {} });
  const seeds = make({ seedWallets: ['MINE'], autoSeeds: 1 }).seeds();
  assert.deepEqual([...seeds], [['MINE', 'MINE…MINE'], ['WB', '@Big']]);
});

test('keeps polling the other seeds when one fails', async () => {
  const { observed, store } = setup({});
  const pump = {
    followers: async wallet => {
      if (wallet === 'BAD') throw new Error('HTTP 401 /following/followers');
      return [{ address: 'f' }];
    },
  };
  const logs = [];
  const social = new SocialGraph({ pump, watcher: { observe: w => observed.push(w) }, store, seedWallets: ['BAD', 'GOOD'], autoSeeds: 0, log: m => logs.push(m) });
  await social.tick();
  await social.tick();
  assert.deepEqual(observed, ['f']);
  assert.equal(logs.filter(l => l.includes('401')).length, 1);
});

test('describes a follow in the alert', () => {
  const msg = buildMessage({ handle: 'naseem', wallet: 'W', reasons: ['watchlist'], profile: null, ctx: { type: 'follow', seed: '@bigkol' }, justLinked: false });
  assert.ok(msg.lines.includes('⚡ vient de suivre @bigkol sur pump.fun'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildMessage, formatFollowers, Notifier } from '../src/notify.js';
import { parsePublicHandles, PumpClient, RetryableError } from '../src/pump.js';
import { TwitterClient } from '../src/twitter.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('parses /x/public-handles in object and array shapes', () => {
  const obj = parsePublicHandles({ W1: { handle: '@Naseem', verified: true }, W2: { handle: null } });
  assert.deepEqual([...obj], [['W1', { handle: 'Naseem', verified: true }]]);
  const arr = parsePublicHandles([{ address: 'W3', x_username: 'foo' }]);
  assert.deepEqual(arr.get('W3'), { handle: 'foo', verified: false });
});

test('uses the first host that answers /x/public-handles', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://a')) return json(404, {});
    const { addresses } = JSON.parse(init.body);
    return json(201, addresses.includes('W1') ? { W1: { handle: 'naseem', verified: true } } : {});
  };
  const pump = new PumpClient({ hosts: ['https://a', 'https://b'], fetchImpl, log: () => {} });
  await pump.init();
  assert.equal(pump.mode, 'batch');
  const found = await pump.lookup(['W1', 'W2']);
  assert.deepEqual(found.get('W1'), { handle: 'naseem', verified: true });
  assert.equal(found.get('W2'), null);
  assert.equal(calls.at(-1), 'https://b/x/public-handles');
});

test('falls back to /users/<wallet> when no batch host works', async () => {
  const fetchImpl = async url => {
    if (url.endsWith('/x/public-handles')) return json(401, {});
    if (url.endsWith('/users/W1')) return json(200, { address: 'W1', x_username: 'naseem', x_id: '1' });
    if (url.endsWith('/users/W2')) return json(200, { address: 'W2', x_username: null });
    return json(404, {});
  };
  const pump = new PumpClient({ hosts: ['https://a'], fetchImpl, log: () => {} });
  await pump.init();
  assert.equal(pump.mode, 'single');
  const found = await pump.lookup(['W1', 'W2', 'W3']);
  assert.equal(found.get('W1').handle, 'naseem');
  assert.equal(found.get('W2'), null);
  assert.equal(found.get('W3'), null);
});

test('reports rate limits as retryable', async () => {
  const pump = new PumpClient({ hosts: ['https://a'], fetchImpl: async () => json(429, {}), log: () => {} });
  await assert.rejects(pump.lookup(['W1']), RetryableError);
});

test('reads follower counts from FxTwitter and caches them', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    assert.equal(url, 'https://api.fxtwitter.com/naseem');
    return json(200, { code: 200, user: { screen_name: 'naseem', name: 'Naseem', followers: 123456, verification: { verified: true } } });
  };
  const tw = new TwitterClient({ fetchImpl });
  assert.deepEqual(await tw.profile('naseem'), { followers: 123456, name: 'Naseem', verified: true, source: 'fxtwitter' });
  await tw.profile('Naseem');
  assert.equal(calls, 1);
});

test('falls back to the next follower provider on failure', async () => {
  const fetchImpl = async url =>
    url.includes('twitterapi.io') ? json(500, {}) : json(200, { user: { name: 'N', followers: 7 } });
  const tw = new TwitterClient({ twitterApiIoKey: 'k', fetchImpl });
  assert.equal((await tw.profile('n')).source, 'fxtwitter');
});

test('formats follower counts', () => {
  assert.equal(formatFollowers(950), '950');
  assert.equal(formatFollowers(12_345), '12.3k');
  assert.equal(formatFollowers(100_000), '100k');
  assert.equal(formatFollowers(1_250_000), '1.3M');
  assert.equal(formatFollowers(undefined), '?');
});

test('builds an alert with links to X, the profile and the coin', () => {
  const msg = buildMessage({
    handle: 'naseem',
    wallet: 'Wallet1111111111111111111111111111',
    reasons: ['watchlist'],
    profile: { followers: 250_000, verified: true, name: 'Naseem' },
    ctx: { type: 'create', symbol: 'NSM', name: 'Naseem', mint: 'Mint111111111111111111111111111', signature: 'sig' },
    justLinked: true,
  });
  assert.match(msg.title, /WATCHLIST · @naseem/);
  assert.ok(msg.lines.some(l => l.includes('250k followers')));
  assert.ok(msg.lines.some(l => l.includes('a créé $NSM')));
  assert.deepEqual(msg.links.map(([k]) => k), ['X', 'Profil pump.fun', 'Coin Mint…1111', 'Tx']);
});

test('sends Telegram, Discord and ntfy alerts', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push([url, JSON.parse(init.body)]);
    return json(200, {});
  };
  const n = new Notifier(
    { telegram: { botToken: 'T', chatId: '42' }, discord: { webhookUrl: 'https://discord.test/hook' }, ntfy: { topic: 'mytopic' } },
    { fetchImpl, log: () => {} },
  );
  await n.send({ handle: 'a<b', wallet: 'W', reasons: ['followers'], profile: { followers: 100_000 }, ctx: {} });
  const [tg, dc, nt] = posts;
  assert.equal(tg[0], 'https://api.telegram.org/botT/sendMessage');
  assert.equal(tg[1].chat_id, '42');
  assert.match(tg[1].text, /@a&lt;b/);
  assert.equal(dc[0], 'https://discord.test/hook');
  assert.equal(nt[0], 'https://ntfy.sh');
  assert.equal(nt[1].topic, 'mytopic');
});

test('merges config with defaults and environment overrides', () => {
  const cfg = loadConfig(null, { TELEGRAM_BOT_TOKEN: 'tok', WATCH_HANDLES: 'a,b', MIN_FOLLOWERS: '50000' });
  assert.equal(cfg.notify.telegram.botToken, 'tok');
  assert.deepEqual(cfg.watchHandles, ['a', 'b']);
  assert.equal(cfg.minFollowers, 50_000);
  assert.equal(cfg.pump.batchSize, 50);
});

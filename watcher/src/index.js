#!/usr/bin/env node
// pump.fun X-link watcher. Usage:
//   node src/index.js                       run the watcher
//   node src/index.js --test-notify         send a test alert to every configured channel
//   node src/index.js --check <wallet>      show the X account linked to a pump.fun wallet
//   node src/index.js --followers <handle>  show an X account's follower count
//     [--via fxtwitter|twitterapi.io|x-api]   ...from one provider only, to test its credentials
//   --config <file>                         config file (default: config.json next to src/)

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, watchConfig, watcherOptions } from './config.js';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from './decode.js';
import { formatFollowers, Notifier } from './notify.js';
import { PumpClient } from './pump.js';
import { pumpPortalSource, solanaSource } from './sources.js';
import { Store } from './store.js';
import { TwitterClient } from './twitter.js';
import { normalizeHandle, Watcher } from './watcher.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

const configFile = resolve(ROOT, arg('--config') ?? 'config.json');
const cfg = loadConfig(configFile);
const twitter = new TwitterClient(cfg.twitter);
const notifier = new Notifier(cfg.notify, { log: console.log });
const pump = new PumpClient({ hosts: cfg.pump.apiHosts, jwt: cfg.pump.jwt, log });

if (args.includes('--test-notify')) {
  if (!notifier.channels.length) console.log('Aucun canal configuré (Telegram, Discord ou ntfy) : alerte affichée en console seulement.');
  await notifier.send({
    handle: 'naseem',
    wallet: '11111111111111111111111111111111',
    reasons: ['watchlist'],
    profile: { followers: 123_456, name: 'Test', verified: true },
    ctx: { type: 'create', symbol: 'TEST', name: 'Alerte de test' },
    justLinked: true,
  });
} else if (arg('--check')) {
  await pump.init();
  const wallet = arg('--check');
  try {
    const info = (await pump.lookup([wallet])).get(wallet);
    if (!info) console.log(`${wallet}: aucun X public lié sur pump.fun`);
    else {
      const p = await twitter.profile(info.handle);
      console.log(`${wallet}: @${info.handle}${info.verified ? ' (vérifié pump.fun)' : ''} · ${p ? `${formatFollowers(p.followers)} followers via ${p.source}` : 'followers inconnus'}`);
    }
  } catch (e) {
    console.log(`pump.fun injoignable: ${e.message}`);
    process.exitCode = 1;
  }
} else if (arg('--followers')) {
  const handle = normalizeHandle(arg('--followers'));
  const via = arg('--via');
  if (via) {
    const provider = twitter.providers.find(([source]) => source === via);
    if (!provider) {
      console.log(`--via ${via}: source inconnue ou identifiants absents de la config (sources: ${twitter.providers.map(([s]) => s).join(', ')})`);
      process.exit(1);
    }
    try {
      const p = await provider[1](handle);
      console.log(p ? `@${handle}: ${p.followers} followers (${p.name}) via ${via}` : `@${handle}: introuvable via ${via}`);
    } catch (e) {
      console.log(`@${handle}: échec via ${via}: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    const p = await twitter.profile(handle);
    console.log(p ? `@${handle}: ${p.followers} followers (${p.name}) via ${p.source}` : `@${handle}: introuvable (compte inexistant ou API X injoignable)`);
  }
} else {
  await run();
}

async function run() {
  const store = new Store(resolve(ROOT, cfg.dataFile), { log });
  await pump.init();
  const watcher = new Watcher({ pump, twitter, notifier, store, options: watcherOptions(cfg), log });

  log(`watchlist: ${[...watcher.watch].map(h => `@${h}`).join(', ') || '(vide)'}`);
  log(`seuil followers: ${cfg.minFollowers ? formatFollowers(cfg.minFollowers) : 'désactivé'}`);
  log(`notifications: console${notifier.channels.map(c => ` + ${c}`).join('')}`);
  log(`comptes X déjà connus: ${store.size}`);
  log(`réclamations de frais X on-chain: ${cfg.solana.socialClaims ? 'surveillées' : 'désactivées'}`);
  log(`patrouille: ${cfg.patrol.walletsPerMinute ? `${cfg.patrol.walletsPerMinute} wallets/min` : 'désactivée'}`);
  const resolveIds = () => watcher.resolveWatchIds().catch(e => log(`[watcher] ids X: ${e.message}`));
  resolveIds();
  if (cfg.solana.wsUrl.includes('api.mainnet-beta.solana.com')) {
    log('⚠️  RPC Solana public : limité et souvent coupé. Mets un RPC Helius/QuickNode (solana.wsUrl) pour du temps réel fiable.');
  }

  const programs = cfg.solana.pumpSwap ? [PUMP_PROGRAM, PUMP_AMM_PROGRAM] : [PUMP_PROGRAM];
  const sources = [
    solanaSource({
      url: cfg.solana.wsUrl,
      httpUrl: cfg.solana.httpUrl,
      programs,
      commitment: cfg.solana.commitment,
      log,
      onSocialClaim: cfg.solana.socialClaims
        ? (claim, signature) => watcher.onSocialClaim(claim, signature).catch(e => log(`[claim] ${e.stack ?? e}`))
        : null,
      onEvents: (events, signature) => {
        for (const ev of events) {
          const ctx = { type: ev.type, mint: ev.mint, symbol: ev.symbol, name: ev.name, sol: ev.sol, signature };
          if (ev.type === 'create') {
            watcher.observe(ev.creator, ctx, true);
            if (ev.user !== ev.creator) watcher.observe(ev.user, ctx, true);
          } else {
            watcher.observe(ev.user, ctx);
            watcher.observe(ev.creator, { type: 'creator', mint: ev.mint, signature });
          }
        }
      },
    }),
  ];
  if (cfg.pumpPortal.enabled) {
    sources.push(
      pumpPortalSource({
        url: cfg.pumpPortal.wsUrl,
        log,
        onCreate: m =>
          watcher.observe(m.traderPublicKey, { type: 'create', mint: m.mint, symbol: m.symbol, name: m.name, signature: m.signature }, true),
      }),
    );
  }

  watchConfig(
    configFile,
    next => {
      watcher.setOptions(watcherOptions(next));
      resolveIds();
      log(`[config] rechargée · watchlist: ${[...watcher.watch].map(h => `@${h}`).join(', ') || '(vide)'} · seuil: ${formatFollowers(next.minFollowers)}`);
    },
    log,
  );

  if (cfg.patrol.walletsPerMinute > 0) {
    const batch = Math.min(cfg.pump.batchSize, cfg.patrol.walletsPerMinute);
    setInterval(() => watcher.patrol(batch), (60_000 * batch) / cfg.patrol.walletsPerMinute).unref();
  }

  setInterval(() => {
    const s = watcher.takeStats();
    log(
      `[stats/min] activités ${s.observed} · wallets vérifiés ${s.checked} (patrouille ${s.patrolled}) · avec X ${s.linked}` +
        ` · claims X ${s.claims} · alertes ${s.alerts} · file ${s.queued}${s.dropped ? ` · ignorés ${s.dropped}` : ''}` +
        ` · X connus ${s.known} · mode ${pump.mode}`,
    );
  }, 60_000).unref();

  const stop = () => {
    log('arrêt…');
    for (const s of sources) s.close();
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

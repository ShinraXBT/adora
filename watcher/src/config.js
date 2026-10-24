// Loads config.json (merged over defaults), applies environment overrides, and watches the file
// so the watchlist and the follower threshold can change without a restart.

import { existsSync, readFileSync, watchFile } from 'node:fs';

export const DEFAULTS = {
  watchHandles: [],
  minFollowers: 100_000,
  solana: {
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    httpUrl: '', // defaults to wsUrl with http(s)
    commitment: 'processed',
    pumpSwap: true,
    socialClaims: true,
  },
  patrol: { walletsPerMinute: 3000 },
  social: { enabled: true, seedWallets: [], autoSeeds: 20, intervalSeconds: 30 },
  pumpPortal: { enabled: true, wsUrl: 'wss://pumpportal.fun/api/data' },
  pump: {
    apiHosts: ['https://frontend-api-v3.pump.fun', 'https://advanced-api-v2.pump.fun', 'https://profile-api.pump.fun'],
    jwt: '',
    batchSize: 50,
    recheckMinutes: 5,
  },
  twitter: { twitterApiIoKey: '', xBearerToken: '', xApiKey: '', xApiSecret: '' },
  notify: {
    telegram: { botToken: '', chatId: '' },
    discord: { webhookUrl: '' },
    ntfy: { topic: '', server: 'https://ntfy.sh' },
  },
  dataFile: 'data/state.json',
};

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

const ENV = [
  ['SOLANA_WS_URL', c => c.solana, 'wsUrl'],
  ['SOLANA_HTTP_URL', c => c.solana, 'httpUrl'],
  ['PUMP_JWT', c => c.pump, 'jwt'],
  ['TWITTERAPI_IO_KEY', c => c.twitter, 'twitterApiIoKey'],
  ['X_BEARER_TOKEN', c => c.twitter, 'xBearerToken'],
  ['X_API_KEY', c => c.twitter, 'xApiKey'],
  ['X_API_SECRET', c => c.twitter, 'xApiSecret'],
  ['TELEGRAM_BOT_TOKEN', c => c.notify.telegram, 'botToken'],
  ['TELEGRAM_CHAT_ID', c => c.notify.telegram, 'chatId'],
  ['DISCORD_WEBHOOK_URL', c => c.notify.discord, 'webhookUrl'],
  ['NTFY_TOPIC', c => c.notify.ntfy, 'topic'],
];

export function loadConfig(file, env = process.env) {
  const fromFile = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = merge(DEFAULTS, fromFile);
  for (const [name, target, key] of ENV) if (env[name]) target(cfg)[key] = env[name];
  if (env.WATCH_HANDLES) cfg.watchHandles = [...cfg.watchHandles, ...env.WATCH_HANDLES.split(',')];
  if (env.MIN_FOLLOWERS) cfg.minFollowers = Number(env.MIN_FOLLOWERS);
  return cfg;
}

export function watchConfig(file, onChange, log = console.log) {
  watchFile(file, { interval: 2000 }, () => {
    try {
      onChange(loadConfig(file));
    } catch (e) {
      log(`[config] ${file} invalide, ancienne config gardée: ${e.message}`);
    }
  });
}

export function watcherOptions(cfg) {
  return {
    watchHandles: cfg.watchHandles,
    minFollowers: cfg.minFollowers,
    batchSize: cfg.pump.batchSize,
    recheckMs: cfg.pump.recheckMinutes * 60_000,
  };
}

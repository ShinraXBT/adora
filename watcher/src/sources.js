// Live feeds of pump.fun activity: Solana RPC logs of the pump and PumpSwap programs
// (every trade and coin creation), of the pump fee program (X accounts claiming their fees),
// plus PumpPortal's new-coin feed as a backup for creators.

import { eventsFromLogs, hasSocialClaim, PUMP_FEES_PROGRAM, socialClaimsFromTransaction } from './decode.js';

export function reconnectingSocket({ url, name, log, onOpen, onMessage, idleMs = 60_000 }) {
  const shown = url.replace(/(api[-_]?key=)[^&]+/i, '$1***');
  let ws = null;
  let idle = null;
  let retry = null;
  let delay = 1000;
  let stopped = false;

  const connect = () => {
    let closed = false;
    const sock = new WebSocket(url);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    const onClose = () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      if (stopped) return;
      log(`[${name}] déconnecté, reconnexion dans ${delay / 1000}s`);
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        log(`[${name}] aucun message depuis ${idleMs / 1000}s`);
        sock.close();
        onClose();
      }, idleMs);
    };
    sock.addEventListener('open', () => {
      delay = 1000;
      log(`[${name}] connecté à ${shown}`);
      arm();
      onOpen(sock);
    });
    sock.addEventListener('message', ev => {
      arm();
      try {
        onMessage(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch (e) {
        log(`[${name}] ${e.stack ?? e}`);
      }
    });
    sock.addEventListener('close', onClose);
    sock.addEventListener('error', ev => log(`[${name}] erreur websocket: ${ev.message ?? ev.error?.message ?? 'inconnue'}`));
  };

  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(idle);
      clearTimeout(retry);
      ws?.close();
    },
  };
}

export function solanaSource({ url, httpUrl, programs, commitment = 'processed', onEvents, onSocialClaim, log, fetchImpl = fetch }) {
  httpUrl ||= url.replace(/^ws/, 'http');
  const kinds = new Map(); // logsSubscribe request id -> 'trades' | 'claims'
  const subscriptions = new Map(); // subscription id -> 'trades' | 'claims'
  return reconnectingSocket({
    url,
    name: 'solana',
    log,
    onOpen: ws => {
      subscriptions.clear();
      const watched = programs.map(p => [p, 'trades']);
      if (onSocialClaim) watched.push([PUMP_FEES_PROGRAM, 'claims']);
      watched.forEach(([program, kind], i) => {
        kinds.set(i + 1, kind);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [program] }, { commitment }] }));
      });
    },
    onMessage: text => {
      const msg = JSON.parse(text);
      if (msg.error) return log(`[solana] erreur RPC: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      if (typeof msg.result === 'number' && kinds.has(msg.id)) return subscriptions.set(msg.result, kinds.get(msg.id));
      const value = msg.method === 'logsNotification' ? msg.params?.result?.value : null;
      if (!value?.logs) return;
      // Every pump trade also mentions the fee program: on that feed, only fee claims matter.
      if (subscriptions.get(msg.params.subscription) !== 'claims') return onEvents(eventsFromLogs(value.logs), value.signature);
      if (!hasSocialClaim(value.logs)) return;
      socialClaims(value, { httpUrl, fetchImpl })
        .then(claims => claims.forEach(c => onSocialClaim(c, value.signature)))
        .catch(e => log(`[solana] claim ${value.signature}: ${e.message}`));
    },
  });
}

// Claim events are usually only in the #[event_cpi] inner instruction, which logs do not carry:
// fetch the transaction once it is confirmed.
export async function socialClaims(value, { httpUrl, fetchImpl = fetch, attempts = 8, delayMs = 500 }) {
  const fromLogs = eventsFromLogs(value.logs).filter(e => e.type === 'social-claim');
  if (fromLogs.length) return fromLogs;
  for (let i = 0; i < attempts; i++) {
    const res = await fetchImpl(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [value.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    if (body?.result) return socialClaimsFromTransaction(body.result);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('transaction introuvable via getTransaction');
}

export function pumpPortalSource({ url, onCreate, log }) {
  return reconnectingSocket({
    url,
    name: 'pumpportal',
    log,
    idleMs: 180_000,
    onOpen: ws => ws.send(JSON.stringify({ method: 'subscribeNewToken' })),
    onMessage: text => {
      const msg = JSON.parse(text);
      if (msg.txType === 'create' && msg.traderPublicKey) onCreate(msg);
    },
  });
}

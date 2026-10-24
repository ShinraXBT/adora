// Live feeds of pump.fun activity: Solana RPC logs of the pump and PumpSwap programs
// (every trade and coin creation), plus PumpPortal's new-coin feed as a backup for creators.

import { eventsFromLogs } from './decode.js';

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

export function solanaSource({ url, programs, commitment = 'processed', onEvents, log }) {
  return reconnectingSocket({
    url,
    name: 'solana',
    log,
    onOpen: ws =>
      programs.forEach((program, i) =>
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [program] }, { commitment }] })),
      ),
    onMessage: text => {
      const msg = JSON.parse(text);
      if (msg.error) return log(`[solana] erreur RPC: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      const value = msg.method === 'logsNotification' ? msg.params?.result?.value : null;
      if (value?.logs) onEvents(eventsFromLogs(value.logs), value.signature);
    },
  });
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

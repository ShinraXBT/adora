// Sends alerts to the console and to every configured channel (Telegram, Discord, ntfy).

const short = s => (s && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

export function formatFollowers(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}

const ACTIONS = {
  create: 'a créé',
  buy: 'a acheté',
  sell: 'a vendu',
  'amm-buy': 'a acheté (PumpSwap)',
  'amm-sell': 'a vendu (PumpSwap)',
  creator: 'est le créateur d’un coin tradé',
  patrol: 'repéré par la patrouille, sans nouvelle activité on-chain',
};

// alert: { handle, wallet, reasons: ['watchlist'|'followers'|'already-known'], profile, ctx, justLinked }
export function buildMessage(alert) {
  const { handle, wallet, reasons, profile, ctx = {}, justLinked } = alert;
  const tag = reasons.includes('watchlist') ? '🎯 WATCHLIST' : `🔥 ${formatFollowers(profile?.followers)} FOLLOWERS`;
  const title = `${tag} · @${handle} sur pump.fun`;
  const lines = [];
  lines.push(
    profile
      ? `👥 ${formatFollowers(profile.followers)} followers${profile.verified ? ' · ✅ vérifié' : ''}${profile.name ? ` · ${profile.name}` : ''}`
      : '👥 followers inconnus',
  );
  if (reasons.includes('already-known')) lines.push('ℹ️ déjà repéré avant l’ajout à la watchlist');
  else if (ctx.type === 'social-claim') lines.push('🆕 X vérifié on-chain à l’instant : il réclame les frais pump.fun réservés à son compte');
  else lines.push(justLinked ? '🆕 vient de lier son X (wallet vu sans X avant)' : '🆕 première détection avec X lié');
  if (ctx.type && ctx.type !== 'social-claim') {
    const what = ctx.type === 'create' && ctx.symbol ? ` $${ctx.symbol}${ctx.name ? ` (${ctx.name})` : ''}` : '';
    const sol = ctx.sol ? ` · ${ctx.sol.toFixed(2)} SOL` : '';
    lines.push(`⚡ ${ACTIONS[ctx.type] ?? ctx.type}${what}${sol}`);
  }
  const links = [
    ['X', `https://x.com/${handle}`],
    ['Profil pump.fun', `https://pump.fun/profile/${wallet}`],
  ];
  if (ctx.mint) links.push([`Coin ${short(ctx.mint)}`, `https://pump.fun/coin/${ctx.mint}`]);
  if (ctx.signature) links.push(['Tx', `https://solscan.io/tx/${ctx.signature}`]);
  return { title, lines, links, wallet, url: links[1][1] };
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Notifier {
  constructor({ telegram = {}, discord = {}, ntfy = {} } = {}, { fetchImpl = fetch, log = console.log } = {}) {
    this.telegram = telegram;
    this.discord = discord;
    this.ntfy = ntfy;
    this.fetch = fetchImpl;
    this.log = log;
  }

  get channels() {
    const c = [];
    if (this.telegram.botToken && this.telegram.chatId) c.push('telegram');
    if (this.discord.webhookUrl) c.push('discord');
    if (this.ntfy.topic) c.push('ntfy');
    return c;
  }

  async send(alert) {
    const msg = buildMessage(alert);
    this.log(`\n🔔 ${msg.title}\n   ${msg.lines.join('\n   ')}\n   wallet: ${msg.wallet}\n   ${msg.links.map(([k, v]) => `${k}: ${v}`).join('\n   ')}\n`);
    const jobs = [];
    if (this.channels.includes('telegram')) jobs.push(['telegram', this.sendTelegram(msg)]);
    if (this.channels.includes('discord')) jobs.push(['discord', this.sendDiscord(msg)]);
    if (this.channels.includes('ntfy')) jobs.push(['ntfy', this.sendNtfy(msg)]);
    const results = await Promise.allSettled(jobs.map(([, p]) => p));
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.log(`[notify] échec ${jobs[i][0]}: ${r.reason?.message ?? r.reason}`);
    });
  }

  async post(url, body) {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }

  sendTelegram(msg) {
    const text = [
      `<b>${escapeHtml(msg.title)}</b>`,
      ...msg.lines.map(escapeHtml),
      `<code>${escapeHtml(msg.wallet)}</code>`,
      msg.links.map(([k, v]) => `<a href="${escapeHtml(v)}">${escapeHtml(k)}</a>`).join(' · '),
    ].join('\n');
    return this.post(`https://api.telegram.org/bot${this.telegram.botToken}/sendMessage`, {
      chat_id: this.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  sendDiscord(msg) {
    return this.post(this.discord.webhookUrl, {
      content: [
        `**${msg.title}**`,
        ...msg.lines,
        `\`${msg.wallet}\``,
        msg.links.map(([k, v]) => `[${k}](<${v}>)`).join(' · '),
      ].join('\n'),
    });
  }

  sendNtfy(msg) {
    return this.post(this.ntfy.server || 'https://ntfy.sh', {
      topic: this.ntfy.topic,
      title: msg.title,
      message: [...msg.lines, msg.wallet].join('\n'),
      priority: 5,
      tags: ['rotating_light'],
      click: msg.url,
      actions: msg.links.slice(0, 3).map(([label, url]) => ({ action: 'view', label, url })),
    });
  }
}

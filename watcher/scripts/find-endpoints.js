#!/usr/bin/env node
// Lists the API routes the public pump.fun web app knows how to call, by downloading its
// JavaScript (the same files any browser loads) and searching it for API hosts and paths.
// Usage: node scripts/find-endpoints.js [--out endpoints-found.txt]

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SITE = 'https://pump.fun';
const PAGES = ['/', '/board', '/profiles', '/kols', '/live', '/communities', '/callouts', '/create', '/profile/11111111111111111111111111111111'];
const INTERESTING = /user|profile|follow|x\/|twitter|social|search|kol|suggest|recent|latest|new|feed|notif|leaderboard|handle|connect|register|discover|trending|top/i;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/javascript,*/*',
};

// Script files referenced by a page, including those only named inside the inline RSC payload.
export function chunkUrls(html) {
  const found = new Set();
  for (const m of html.matchAll(/\/?_next\/static\/[A-Za-z0-9_\-./()[\]%~@]+?\.js/g)) {
    found.add(`${SITE}/${m[0].replace(/^\//, '')}`);
  }
  for (const m of html.matchAll(/static\/chunks\/[A-Za-z0-9_\-./()[\]%~@]+?\.js/g)) found.add(`${SITE}/_next/${m[0]}`);
  return [...found];
}

// Lazy chunks named in the webpack runtime as {id:"hash",...} maps.
export function lazyChunkUrls(js) {
  const found = new Set();
  for (const map of js.matchAll(/\{(?:\d+:"[0-9a-f]{8,20}",?){3,}\}/g)) {
    for (const [, id, hash] of map[0].matchAll(/(\d+):"([0-9a-f]{8,20})"/g)) found.add(`${SITE}/_next/static/chunks/${id}.${hash}.js`);
  }
  return [...found];
}

// API hosts, websockets, and path-like strings (plain or template literals).
export function extract(js) {
  const hosts = new Set();
  const sockets = new Set();
  const paths = new Set();
  for (const m of js.matchAll(/https:\/\/[a-z0-9.-]*pump\.fun(?:\/[^\s"'`\\)]*)?/gi)) hosts.add(m[0]);
  for (const m of js.matchAll(/wss?:\/\/[^\s"'`\\)]+/gi)) sockets.add(m[0]);
  const segment = String.raw`(?:[A-Za-z0-9_\-.:]+|\$\{[^}]{0,40}\})`;
  // An optional leading ${host} covers template literals like `${API}/users/${id}`.
  const re = new RegExp(String.raw`["'\`](?:\$\{[^}]{0,40}\})?(\/${segment}(?:\/${segment})*\/?)(?:\?[^"'\`]{0,80})?["'\`]`, 'g');
  for (const m of js.matchAll(re)) {
    const p = m[1].replace(/\$\{[^}]*\}/g, '{param}');
    if (p.length > 1 && !/\.(js|css|png|jpe?g|svg|webp|gif|ico|woff2?|json|mp4)$/i.test(p) && !p.startsWith('/_next')) paths.add(p);
  }
  return { hosts, sockets, paths };
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : 'endpoints-found.txt';
  const queue = new Set();
  for (const page of PAGES) {
    try {
      const html = await get(SITE + page);
      chunkUrls(html).forEach(u => queue.add(u));
      console.log(`page ${page}: ok`);
    } catch (e) {
      console.log(`page ${page}: ${e.message}`);
    }
  }
  if (!queue.size) {
    console.log('Aucun script trouvé : pump.fun est-il joignable depuis cette machine ?');
    process.exitCode = 1;
    return;
  }

  const all = { hosts: new Set(), sockets: new Set(), paths: new Set() };
  const done = new Set();
  const pending = [...queue];
  let failed = 0;
  const worker = async () => {
    while (pending.length && done.size < 600) {
      const url = pending.shift();
      if (done.has(url)) continue;
      done.add(url);
      try {
        const js = await get(url);
        const found = extract(js);
        for (const k of Object.keys(all)) found[k].forEach(v => all[k].add(v));
        for (const u of [...chunkUrls(js), ...lazyChunkUrls(js)]) if (!done.has(u)) pending.push(u);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const sorted = s => [...s].sort();
  const interesting = sorted(all.paths).filter(p => INTERESTING.test(p));
  const report = [
    `# Routes trouvées dans le code public de pump.fun (${new Date().toISOString()})`,
    `# ${done.size} scripts lus, ${failed} en échec`,
    '',
    '## Hôtes pump.fun',
    ...sorted(all.hosts),
    '',
    '## WebSockets',
    ...sorted(all.sockets),
    '',
    '## Routes liées aux utilisateurs, profils, X, follows, recherche',
    ...interesting,
    '',
    '## Toutes les routes',
    ...sorted(all.paths),
  ].join('\n');
  writeFileSync(out, report);
  console.log(`\n${done.size} scripts lus · ${all.hosts.size} hôtes · ${interesting.length} routes intéressantes`);
  console.log(`Rapport complet : ${out}\n`);
  console.log(interesting.slice(0, 80).join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

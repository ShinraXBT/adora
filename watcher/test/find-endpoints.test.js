import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkUrls, extract, lazyChunkUrls } from '../scripts/find-endpoints.js';

test('finds script chunks in a page, including the RSC payload', () => {
  const html = `<script src="/_next/static/chunks/main-app-abc.js"></script>
    <script>self.__next_f.push([1,"2:I[\\"static/chunks/app/profile/page-def.js\\"]"])</script>`;
  assert.deepEqual(chunkUrls(html).sort(), [
    'https://pump.fun/_next/static/chunks/app/profile/page-def.js',
    'https://pump.fun/_next/static/chunks/main-app-abc.js',
  ]);
});

test('finds lazy chunks in the webpack runtime', () => {
  const js = 'u=e=>"static/chunks/"+e+"."+{123:"aaaaaaaabbbb",456:"ccccccccdddd",789:"eeeeeeeeffff"}[e]+".js"';
  assert.deepEqual(lazyChunkUrls(js), [
    'https://pump.fun/_next/static/chunks/123.aaaaaaaabbbb.js',
    'https://pump.fun/_next/static/chunks/456.ccccccccdddd.js',
    'https://pump.fun/_next/static/chunks/789.eeeeeeeeffff.js',
  ]);
});

test('extracts API hosts, websockets and routes from minified code', () => {
  const js = `const A="https://frontend-api-v3.pump.fun",W="wss://prod-v2.nats.realtime.pump.fun";
    fetch(\`\${A}/users/\${e}\`);fetch(A+"/x/public-handles",{method:"POST"});
    fetch(\`/users/search?q=\${q}&limit=20\`);const img="/logo.png";`;
  const { hosts, sockets, paths } = extract(js);
  assert.deepEqual([...hosts], ['https://frontend-api-v3.pump.fun']);
  assert.deepEqual([...sockets], ['wss://prod-v2.nats.realtime.pump.fun']);
  assert.deepEqual([...paths].sort(), ['/users/search', '/users/{param}', '/x/public-handles']);
});

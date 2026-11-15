import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
  name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: Array<{ src: string; type: string }>;
};
assert.equal(manifest.name, 'ZERO AI STUDIO');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.some((icon) => icon.src === '/icons/zero-icon.svg'));

const serviceWorker = readFileSync('public/sw.js', 'utf8');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"));
assert.ok(serviceWorker.includes('Never cache private API responses'));
assert.ok(serviceWorker.includes("request.mode === 'navigate'"));
assert.ok(serviceWorker.includes("url.pathname.startsWith('/assets/')"));

const html = readFileSync('index.html', 'utf8');
assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
assert.ok(html.includes('apple-mobile-web-app-capable'));

const entry = readFileSync('main.tsx', 'utf8');
assert.ok(entry.includes("navigator.serviceWorker.register('/sw.js'"));

console.log('PWA tests passed: install metadata, shell caching and private API cache exclusion.');

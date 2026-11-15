import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
  name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: Array<{ src: string; type: string; sizes?: string }>;
};
assert.equal(manifest.name, 'ZERO AI STUDIO');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.some((icon) => icon.src === '/icons/zero-icon.svg'));
assert.ok(manifest.icons.some((icon) =>
  icon.src === '/icons/apple-touch-icon.png' && icon.type === 'image/png' && icon.sizes === '180x180'
));
const appleIcon = readFileSync('public/icons/apple-touch-icon.png');
assert.equal(appleIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.equal(appleIcon.readUInt32BE(16), 180);
assert.equal(appleIcon.readUInt32BE(20), 180);

const serviceWorker = readFileSync('public/sw.js', 'utf8');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"));
assert.ok(serviceWorker.includes('Never cache private API responses'));
assert.ok(serviceWorker.includes("request.mode === 'navigate'"));
assert.ok(serviceWorker.includes("url.pathname.startsWith('/assets/')"));
assert.ok(serviceWorker.includes("'/icons/apple-touch-icon.png'"));

const html = readFileSync('index.html', 'utf8');
assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
assert.ok(html.includes('apple-mobile-web-app-capable'));
assert.ok(html.includes('rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png"'));

const entry = readFileSync('main.tsx', 'utf8');
assert.ok(entry.includes("navigator.serviceWorker.register('/sw.js'"));

console.log('PWA tests passed: install metadata, Apple icon, shell caching and private API cache exclusion.');

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFullProjectZip, verifyZipBuffer } from '../server/zipExporter.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'zero-zip-security-'));
try {
  const files: Record<string, string> = {
    'package.json': '{"name":"zero-test"}',
    'server.ts': 'export {};',
    'index.html': '<!doctype html>',
    'App.tsx': 'export {};',
    'data/zero-studio-db.json': '{}',
    'src/main.tsx': 'export {};',
    'README.md': 'safe project file',
    '.env': 'API_KEY=secret',
    '.env.example': 'API_KEY=',
    'id_rsa': 'PRIVATE KEY',
    'keys/server.pem': 'PRIVATE KEY',
    'keys/server.key': 'PRIVATE KEY',
    'certs/signing.p12': 'PRIVATE KEY',
    '.ssh/id_ed25519': 'PRIVATE KEY',
    '.aws/credentials': 'aws_secret_access_key=secret',
    '.npmrc': '//registry.npmjs.org/:_authToken=secret',
    'credentials.json': '{"private_key":"secret"}',
    'zero-service-account.json': '{"private_key":"secret"}',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const archive = await buildFullProjectZip(root, {
    'extra/normal.txt': Buffer.from('safe extra'),
    'extra/private.pem': Buffer.from('PRIVATE KEY'),
    'extra/credentials.json': Buffer.from('secret'),
  });

  assert.ok(archive.files.includes('README.md'));
  assert.ok(archive.files.includes('.env.example'));
  assert.ok(archive.files.includes('extra/normal.txt'));
  for (const forbidden of [
    '.env', 'id_rsa', 'keys/server.pem', 'keys/server.key', 'certs/signing.p12',
    '.ssh/id_ed25519', '.aws/credentials', '.npmrc', 'credentials.json',
    'zero-service-account.json', 'extra/private.pem', 'extra/credentials.json'
  ]) {
    assert.ok(!archive.files.includes(forbidden), `Sensitive file included in backup: ${forbidden}`);
  }

  const verified = verifyZipBuffer(archive.buffer);
  assert.equal(verified.result.valid, true, verified.result.errors.join('; '));
  console.log('ZIP credential exclusion tests passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}

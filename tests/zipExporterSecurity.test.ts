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

  const findFirstEntry = (buffer: Buffer) => {
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(central, -1, 'fixture ZIP must contain a central-directory entry');
    const localOffset = buffer.readUInt32LE(central + 42);
    const nameLength = buffer.readUInt16LE(localOffset + 26);
    const extraLength = buffer.readUInt16LE(localOffset + 28);
    return { central, localOffset, dataOffset: localOffset + 30 + nameLength + extraLength };
  };
  const truncatedArchive = archive.buffer.subarray(0, archive.buffer.length - 1);
  assert.equal(verifyZipBuffer(truncatedArchive).result.valid, false, 'truncated EOCD must be rejected');

  const trailingGarbage = Buffer.concat([archive.buffer, Buffer.from([0x41])]);
  assert.equal(verifyZipBuffer(trailingGarbage).result.valid, false, 'unaccounted trailing bytes must be rejected');

  const damagedPayload = Buffer.from(archive.buffer);
  const firstEntry = findFirstEntry(damagedPayload);
  damagedPayload[firstEntry.dataOffset] ^= 0xff;
  assert.equal(verifyZipBuffer(damagedPayload).result.valid, false, 'payload corruption must fail decompression or CRC validation');

  const mismatchedLocalHeader = Buffer.from(archive.buffer);
  const localMethod = mismatchedLocalHeader.readUInt16LE(firstEntry.localOffset + 8);
  mismatchedLocalHeader.writeUInt16LE(localMethod === 8 ? 0 : 8, firstEntry.localOffset + 8);
  assert.equal(verifyZipBuffer(mismatchedLocalHeader).result.valid, false, 'local and central compression methods must agree');

  const invalidCentralOffset = Buffer.from(archive.buffer);
  const eocd = invalidCentralOffset.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1);
  invalidCentralOffset.writeUInt32LE(0xffffffff, eocd + 16);
  assert.equal(verifyZipBuffer(invalidCentralOffset).result.valid, false, 'out-of-range central directory must be rejected');

  const wrongUncompressedSize = Buffer.from(archive.buffer);
  wrongUncompressedSize.writeUInt32LE(wrongUncompressedSize.readUInt32LE(firstEntry.central + 24) + 1, firstEntry.central + 24);
  assert.equal(verifyZipBuffer(wrongUncompressedSize).result.valid, false, 'central/local size disagreement must be rejected');

  const unsupportedMethod = Buffer.from(archive.buffer);
  unsupportedMethod.writeUInt16LE(99, firstEntry.central + 10);
  unsupportedMethod.writeUInt16LE(99, firstEntry.localOffset + 8);
  assert.equal(verifyZipBuffer(unsupportedMethod).result.valid, false, 'unknown compression methods must be rejected');

  let duplicateCentralEntry = Buffer.from(archive.buffer);
  const eocdAt = duplicateCentralEntry.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const totalEntries = duplicateCentralEntry.readUInt16LE(eocdAt + 10);
  duplicateCentralEntry.writeUInt16LE(totalEntries + 1, eocdAt + 8);
  duplicateCentralEntry.writeUInt16LE(totalEntries + 1, eocdAt + 10);
  const centralSize = duplicateCentralEntry.readUInt32LE(eocdAt + 12);
  duplicateCentralEntry.writeUInt32LE(centralSize + (46 + duplicateCentralEntry.readUInt16LE(firstEntry.central + 28)), eocdAt + 12);
  const duplicateRecord = Buffer.from(duplicateCentralEntry.subarray(firstEntry.central, firstEntry.central + 46 + duplicateCentralEntry.readUInt16LE(firstEntry.central + 28)));
  duplicateCentralEntry = Buffer.concat([
    duplicateCentralEntry.subarray(0, eocdAt),
    duplicateRecord,
    duplicateCentralEntry.subarray(eocdAt),
  ]);
  const movedEocd = duplicateCentralEntry.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  duplicateCentralEntry.writeUInt32LE(movedEocd - (centralSize + duplicateRecord.length), movedEocd + 16);
  assert.equal(verifyZipBuffer(duplicateCentralEntry).result.valid, false, 'duplicate paths must be rejected');

  console.log('ZIP credential exclusion and archive-integrity tests passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'exports', 'build', 'coverage']);

export const EXCLUDED_SECRETS_DOC = [
  '.env (echte API-Schlüssel / Zugangsdaten)',
  '.env.local / .env.production',
  'Private Schlüssel und Zertifikatscontainer (*.pem, *.key, *.p12, *.pfx, *.p8, *.ppk, *.jks, *.keystore)',
  'SSH-/Cloud-/Kubernetes-Credentials (.ssh, .aws, .azure, .kube, .gnupg, .secrets)',
  'Credential-Dateien (.npmrc, .netrc, .pypirc, credentials.json, Service-Account-JSON)',
  'node_modules/ (per npm install wiederherstellbar)',
  'dist/ (per npm run build erzeugbar)',
];

function isSensitiveFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const base = path.basename(normalized).toLowerCase();
  if (segments.some((segment) => ['.ssh', '.aws', '.azure', '.kube', '.gnupg', '.secrets'].includes(segment.toLowerCase()))) return true;
  if (base.startsWith('.env') && base !== '.env.example') return true;
  if (['.npmrc', '.netrc', '.pypirc', 'credentials.json'].includes(base)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\..*)?$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|p8|ppk|jks|keystore|mobileprovision|secret|token)$/i.test(base)) return true;
  if (/(^|[-_.])service[-_]?account([-.].*)?\.json$/i.test(base)) return true;
  return false;
}

function isExcludedFile(relPath: string): boolean {
  const base = path.basename(relPath);
  if (base === '.DS_Store') return true;
  if (base.endsWith('.log')) return true;
  if (relPath.toLowerCase().endsWith('.zip')) return true;
  return isSensitiveFile(relPath);
}

async function collectFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const nested = await collectFiles(rootDir, fullPath);
      results.push(...nested);
    } else if (entry.isFile()) {
      if (isExcludedFile(relPath)) continue;
      results.push(relPath);
    }
  }
  return results.sort();
}

export interface ZipExportResult {
  buffer: Buffer;
  fileCount: number;
  files: string[];
}

export interface ZipVerifyResult {
  valid: boolean;
  fileCount: number;
  files: string[];
  missingCoreFiles: string[];
  errors: string[];
}

export async function buildFullProjectZip(
  rootDir = process.cwd(),
  extraFiles: Record<string, Buffer> = {}
): Promise<ZipExportResult> {
  const diskFiles = await collectFiles(rootDir);
  const files = [...new Set([...diskFiles, ...Object.keys(extraFiles).filter((file) => !isExcludedFile(file))])].sort();
  const localChunks: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const relPath of files) {
    const fullPath = path.join(rootDir, relPath);
    const raw = extraFiles[relPath] ?? await fs.readFile(fullPath);
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    const nameBuf = Buffer.from(relPath, 'utf8');
    const crc = crc32(raw);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localChunks.push(localHeader, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralRecords.push(central);
    offset += localHeader.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return {
    buffer: Buffer.concat([...localChunks, centralDirBuf, eocd]),
    fileCount: files.length,
    files,
  };
}

export function verifyZipBuffer(zipBuf: Buffer): {
  result: ZipVerifyResult;
  extractedFiles: Map<string, Buffer>;
} {
  const errors: string[] = [];
  const extractedFiles = new Map<string, Buffer>();
  const files: string[] = [];
  const requiredCore = [
    'package.json',
    'server.ts',
    'index.html',
    'App.tsx',
    'data/zero-studio-db.json',
  ];
  const invalid = (message: string) => ({
    result: {
      valid: false,
      fileCount: files.length,
      files: [...files],
      missingCoreFiles: requiredCore.filter((required) => !extractedFiles.has(required)),
      errors: [message],
    },
    extractedFiles,
  });

  if (zipBuf.length < 22) return invalid('ZIP-Datei ist zu klein oder leer.');

  // A valid EOCD must be the final structure, including its declared comment.
  let eocdOffset = -1;
  const minScan = Math.max(0, zipBuf.length - 22 - 0xffff);
  for (let i = zipBuf.length - 22; i >= minScan; i--) {
    if (zipBuf.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLength = zipBuf.readUInt16LE(i + 20);
    if (i + 22 + commentLength === zipBuf.length) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return invalid('EOCD fehlt oder Kommentar-/Archivlänge ist inkonsistent.');

  const diskNumber = zipBuf.readUInt16LE(eocdOffset + 4);
  const centralDisk = zipBuf.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = zipBuf.readUInt16LE(eocdOffset + 8);
  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralSize = zipBuf.readUInt32LE(eocdOffset + 12);
  const centralOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  const centralEnd = centralOffset + centralSize;

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    return invalid('Mehrteilige ZIP-Archive werden nicht unterstützt.');
  }
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    return invalid('ZIP64-Archive werden von diesem Prüfer nicht unterstützt.');
  }
  if (
    !Number.isSafeInteger(centralEnd) ||
    centralOffset > eocdOffset ||
    centralEnd !== eocdOffset
  ) {
    return invalid('Central-Directory-Grenzen stimmen nicht mit dem EOCD überein.');
  }

  let ptr = centralOffset;
  const seenNames = new Set<string>();
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > centralEnd || zipBuf.readUInt32LE(ptr) !== 0x02014b50) {
      errors.push(\`Ungültiger oder abgeschnittener Central-Directory-Eintrag bei Index \${i}.\`);
      break;
    }

    const flags = zipBuf.readUInt16LE(ptr + 8);
    const compressionMethod = zipBuf.readUInt16LE(ptr + 10);
    const expectedCrc = zipBuf.readUInt32LE(ptr + 16);
    const compressedSize = zipBuf.readUInt32LE(ptr + 20);
    const uncompressedSize = zipBuf.readUInt32LE(ptr + 24);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42);
    const recordEnd = ptr + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > centralEnd) {
      errors.push(\`Central-Directory-Metadaten für Eintrag \${i} sind abgeschnitten.\`);
      break;
    }

    const nameBytes = zipBuf.subarray(ptr + 46, ptr + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    ptr = recordEnd;

    if (!name || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) ||
        name.split('/').some((segment) => segment === '..' || segment === '')) {
      errors.push(\`Unsicherer oder ungültiger ZIP-Dateipfad "\${name}".\`);
      continue;
    }
    if (seenNames.has(name)) {
      errors.push(\`Doppelter ZIP-Dateieintrag "\${name}".\`);
      continue;
    }
    seenNames.add(name);

    // This exporter writes UTF-8 names, no encryption, and no data descriptors.
    if (flags !== 0x0800) {
      errors.push(\`Nicht unterstützte ZIP-Flags für "\${name}".\`);
      continue;
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      errors.push(\`Nicht unterstützte Kompressionsmethode für "\${name}".\`);
      continue;
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      errors.push(\`Gespeicherte und entpackte Größe stimmen für "\${name}" nicht überein.\`);
      continue;
    }
    if (
      localHeaderOffset + 30 > centralOffset ||
      zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      errors.push(\`Lokaler Header ungültig für "\${name}".\`);
      continue;
    }

    const localFlags = zipBuf.readUInt16LE(localHeaderOffset + 6);
    const localMethod = zipBuf.readUInt16LE(localHeaderOffset + 8);
    const localCrc = zipBuf.readUInt32LE(localHeaderOffset + 14);
    const localCompressedSize = zipBuf.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedSize = zipBuf.readUInt32LE(localHeaderOffset + 22);
    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const dataStart = localNameStart + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (
      localFlags !== flags ||
      localMethod !== compressionMethod ||
      localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      localNameLen !== nameLen ||
      dataStart > centralOffset ||
      dataEnd > centralOffset ||
      dataEnd < dataStart ||
      !zipBuf.subarray(localNameStart, localNameStart + localNameLen).equals(nameBytes)
    ) {
      errors.push(\`Lokaler Header und Central Directory widersprechen sich für "\${name}".\`);
      continue;
    }

    const compressedSlice = zipBuf.subarray(dataStart, dataEnd);
    try {
      const rawData = compressionMethod === 0
        ? compressedSlice
        : zlib.inflateRawSync(compressedSlice, { maxOutputLength: Math.max(1, uncompressedSize) });
      if (rawData.length !== uncompressedSize) {
        errors.push(\`Entpackte Dateigröße stimmt für "\${name}" nicht mit dem Archiv überein.\`);
        continue;
      }
      if (crc32(rawData) !== expectedCrc) {
        errors.push(\`CRC32-Prüfsummenfehler bei "\${name}".\`);
        continue;
      }
      files.push(name);
      extractedFiles.set(name, rawData);
    } catch (err) {
      errors.push(
        \`Dekomprimierungsfehler bei "\${name}": \${err instanceof Error ? err.message : String(err)}\`
      );
    }
  }

  if (ptr !== centralEnd) {
    errors.push('Central-Directory-Größe stimmt nicht mit den gelesenen Einträgen überein.');
  }

  const missingCoreFiles = requiredCore.filter((required) => !extractedFiles.has(required));
  for (const file of files) {
    if (isSensitiveFile(file)) {
      errors.push(\`Sicherheitsverstoß: vertrauliche Datei "\${file}" im Backup gefunden.\`);
    }
  }

  return {
    result: {
      valid: errors.length === 0 && missingCoreFiles.length === 0 && files.length === totalEntries,
      fileCount: files.length,
      files,
      missingCoreFiles,
      errors,
    },
    extractedFiles,
  };
}

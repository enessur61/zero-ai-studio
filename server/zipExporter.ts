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
  'node_modules/ (per npm install wiederherstellbar)',
  'dist/ (per npm run build erzeugbar)',
];

function isExcludedFile(relPath: string): boolean {
  const base = path.basename(relPath);
  if (base === '.DS_Store') return true;
  if (base.endsWith('.log')) return true;
  if (base.startsWith('.env') && base !== '.env.example') return true;
  if (relPath.endsWith('.zip')) return true;
  return false;
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
  const files = [...new Set([...diskFiles, ...Object.keys(extraFiles)])].sort();
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

  if (zipBuf.length < 22) {
    return {
      result: {
        valid: false,
        fileCount: 0,
        files: [],
        missingCoreFiles: ['package.json', 'server.ts', 'src/App.tsx'],
        errors: ['ZIP-Datei ist zu klein oder leer.'],
      },
      extractedFiles,
    };
  }

  // Locate EOCD signature 0x06054b50
  let eocdOffset = -1;
  const minScan = Math.max(0, zipBuf.length - 65557);
  for (let i = zipBuf.length - 22; i >= minScan; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    return {
      result: {
        valid: false,
        fileCount: 0,
        files: [],
        missingCoreFiles: ['package.json', 'server.ts', 'src/App.tsx'],
        errors: ['EOCD-Signatur fehlt — beschädigtes ZIP-Archiv.'],
      },
      extractedFiles,
    };
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  let ptr = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > zipBuf.length || zipBuf.readUInt32LE(ptr) !== 0x02014b50) {
      errors.push(`Ungültiger Central-Directory-Eintrag bei Index ${i}.`);
      break;
    }

    const compressionMethod = zipBuf.readUInt16LE(ptr + 10);
    const expectedCrc = zipBuf.readUInt32LE(ptr + 16);
    const compressedSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (
      localHeaderOffset + 30 > zipBuf.length ||
      zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      errors.push(`Lokaler Header ungültig für "${name}".`);
      continue;
    }

    const lNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
    const compressedSlice = zipBuf.subarray(dataStart, dataStart + compressedSize);

    try {
      const rawData =
        compressionMethod === 0 ? compressedSlice : zlib.inflateRawSync(compressedSlice);
      const actualCrc = crc32(rawData);
      if (actualCrc !== expectedCrc) {
        errors.push(`CRC32-Prüfsummenfehler bei "${name}".`);
      } else {
        files.push(name);
        extractedFiles.set(name, rawData);
      }
    } catch (err) {
      errors.push(
        `Dekomprimierungsfehler bei "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const requiredCore = [
    'package.json',
    'server.ts',
    'index.html',
    'src/App.tsx',
    'data/zero-studio-db.json',
  ];
  const missingCoreFiles = requiredCore.filter((req) => !extractedFiles.has(req));

  // Verify no unencrypted .env secret slipped into backup
  for (const f of files) {
    const base = path.basename(f);
    if (base.startsWith('.env') && base !== '.env.example') {
      errors.push(`Sicherheitsverstoß: geheime Datei "${f}" im Backup gefunden.`);
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

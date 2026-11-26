import { createHash } from 'node:crypto';
import type { ZipBackupVersion } from '../src/types/zero.ts';
import { migrateProjectOwnership } from './projectIdentity.ts';
import { emptyContinuityState } from '../src/types/continuity.ts';
import { validateContinuityState } from './continuity.ts';
import type { ZeroDatabase } from './store.ts';

type VerifiedZip = {
  result: { valid: boolean; errors: string[] };
  extractedFiles: Map<string, Buffer>;
};

type RestoredProjectVideo = { id: string; projectId: string; sceneId: string; jobId: string | null; contentType: 'video/mp4' | 'video/webm'; payload: Buffer; sha256: string; createdAt: string };
type RestoreOptions = { expectedRevision?: number; projectVideoRestore?: { principalHash: string; assets: RestoredProjectVideo[] } };

export type VerifiedZipRestoreDependencies = {
  getZipBackupFilePath: (zipId: string) => Promise<{ record: ZipBackupVersion; buffer: Buffer }>;
  verifyZipBuffer: (buffer: Buffer) => VerifiedZip;
  assertRestorableDatabase: (value: unknown) => asserts value is ZeroDatabase;
  createSafetyBackup: (source: ZipBackupVersion) => Promise<ZipBackupVersion>;
  loadDb: () => Promise<ZeroDatabase>;
  getZipBackupRevision: (backup: ZipBackupVersion) => number;
  saveDb: (db: ZeroDatabase, options: RestoreOptions) => Promise<void>;
  enrichModelMetadata: (model: ZeroDatabase['models'][number]) => ZeroDatabase['models'][number];
  getRestorePrincipalHash: () => string;
};

/**
 * The production ZIP restore orchestration with explicit persistence boundaries.
 * This keeps archive verification, safety-backup ordering and revision fencing
 * identical in production and in deterministic PostgreSQL integration tests.
 */
export function createVerifiedZipRestoreService(dependencies: VerifiedZipRestoreDependencies) {
  return async function restoreFromVerifiedZipBackup(zipId: string): Promise<{
    restoredVersion: string;
    safetyBackup: ZipBackupVersion;
    db: ZeroDatabase;
  }> {
    const { record, buffer: zipBuf } = await dependencies.getZipBackupFilePath(zipId);
    if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes !== zipBuf.length) {
      throw new Error(
        `Wiederherstellung abgebrochen — ZIP beschädigt oder unvollständig: gespeicherte Größe ${record.sizeBytes} stimmt nicht mit der Blob-Größe ${zipBuf.length} überein.`
      );
    }
    const verification = dependencies.verifyZipBuffer(zipBuf);

    if (!verification.result.valid) {
      throw new Error(
        `Wiederherstellung abgebrochen — ZIP beschädigt oder unvollständig: ${verification.result.errors.join('; ')}`
      );
    }

    const dbEntry = verification.extractedFiles.get('data/zero-studio-db.json');
    if (!dbEntry) {
      throw new Error('Wiederherstellung abgebrochen — data/zero-studio-db.json fehlt im ZIP.');
    }

    let parsedRestoredDb: ZeroDatabase;
    try {
      const parsed: unknown = JSON.parse(dbEntry.toString('utf8'));
      dependencies.assertRestorableDatabase(parsed);
      migrateProjectOwnership(parsed.projects);
      parsed.continuity = validateContinuityState(parsed.continuity ?? emptyContinuityState());
      parsedRestoredDb = parsed;
    } catch (err) {
      throw new Error(
        `Wiederherstellung abgebrochen — JSON im Backup ungültig: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // A missing manifest identifies a legacy ZIP: keep existing PostgreSQL clips untouched.
    // A present manifest is authoritative and is restored in the same PostgreSQL transaction as JSONB.
    let projectVideoRestore: RestoreOptions['projectVideoRestore'];
    const manifestBytes = verification.extractedFiles.get('data/project-video-manifest.json');
    const mediaEntries = [...verification.extractedFiles.keys()].filter((name) => name.startsWith('media/project-videos/'));
    if (manifestBytes) {
      try {
        const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
          version?: unknown;
          assets?: unknown;
        };
        if (manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 10_000) {
          throw new Error('Unbekannte Manifest-Version oder ungültige Asset-Liste.');
        }
        const projects = new Set(parsedRestoredDb.projects.map((project) => project.id));
        const seenIds = new Set<string>();
        const seenPaths = new Set<string>();
        const assets: RestoredProjectVideo[] = [];
        let totalBytes = 0;
        for (const item of manifest.assets) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Ungültiger Manifest-Eintrag.');
          const asset = item as Record<string, unknown>;
          const id = asset.id;
          const projectId = asset.projectId;
          const sceneId = asset.sceneId;
          const jobId = asset.jobId;
          const contentType = asset.contentType;
          const sizeBytes = asset.sizeBytes;
          const sha256 = asset.sha256;
          const createdAt = asset.createdAt;
          const extension = contentType === 'video/mp4' ? 'mp4' : contentType === 'video/webm' ? 'webm' : null;
          const expectedPath = typeof id === 'string' && extension
            ? `media/project-videos/${id}.${extension}` : null;
          if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || seenIds.has(id) ||
              typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId) || !projects.has(projectId) ||
              typeof sceneId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sceneId) ||
              !(jobId === null || (typeof jobId === 'string' && /^[0-9a-f-]{36}$/i.test(jobId))) ||
              !extension || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) ||
              sizeBytes < 1024 || sizeBytes > 32 * 1024 * 1024 ||
              typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
              typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) ||
              asset.path !== expectedPath || !expectedPath || seenPaths.has(expectedPath)) {
            throw new Error('Manifest enthält ungültige IDs, Projektzuordnung, Pfade oder Metadaten.');
          }
          const payload = verification.extractedFiles.get(expectedPath);
          if (!payload || payload.length !== sizeBytes ||
              createHash('sha256').update(payload).digest('hex') !== sha256) {
            throw new Error(`Videodatei fehlt oder SHA-256/Größe stimmt nicht: ${expectedPath}`);
          }
          const validMagic = contentType === 'video/mp4'
            ? payload.toString('ascii', 4, 8) === 'ftyp'
            : payload.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
          if (!validMagic) throw new Error(`Ungültiger Videodatei-Typ: ${expectedPath}`);
          totalBytes += payload.length;
          if (totalBytes > 128 * 1024 * 1024) throw new Error('Video-Backup überschreitet 128 MB.');
          seenIds.add(id); seenPaths.add(expectedPath);
          assets.push({
            id, projectId, sceneId, jobId: jobId as string | null,
            contentType: contentType as 'video/mp4' | 'video/webm',
            payload, sha256, createdAt,
          });
        }
        if (mediaEntries.length !== seenPaths.size || mediaEntries.some((name) => !seenPaths.has(name))) {
          throw new Error('ZIP enthält nicht referenzierte oder zusätzliche Projektvideodateien.');
        }
        projectVideoRestore = { principalHash: dependencies.getRestorePrincipalHash(), assets };
      } catch (error) {
        throw new Error(`Wiederherstellung abgebrochen — Projektvideo-Backup ungültig: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (mediaEntries.length > 0) {
      throw new Error('Wiederherstellung abgebrochen — Videodateien ohne Manifest sind nicht vertrauenswürdig.');
    }

    // Mandatory safety backup BEFORE restoring any imported state.
    const safetyBackup = await dependencies.createSafetyBackup(record);

    const currentDb = await dependencies.loadDb();
    const expectedRevision = dependencies.getZipBackupRevision(safetyBackup);
    const preservedBackupConfig = currentDb.backupConfig;
    const preservedJsonBackups = currentDb.backups;

    parsedRestoredDb.backupConfig = {
      ...preservedBackupConfig,
      changelogHistory: [
        {
          version: preservedBackupConfig.currentVersion,
          date: new Date().toISOString(),
          summary: `Projektzustand aus verifiziertem Backup v${record.version} wiederhergestellt (Sicherheitsbackup v${safetyBackup.version} erstellt).`,
        },
        ...preservedBackupConfig.changelogHistory,
      ].slice(0, 40),
    };
    parsedRestoredDb.backups = preservedJsonBackups;
    parsedRestoredDb.settings = { ...parsedRestoredDb.settings, maxVideoDurationSec: 60 };
    parsedRestoredDb.models = parsedRestoredDb.models.map(dependencies.enrichModelMetadata);

    // A normal write after the safety snapshot advances the revision; CAS rejects restore.
    await dependencies.saveDb(parsedRestoredDb, { expectedRevision, projectVideoRestore });
    return {
      restoredVersion: record.version,
      safetyBackup,
      db: parsedRestoredDb,
    };
  };
}

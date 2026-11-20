import type { ZipBackupVersion } from '../src/types/zero.ts';
import { migrateProjectOwnership } from './projectIdentity.ts';
import { emptyContinuityState } from '../src/types/continuity.ts';
import { validateContinuityState } from './continuity.ts';
import type { ZeroDatabase } from './store.ts';

type VerifiedZip = {
  result: { valid: boolean; errors: string[] };
  extractedFiles: Map<string, Buffer>;
};

type RestoreOptions = { expectedRevision?: number };

export type VerifiedZipRestoreDependencies = {
  getZipBackupFilePath: (zipId: string) => Promise<{ record: ZipBackupVersion; buffer: Buffer }>;
  verifyZipBuffer: (buffer: Buffer) => VerifiedZip;
  assertRestorableDatabase: (value: unknown) => asserts value is ZeroDatabase;
  createSafetyBackup: (source: ZipBackupVersion) => Promise<ZipBackupVersion>;
  loadDb: () => Promise<ZeroDatabase>;
  getZipBackupRevision: (backup: ZipBackupVersion) => number;
  saveDb: (db: ZeroDatabase, options: RestoreOptions) => Promise<void>;
  enrichModelMetadata: (model: ZeroDatabase['models'][number]) => ZeroDatabase['models'][number];
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
    await dependencies.saveDb(parsedRestoredDb, { expectedRevision });
    return {
      restoredVersion: record.version,
      safetyBackup,
      db: parsedRestoredDb,
    };
  };
}

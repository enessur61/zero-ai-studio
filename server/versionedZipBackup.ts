import fs from 'node:fs/promises';
import path from 'node:path';
import type { ZipBackupVersion } from '../src/types/zero.ts';
import type { ZeroDatabase, SaveDbOptions } from './store.ts';
import type { ZipExportResult } from './zipExporter.ts';

export interface VersionedZipBackupDependencies {
  loadDb: () => Promise<ZeroDatabase>;
  getDbRevision: (db: ZeroDatabase) => number;
  saveDb: (db: ZeroDatabase, options?: SaveDbOptions) => Promise<void>;
  deleteBackupFile: (id: string) => Promise<void>;
  buildFullProjectZip: (rootDir: string, extraFiles: Record<string, Buffer>) => Promise<ZipExportResult>;
  verifyZipBuffer: (buffer: Buffer) => {
    result: { valid: boolean; errors: string[]; missingCoreFiles: string[] };
  };
  excludedSecrets: string[];
  isPersistent: () => boolean;
  rootDir: () => string;
  zipBackupDir: string;
  rememberBackupRevision?: (record: ZipBackupVersion, revision: number) => void;
}

function bumpPatchVersion(version: string): string {
  const parts = version.split('.').map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return '1.1.1';
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/**
 * The shared production ZIP backup implementation. Persistence, ZIP generation
 * and verification are injected so integration tests can exercise the same
 * orchestration against isolated PostgreSQL pools and deterministic failures.
 */
export function createVersionedZipBackupService(dependencies: VersionedZipBackupDependencies) {
  return async function createVersionedZipBackup(params: {
    changelog: string;
    trigger: 'manual' | 'auto' | 'pre_restore';
    bumpVersion?: boolean;
    recordAutoBackupSuccess?: boolean;
  }): Promise<ZipBackupVersion> {
    const current = await dependencies.loadDb();
    const persistent = dependencies.isPersistent();
    const expectedRevision = persistent ? dependencies.getDbRevision(current) : undefined;
    const db = JSON.parse(JSON.stringify(current)) as ZeroDatabase;
    const backupSnapshot = db;
    const nextVersion =
      params.bumpVersion === false
        ? backupSnapshot.backupConfig.currentVersion
        : bumpPatchVersion(backupSnapshot.backupConfig.currentVersion);

    const now = new Date().toISOString();
    const datePart = now.slice(0, 19).replace(/[:T]/g, '-');
    const filename = `ZERO_AI_STUDIO_v${nextVersion}_${datePart}.zip`;
    const targetPath = path.join(dependencies.zipBackupDir, filename);

    // Build from a detached snapshot; do not publish a version until the archive is verified.
    backupSnapshot.backupConfig.currentVersion = nextVersion;
    backupSnapshot.backupConfig.changelogHistory.unshift({
      version: nextVersion,
      date: now,
      summary: params.changelog,
    });
    if (backupSnapshot.backupConfig.changelogHistory.length > 40) {
      backupSnapshot.backupConfig.changelogHistory = backupSnapshot.backupConfig.changelogHistory.slice(0, 40);
    }

    const zipRes = await dependencies.buildFullProjectZip(dependencies.rootDir(), {
      'data/zero-studio-db.json': Buffer.from(JSON.stringify(backupSnapshot, null, 2), 'utf8'),
    });
    const verification = dependencies.verifyZipBuffer(zipRes.buffer);
    if (!verification.result.valid) {
      throw new Error(
        `ZIP-Integritätsprüfung fehlgeschlagen: ${[
          ...verification.result.errors,
          ...verification.result.missingCoreFiles.map((file) => `Fehlende Datei: ${file}`),
        ].join('; ')}`
      );
    }

    const record: ZipBackupVersion = {
      id: `zip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      version: nextVersion,
      filename,
      createdAt: now,
      changelog: params.changelog,
      trigger: params.trigger,
      fileCount: zipRes.fileCount,
      sizeBytes: zipRes.buffer.length,
      verified: true,
      protected: params.trigger !== 'auto',
      excludedSecrets: dependencies.excludedSecrets,
    };

    db.backupConfig.currentVersion = nextVersion;
    db.backupConfig.changelogHistory = backupSnapshot.backupConfig.changelogHistory;
    db.backupConfig.lastVerifiedAt = now;
    db.backupConfig.zipBackups.unshift(record);
    // Keep every explicitly protected backup, but cap automatic/unprotected history
    // at 10 entries so repeated project edits cannot grow storage without bound.
    const beforePrune = db.backupConfig.zipBackups;
    const protectedItems = beforePrune.filter((backup) => backup.protected);
    const unprotectedItems = beforePrune.filter((backup) => !backup.protected).slice(0, 10);
    db.backupConfig.zipBackups = [...protectedItems, ...unprotectedItems].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    const retainedIds = new Set(db.backupConfig.zipBackups.map((backup) => backup.id));
    const removedZipBackups = beforePrune.filter((backup) => !retainedIds.has(backup.id));

    if (persistent) {
      await dependencies.saveDb(db, {
        expectedRevision,
        backupFile: { id: record.id, filename, contentType: 'application/zip', payload: zipRes.buffer },
        recordAutoBackupSuccess: params.recordAutoBackupSuccess ?? false,
      });
      dependencies.rememberBackupRevision?.(record, dependencies.getDbRevision(db));
    } else {
      await fs.mkdir(dependencies.zipBackupDir, { recursive: true });
      await fs.writeFile(targetPath, zipRes.buffer);
      try {
        await dependencies.saveDb(db);
      } catch (error) {
        await fs.rm(targetPath, { force: true });
        throw error;
      }
    }

    if (persistent) {
      await Promise.all(removedZipBackups.map((backup) => dependencies.deleteBackupFile(backup.id)));
    } else {
      await Promise.all(removedZipBackups.map((backup) =>
        fs.rm(path.join(dependencies.zipBackupDir, backup.filename), { force: true })
      ));
    }
    return record;
  };
}

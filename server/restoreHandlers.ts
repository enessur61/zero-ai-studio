import type { RequestHandler } from 'express';
import { asyncRoute } from './asyncRoute.ts';
import { PersistentStateConflictError } from './persistence.ts';

type RestoreServices = {
  restoreSystemBackup: (backupId: string) => Promise<{ projects: unknown[]; memories: unknown[] }>;
  restoreZipBackup: (backupId: string) => Promise<{
    restoredVersion: string;
    safetyBackup: unknown;
    db: { backupConfig: unknown };
  }>;
};

function restoreError(res: Parameters<RequestHandler>[1], error: unknown): void {
  if (error instanceof PersistentStateConflictError) {
    res.status(409).json({
      error: error.message,
      code: 'PERSISTENCE_REVISION_CONFLICT',
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    });
    return;
  }
  res.status(400).json({
    error: error instanceof Error ? error.message : 'Wiederherstellung fehlgeschlagen',
  });
}

/** Build restore endpoints with explicit services so HTTP behavior is testable without global mutation. */
export function createRestoreHandlers(services: RestoreServices): {
  json: RequestHandler;
  zip: RequestHandler;
} {
  return {
    json: asyncRoute(async (req, res) => {
      try {
        const restored = await services.restoreSystemBackup(String(req.body?.backupId ?? ''));
        res.json({
          ok: true,
          restoredProjects: restored.projects.length,
          restoredMemories: restored.memories.length,
        });
      } catch (error) {
        restoreError(res, error);
      }
    }),
    zip: asyncRoute(async (req, res) => {
      try {
        const restored = await services.restoreZipBackup(req.params.id);
        res.json({
          ok: true,
          restoredVersion: restored.restoredVersion,
          safetyBackup: restored.safetyBackup,
          backupConfig: restored.db.backupConfig,
        });
      } catch (error) {
        restoreError(res, error);
      }
    }),
  };
}

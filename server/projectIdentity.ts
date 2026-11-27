import type { RequestHandler } from 'express';
import { asyncRoute } from './asyncRoute.ts';

export const ZERO_ADMIN_PRINCIPAL_ID = 'admin:primary' as const;

export type ZeroPrincipal = {
  id: string;
  role: 'admin' | 'user';
};

export const ZERO_ADMIN_PRINCIPAL: ZeroPrincipal = Object.freeze({
  id: ZERO_ADMIN_PRINCIPAL_ID,
  role: 'admin',
});

type ProjectIdentityShape = { id: string; ownerId?: unknown };

/** Accept only the principal explicitly installed by the server auth middleware. */
export function getZeroPrincipal(locals: unknown): ZeroPrincipal | null {
  if (!locals || typeof locals !== 'object' || Array.isArray(locals)) return null;
  const candidate = (locals as Record<string, unknown>).zeroProjectPrincipal;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (value.id === ZERO_ADMIN_PRINCIPAL_ID && value.role === 'admin') return ZERO_ADMIN_PRINCIPAL;
  if (typeof value.id === 'string' &&
      /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) &&
      value.role === 'user') {
    return { id: value.id, role: 'user' };
  }
  return null;
}

/** Resolve a project only when its persisted owner matches the authenticated principal. */
export function resolveOwnedProject<T extends ProjectIdentityShape>(
  projects: readonly T[],
  principal: ZeroPrincipal,
  projectId: unknown,
): T | null {
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 128) return null;
  return projects.find((project) => project.id === projectId && project.ownerId === principal.id) ?? null;
}

/** One-time migration for legacy single-admin projects; never overwrite an explicit owner. */
export function migrateProjectOwnership<T extends ProjectIdentityShape>(projects: T[]): boolean {
  let changed = false;
  for (const project of projects) {
    if (!Object.prototype.hasOwnProperty.call(project, 'ownerId')) {
      project.ownerId = ZERO_ADMIN_PRINCIPAL_ID;
      changed = true;
      continue;
    }
    const validUserOwner = typeof project.ownerId === 'string' &&
      /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(project.ownerId);
    if (project.ownerId !== ZERO_ADMIN_PRINCIPAL_ID && !validUserOwner) {
      throw new Error('Ungültige Projekt-Eigentümerschaft: ' + project.id);
    }
  }
  return changed;
}

/** Express middleware that enforces project ownership using the authenticated server principal. */
export function createProjectOwnershipMiddleware(
  loadProjects: () => Promise<readonly ProjectIdentityShape[]>,
  allowMissingDeleteRetry?: (
    projectId: string,
    principal: ZeroPrincipal,
    idempotencyKey: string,
  ) => Promise<boolean>,
): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const principal = getZeroPrincipal(res.locals);
    if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
    const projectId = req.params.id;
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 128) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    const projects = await loadProjects();
    const existingProject = projects.find((candidate) => candidate.id === projectId);
    if (!existingProject) {
      const idempotencyKey = String(res.locals.zeroRequestIdempotencyKey ?? '');
      const isAllowedRetry = req.method === 'DELETE' &&
        allowMissingDeleteRetry !== undefined &&
        await allowMissingDeleteRetry(projectId, principal, idempotencyKey);
      if (isAllowedRetry) {
        res.locals.zeroProjectId = projectId;
        return next();
      }
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    const project = resolveOwnedProject(projects, principal, projectId);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    res.locals.zeroProjectId = project.id;
    next();
  });
}

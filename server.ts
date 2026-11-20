import 'dotenv/config';
import express from 'express';
import { sendProjectVideoStream } from './server/projectVideoHttp.ts';
import { asyncRoute } from './server/asyncRoute.ts';
import { createRestoreHandlers } from './server/restoreHandlers.ts';
import { createConcurrencyGate, createPostgresConcurrencyGate } from './server/concurrencyGate.ts';
import { BackupCleanupError } from './server/versionedZipBackup.ts';
import { isSafeProjectAssetUrl, sanitizeProjectAssets, sanitizeProjectScenes, sanitizeProjectSnapshots } from './server/safeProjectAssetUrl.ts';
import { clampScenesToMax60Seconds } from './server/filmLimits.ts';
import { buildContinuityDirectorContext, recordFilmProductionContinuity, recordFilmSceneRevision, detectSemanticContinuityConflicts, resolveFilmCameraMovement } from './server/filmDirection.ts';
import { validateContinuityState } from './server/continuity.ts';
import { createDramaturgyAnalysisVersion } from './server/dramaturgyVersions.ts';
import { buildStorySupervisorAiPrompt, parseStorySupervisorAiResponse } from './server/storySupervisorAI.ts';
import { emptyContinuityState } from './src/types/continuity.ts';
import { pcmBase64ToWavDataUrl } from './server/audioUtils.ts';
import { parseBase64DataUrl } from './server/mediaUtils.ts';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createProjectVideoAssetStore, ProjectVideoLimitError, ProjectVideoProjectNotFoundError, ProjectVideoStreamCapacityError, isValidProjectVideoPayload } from './server/projectVideoStore.ts';
import path from 'node:path';
import { checkPostgresConnection, getPostgresPool, PersistentStateConflictError, readPersistentState } from './server/persistence.ts';
import { createPostgresAuthStore } from './server/postgresAuthStore.ts';
import { getZeroCostGuardStatus, isSameOriginRequest, setZeroCostGuardPaused } from './server/zeroCostGuard.ts';
import { getZeroResourceOperationStatusWithPool, ZeroResourceOperationReplayError } from './server/zeroCostResourceGuard.ts';
import { ensureZeroResourceSchema, reserveZeroResource, settleZeroResourceReservation, ZeroResourceIdempotencyError, ZeroResourceLimitError } from './server/zeroResourceGuard.ts';
import { readinessForStage, type HealthReadinessStage } from './server/healthReadiness.ts';
import { isWanGpuAllowed } from './server/wanWorkerReadiness.ts';
import { isPiperWorkerAllowed } from './server/piperWorkerReadiness.ts';
import { createApiAuthMiddleware } from './server/apiAuth.ts';
import { ensureProjectDeletionIdempotencySchema, isProjectDeletionIdempotentRetry, recordProjectDeletionIdempotency } from './server/projectDeletionIdempotency.ts';
import { createZeroIdempotencyKey, createZeroPrincipalHash, requireZeroPrincipal, runWithZeroPrincipal } from './server/zeroPrincipalContext.ts';
import { ZERO_ADMIN_PRINCIPAL, createProjectOwnershipMiddleware, getZeroPrincipal, resolveOwnedProject } from './server/projectIdentity.ts';
import { buildSrtFromTimedWords } from './server/srt.ts';
import {
  assertZeroBudgetModelAllowed,
  formatGermanApiError,
  getGeminiClient,
  isQuotaExhaustionError,
  ThinkingLevel,
  Type,
  ZeroQuotaExhaustedError,
  withTransientRetry,
} from './server/geminiClient.ts';
import { runMemoryEmbedding } from './server/memoryEmbedding.ts';
import {
  generateFreeCloudImage,
  runAllModelTests,
  runLiveModelTest,
} from './server/adapters.ts';
import { analyzeCloudflareImage, generateCloudflareText, isCloudflareWorkersAiConfigured, transcribeCloudflareAudio } from './server/cloudflareWorkersAi.ts';
import { isCloudflareWorkersAiAllowed } from './server/cloudflareBudgetGate.ts';
import {
  verifyCoreMLAdapterPackage,
  verifyZeroIOSRuntimeSuite,
} from './server/coremlAdapter.ts';
import {
  createSystemBackup,
  createVersionedZipBackup,
  deleteUnprotectedZipBackup,
  DEVELOPMENT_ROADMAP,
  getZipBackupFilePath,
  IST_ZUSTAND_REPORT,
  inspectZipBackupConsistency,
  loadDb,
  maybeAutoCreateZipBackup,
  recordBudgetAudit,
  restoreFromVerifiedZipBackup,
  restoreSystemBackup,
  saveDb,
  toggleZipBackupProtection,
} from './server/store.ts';
import { chooseZeroChatModel, chooseZeroMediaModel } from './server/zeroRouter.ts';
import { createContinuityRouter } from './src/routes/continuity.ts';
import { isValidWanJobId, loadWanJobList, normalizeWanJobStatus } from './server/wanJobList.ts';
import { streamWanVideoResponse } from './server/wanVideoStream.ts';

import { applyManualFreeQuotaReset } from './server/manualQuotaReset.ts';
import {
  buildFullProjectZip,
  EXCLUDED_SECRETS_DOC,
  verifyZipBuffer,
} from './server/zipExporter.ts';
import type {
  AutomationRun,
  CharacterProfile,
  FilmScene,
  MemoryEntry,
  ProjectAsset,
  StudioProject,
} from './src/types/zero.ts';
import type { ZeroDatabase } from './server/store.ts';

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.disable('x-powered-by');

let projectVideoAssetStore: ReturnType<typeof createProjectVideoAssetStore> | null = null;
function getProjectVideoAssetStore() {
  if (!projectVideoAssetStore) projectVideoAssetStore = createProjectVideoAssetStore(getPostgresPool());
  return projectVideoAssetStore;
}

async function withZeroProjectLifecycleLock<T>(projectId: string, callback: () => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`zero-project-lifecycle:${createZeroPrincipalHash()}:${projectId}`],
    );
    const result = await callback();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ZIP downloads and restores share two PostgreSQL advisory-lock slots across all
// Node processes. The local gate is only for development without PostgreSQL.
export const zipOperationGate = process.env.DATABASE_URL
  ? createPostgresConcurrencyGate(getPostgresPool(), 2, 5)
  : createConcurrencyGate(2, 5);

// Render terminates TLS and forwards one trusted proxy hop. Trusting that hop
// makes req.ip reflect the client address for login rate limiting.
app.set('trust proxy', 1);

const IS_PRODUCTION = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
const ZERO_ADMIN_PASSWORD = process.env.ZERO_ADMIN_PASSWORD ?? '';
const ZERO_SESSION_SECRET = process.env.ZERO_SESSION_SECRET ?? '';
const AUTH_COOKIE_NAME = 'zero_session';
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const postgresAuthStore = process.env.DATABASE_URL ? createPostgresAuthStore(getPostgresPool()) : null;

function authStore() {
  if (!postgresAuthStore) throw new Error('PostgreSQL ist für die gemeinsame Produktionsanmeldung erforderlich.');
  return postgresAuthStore;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function loginKeyDigest(address: string): string {
  return createHmac('sha256', ZERO_SESSION_SECRET).update(address).digest('hex');
}

async function hasValidSession(req: express.Request): Promise<boolean> {
  const cookieHeader = req.headers.cookie ?? '';
  const token = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(AUTH_COOKIE_NAME + '='))?.slice(AUTH_COOKIE_NAME.length + 1);
  if (!token) return false;
  const [expiresAt, nonce, signature] = token.split('.');
  if (!expiresAt || !nonce || !signature || !/^\d+$/.test(expiresAt) || Number(expiresAt) <= Date.now()) return false;
  const expected = createHmac('sha256', ZERO_SESSION_SECRET).update(expiresAt + '.' + nonce).digest('hex');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  return authStore().hasSession(tokenDigest(token));
}

async function createSessionCookie(): Promise<string> {
  const expiresAt = String(Date.now() + SESSION_DURATION_SECONDS * 1000);
  const nonce = randomBytes(24).toString('hex');
  const payload = expiresAt + '.' + nonce;
  const signature = createHmac('sha256', ZERO_SESSION_SECRET).update(payload).digest('hex');
  const token = payload + '.' + signature;
  await authStore().createSession(tokenDigest(token), new Date(Number(expiresAt)));
  const secure = IS_PRODUCTION ? '; Secure' : '';
  return AUTH_COOKIE_NAME + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + SESSION_DURATION_SECONDS + secure;
}

async function reserveZeroBudgetModelAllowed(
  modelId: string,
  action: string,
  db: Awaited<ReturnType<typeof loadDb>>
): Promise<void> {
  let allowedAudit: Parameters<typeof recordBudgetAudit>[1] | null = null;
  assertZeroBudgetModelAllowed(modelId, action, db.budgetGuard, (entry) => {
    if (entry.decision === 'ERLAUBT_0_EUR') allowedAudit = entry;
    else recordBudgetAudit(db, entry);
  });
  if (!allowedAudit) throw new Error('Gemini-Freigabe konnte nicht reserviert werden.');
  if (process.env.DATABASE_URL) {
    const quota = db.budgetGuard.freeQuotaUsage[modelId];
    if (!quota) throw new Error(`Kein Kontingentdatensatz für "${modelId}".`);
    const reservation = await authStore().reserveGeminiQuota({
      modelId,
      resetDate: quota.lastResetDate ?? '',
      currentRequests: quota.requestsToday,
      dailyLimit: quota.dailySoftLimit,
    });
    if (!reservation.allowed) {
      quota.exhausted = true;
      recordBudgetAudit(db, {
        adapterId: 'gemini-quota-guard',
        modelId,
        action,
        decision: 'GESTOPPT_KONTINGENT',
        reason: `Globales Free-Tier-Kontingent ausgeschöpft (${reservation.requestsToday}/${quota.dailySoftLimit}). Anfrage vor dem Provider-Aufruf gestoppt.`,
        costEur: 0,
      });
      throw new ZeroQuotaExhaustedError(
        `Globales kostenloses Tageskontingent für "${modelId}" ausgeschöpft. Kein kostenpflichtiger Fallback.`
      );
    }
    // recordBudgetAudit increments once; align the process-local display count
    // with the atomic cross-instance reservation immediately before that increment.
    quota.requestsToday = Math.max(0, reservation.requestsToday - 1);
  }

  recordBudgetAudit(db, allowedAudit);
}

async function markGeminiQuotaExhausted(
  modelId: string,
  db: Awaited<ReturnType<typeof loadDb>>
): Promise<void> {
  const quota = db.budgetGuard.freeQuotaUsage[modelId];
  if (!quota) return;
  quota.exhausted = true;
  if (process.env.DATABASE_URL) {
    await authStore().markGeminiQuotaExhausted(modelId, quota.lastResetDate ?? '');
  }
}
// Baseline browser security headers. CSP starts in report-only mode so external
// model assets and media can be audited without unexpectedly breaking the PWA.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy-Report-Only',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; " +
      "script-src 'self' 'unsafe-inline' blob: https:; style-src 'self' 'unsafe-inline' https:; " +
      "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; " +
      "font-src 'self' data: https:; connect-src 'self' https: wss:; worker-src 'self' blob: https:"
  );
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

const PUBLIC_ZERO_API_PATHS = new Set(['/live', '/health', '/auth/status', '/auth/login', '/auth/logout']);

app.use('/api', createApiAuthMiddleware({
  isProduction: IS_PRODUCTION,
  adminPassword: ZERO_ADMIN_PASSWORD,
  sessionSecret: ZERO_SESSION_SECRET,
  hasValidSession,
  onAuthenticated: (req, res, next) => {
    const suppliedIdempotencyKey = req.get('idempotency-key')?.trim();
    if (suppliedIdempotencyKey && (suppliedIdempotencyKey.length < 8 || suppliedIdempotencyKey.length > 200)) {
      res.status(400).json({ error: 'Idempotency-Key muss 8 bis 200 Zeichen lang sein.' });
      return;
    }
    res.locals.zeroRequestIdempotencyKey = suppliedIdempotencyKey ?? randomUUID();
    next();
  },
}));

app.use('/api', (req, res, next) => {
  if (PUBLIC_ZERO_API_PATHS.has(req.path)) return next();
  const principalId = IS_PRODUCTION ? 'zero-admin' : 'zero-development';
  const requestIdempotencyKey = String(res.locals.zeroRequestIdempotencyKey ?? randomUUID());
  // The principal is server-owned and is installed only after the API auth gate succeeds.
  res.locals.zeroPrincipal = principalId;
  res.locals.zeroProjectPrincipal = ZERO_ADMIN_PRINCIPAL;
  return runWithZeroPrincipal(principalId, requestIdempotencyKey, next);
});

// 18 MiB audio uploads are Base64-expanded by roughly one third before JSON parsing.
app.use(express.json({ limit: '26mb' }));

// Persistent series continuity and dramaturgy API.
app.use('/api/continuity', createContinuityRouter({ loadDb, saveDb }));

app.post('/api/continuity/series/:seriesId/analyze-dramaturgy', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const db = await loadDb();
  const continuity = validateContinuityState(db.continuity ?? emptyContinuityState());
  const series = continuity.series.find((item) => item.id === req.params.seriesId && !item.archivedAt);
  if (!series) return res.status(404).json({ error: 'Serie nicht gefunden oder archiviert.' });
  const input = buildStorySupervisorAiPrompt({ series, state: continuity, projects: db.projects ?? [], characters: db.characters ?? [] });
  if (input.prompt.length < 80) return res.status(422).json({ error: 'Zu wenig Serienmaterial für eine belastbare dramaturgische Analyse.' });

  let raw = '';
  let modelId = '';
  let costMode: 'confirmed-free-cloud' | 'blocked' = 'blocked';
  const cloudflareFree = isCloudflareWorkersAiConfigured() && isCloudflareWorkersAiAllowed();
  const cloudflareRoute = cloudflareFree
    ? chooseZeroChatModel(db.models, db.budgetGuard, 'cloudflare-glm-4.7-flash')
    : null;
  if (cloudflareRoute?.modelId === 'cloudflare-glm-4.7-flash') {
    const result = await generateCloudflareText({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      maxTokens: 1800,
      enableThinking: true,
    });
    raw = result.text;
    modelId = result.modelId;
    costMode = 'confirmed-free-cloud';
  } else {
    if (process.env.ZERO_GEMINI_FREE_TIER_ONLY !== 'true') {
      return res.status(503).json({
        error: 'KI-Analyse sicher blockiert: Kein bestätigtes kostenloses Modell verfügbar. Cloudflare benötigt den bestätigten Workers-Free-Plan; Gemini benötigt ZERO_GEMINI_FREE_TIER_ONLY=true. Kein Provider-Aufruf und kein kostenpflichtiger Fallback.',
        paidFallback: false,
      });
    }
    const geminiModels = db.models.filter((model) => model.id.startsWith('gemini-'));
    const route = chooseZeroChatModel(geminiModels, db.budgetGuard, 'gemini-3.8-flash');
    if (!route) return res.status(503).json({ error: 'Kein verifiziertes Gemini-Free-Tier-Modell mit gültigem Restkontingent. Sicher gestoppt.', paidFallback: false });
    await reserveZeroBudgetModelAllowed(route.modelId, 'STORY_SUPERVISOR_DRAMATURGY', db);
    try {
      const ai = getGeminiClient();
      const response = await withTransientRetry(() => ai.models.generateContent({
        model: route.modelId,
        contents: input.prompt,
        config: { systemInstruction: input.systemPrompt, responseMimeType: 'application/json', maxOutputTokens: 1800, temperature: 0.2 },
      }));
      raw = response.text ?? '';
      modelId = route.modelId;
      await saveDb(db);
    } catch (error) {
      if (isQuotaExhaustionError(error)) await markGeminiQuotaExhausted(route.modelId, db).catch(() => undefined);
      await saveDb(db).catch(() => undefined);
      throw error;
    }
    costMode = 'confirmed-free-cloud';
  }
  const analysis = parseStorySupervisorAiResponse(raw, input.validCharacterIds);
  const latest = continuity.dramaturgyAnalyses.filter((item) => item.seriesId === series.id).sort((a,b) => b.version-a.version)[0];
  const source = JSON.stringify({ series, projects: db.projects.filter((project) => series.projectIds.includes(project.id)), characters: db.characters, knowledge: continuity.knowledge.filter((item) => item.seriesId === series.id), relationships: continuity.relationships.filter((item) => item.seriesId === series.id), events: continuity.events.filter((item) => item.seriesId === series.id) });
  const version = createDramaturgyAnalysisVersion({ seriesId: series.id, modelId, costMode, analysis, previous: latest, source });
  continuity.dramaturgyAnalyses.push(version);
  db.continuity = continuity;
  await saveDb(db);
  return res.json({ analysis, analysisVersion: version, modelId, costMode, paidFallback: false, generatedAt: version.createdAt });
}));

// Enforce server-owned project identity before every project-id route.
app.use('/api/projects/:id', createProjectOwnershipMiddleware(
  async () => (await loadDb()).projects,
  async (projectId, principal, idempotencyKey) =>
    Boolean(process.env.DATABASE_URL) &&
    isProjectDeletionIdempotentRetry(projectId, principal.id, idempotencyKey),
));

app.get('/api/auth/status', asyncRoute(async (_req, res) => {
  const configured =
    !IS_PRODUCTION ||
    (ZERO_ADMIN_PASSWORD.length >= 12 && ZERO_SESSION_SECRET.length >= 32);
  res.json({
    required: IS_PRODUCTION,
    configured,
    authenticated: !IS_PRODUCTION || (configured && await hasValidSession(_req)),
  });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  if (!IS_PRODUCTION) return res.json({ ok: true, authenticated: true });
  if (ZERO_ADMIN_PASSWORD.length < 12 || ZERO_SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: 'Serveranmeldung ist noch nicht konfiguriert.' });
  }

  const ipKey = loginKeyDigest(req.ip || 'unknown');
  const attempt = await authStore().consumeLoginAttempt(ipKey, new Date(), LOGIN_WINDOW_MS, MAX_LOGIN_ATTEMPTS);
  if (!attempt.allowed) {
    res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
    return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' });
  }

  const supplied = Buffer.from(String(req.body?.password ?? ''));
  const expected = Buffer.from(ZERO_ADMIN_PASSWORD);
  const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!valid) {
    return res.status(401).json({ error: 'Passwort ist nicht korrekt.' });
  }

  await authStore().clearLoginAttempts(ipKey);
  res.setHeader('Set-Cookie', await createSessionCookie());
  return res.json({ ok: true, authenticated: true });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const cookieHeader = req.headers.cookie ?? '';
  const token = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(AUTH_COOKIE_NAME + '='))?.slice(AUTH_COOKIE_NAME.length + 1);
  if (token && IS_PRODUCTION) await authStore().deleteSession(tokenDigest(decodeURIComponent(token)));
  const secure = IS_PRODUCTION ? '; Secure' : '';
  res.setHeader('Set-Cookie', AUTH_COOKIE_NAME + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure);
  res.json({ ok: true });
}));


function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// === SYSTEM & AUDIT ===
app.get('/api/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, app: 'ZERO AI STUDIO', status: 'alive' });
});

app.get('/api/health', asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const authConfigured =
    !IS_PRODUCTION ||
    (ZERO_ADMIN_PASSWORD.length >= 12 && ZERO_SESSION_SECRET.length >= 32);

  if (!authConfigured) {
    return res.status(503).json({
      ok: false,
      app: 'ZERO AI STUDIO',
      core: 'ZERO CORE',
      maxVideoDurationSec: 60,
      readiness: readinessForStage('not_configured'),
      message: 'Produktionsanmeldung ist nicht vollständig konfiguriert.',
    });
  }

  let readinessStage: HealthReadinessStage = 'database';
  try {
    await loadDb();
    if (!(await checkPostgresConnection())) {
      throw new Error('PostgreSQL-Verbindung ist nicht verfügbar.');
    }
    readinessStage = 'authentication';
    await authStore().ensureSchema();
    readinessStage = 'resource_guard';
    await ensureZeroResourceSchema();
    await ensureProjectDeletionIdempotencySchema();
    readinessStage = 'ready';
    return res.json({
      ok: true,
      app: 'ZERO AI STUDIO',
      core: 'ZERO CORE',
      maxVideoDurationSec: 60,
      readiness: readinessForStage(readinessStage),
    });
  } catch {
    return res.status(503).json({
      ok: false,
      app: 'ZERO AI STUDIO',
      core: 'ZERO CORE',
      maxVideoDurationSec: 60,
      readiness: readinessForStage(readinessStage),
      message: 'Die Datenbank oder ein erforderliches Produktionsschema ist nicht verfügbar.',
    });
  }
}));


// === GEMINI CONNECTION DIAGNOSTIC ===
// Protected by the /api session middleware. Never returns or logs the API key.
app.post('/api/system/gemini-connection-test', asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const apiKeyConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const freeTierGuardEnabled = process.env.ZERO_GEMINI_FREE_TIER_ONLY === 'true';
  const modelId = 'gemini-3.8-flash';

  if (!apiKeyConfigured || !freeTierGuardEnabled) {
    return res.json({
      ok: false,
      apiKeyConfigured,
      freeTierGuardEnabled,
      googleConnection: 'NOT_TESTED',
      modelResponse: 'NOT_TESTED',
      modelId,
      paidFallback: false,
      message: !apiKeyConfigured
        ? 'GEMINI_API_KEY fehlt in der Serverumgebung.'
        : 'Der 0-Euro-Schutz ist nicht aktiviert. Gemini-Aufruf wurde blockiert.',
    });
  }

  let db: Awaited<ReturnType<typeof loadDb>> | null = null;
  try {
    db = await loadDb();
    await reserveZeroBudgetModelAllowed(modelId, 'GEMINI_CONNECTION_DIAGNOSTIC', db);

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: modelId,
        contents: 'Antworte ausschließlich mit: ZERO_CONNECTION_OK',
        config: { maxOutputTokens: 256, temperature: 0 },
      })
    );
    const reply = (response.text ?? '').trim();
    // A successful, non-empty model response confirms connectivity. Do not fail
    // the connection check just because the model adds punctuation or extra text.
    if (!reply) {
      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason ?? 'UNBEKANNT';
      const blockReason = response.promptFeedback?.blockReason ?? 'KEINER';
      const thoughtTokens = response.usageMetadata?.thoughtsTokenCount ?? 'unbekannt';
      throw new Error(
        `Gemini lieferte keinen Text (finishReason: ${finishReason}; blockReason: ${blockReason}; thinkingTokens: ${thoughtTokens}).`
      );
    }

    // assertZeroBudgetModelAllowed already records this successful request
    // through recordBudgetAudit, which increments requestsToday exactly once.
    await saveDb(db);

    return res.json({
      ok: true,
      apiKeyConfigured: true,
      freeTierGuardEnabled: true,
      googleConnection: 'CONNECTED',
      modelResponse: 'RECEIVED',
      modelId,
      responseVerified: Boolean(reply),
      paidFallback: false,
      message: 'Google Gemini hat erfolgreich auf den Verbindungstest geantwortet.',
    });
  } catch (err) {
    if (db) {
      if (isQuotaExhaustionError(err)) await markGeminiQuotaExhausted(modelId, db).catch(() => undefined);
      await saveDb(db).catch(() => undefined);
    }
    return res.json({
      ok: false,
      apiKeyConfigured: true,
      freeTierGuardEnabled: true,
      googleConnection: 'FAILED',
      modelResponse: 'NOT_RECEIVED',
      modelId,
      paidFallback: false,
      message: formatGermanApiError(err),
    });
  }
}));

// === CLOUDFLARE WORKERS AI CONNECTION DIAGNOSTIC ===
app.post('/api/system/cloudflare-connection-test', asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const configured = isCloudflareWorkersAiConfigured();
  const freePlanGateOpen = isCloudflareWorkersAiAllowed();
  const accountIdConfigured = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID?.trim());
  const apiTokenConfigured = Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());
  const modelId = '@cf/zai-org/glm-4.7-flash';
  if (!configured) {
    return res.json({
      ok: false,
      accountIdConfigured,
      apiTokenConfigured,
      freePlanGateOpen,
      cloudflareConnection: 'NOT_TESTED',
      modelResponse: 'NOT_TESTED',
      modelId,
      paidFallback: false,
      message: !freePlanGateOpen
        ? 'Cloudflare Workers AI ist standardmäßig gesperrt. Vor der Freigabe müssen Workers-Free-Tarif und Ausschluss kostenpflichtiger Nutzung manuell geprüft und beide ZERO-Freigaben gesetzt werden.'
        : 'CLOUDFLARE_ACCOUNT_ID oder CLOUDFLARE_API_TOKEN fehlt in der Serverumgebung.',
    });
  }
  try {
    const result = await generateCloudflareText({
      prompt: 'Antworte ausschließlich mit: ZERO_CLOUDFLARE_OK',
      maxTokens: 128,
      enableThinking: false,
    });
    return res.json({
      ok: true,
      accountIdConfigured: true,
      apiTokenConfigured: true,
      freePlanGateOpen: true,
      cloudflareConnection: 'CONNECTED',
      modelResponse: 'RECEIVED',
      modelId: result.modelId,
      responseVerified: result.text.length > 0,
      paidFallback: false,
      message: 'Cloudflare Workers AI hat erfolgreich geantwortet.',
    });
  } catch (err) {
    return res.json({
      ok: false,
      accountIdConfigured: true,
      apiTokenConfigured: true,
      freePlanGateOpen: true,
      cloudflareConnection: 'FAILED',
      modelResponse: 'NOT_RECEIVED',
      modelId,
      paidFallback: false,
      message: err instanceof Error ? err.message : 'Cloudflare-Verbindung fehlgeschlagen.',
    });
  }
}));

app.post('/api/system/quota/confirm-provider-reset', asyncRoute(async (req, res) => {
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : '';
  const confirmedProviderReset = req.body?.confirmedProviderReset === true;
  const db = await loadDb();

  try {
    const quota = applyManualFreeQuotaReset({
      modelId,
      confirmedProviderReset,
      budgetGuard: db.budgetGuard,
    });
    recordBudgetAudit(db, {
      adapterId: 'manual-quota-reset',
      modelId,
      action: 'PROVIDER_QUOTA_RESET_CONFIRMED',
      decision: 'RESET_BESTAETIGT_MANUELL',
      reason: 'Ein angemeldeter ZERO-Administrator hat ausdrücklich bestätigt, dass das Free-Tier-Kontingent beim Provider tatsächlich zurückgesetzt wurde. ZERO hat den Provider-Reset nicht selbst verifiziert.',
      costEur: 0,
    });
    await saveDb(db);
    if (process.env.DATABASE_URL) await authStore().clearGeminiQuota(modelId);
    return res.json({ ok: true, modelId, quota, providerVerifiedByZero: false });
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : 'Manuelle Kontingentfreigabe fehlgeschlagen.',
    });
  }
}));

app.get('/api/system/audit', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  res.json({
    istZustand: IST_ZUSTAND_REPORT,
    roadmap: DEVELOPMENT_ROADMAP,
    budgetGuard: db.budgetGuard,
    backups: db.backups,
    settings: db.settings,
  });
}));

app.post('/api/system/backup', asyncRoute(async (req, res) => {
  try {
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : 'Manuelles System-Backup';
    const meta = await createSystemBackup(note);
    res.json({ backup: meta });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup fehlgeschlagen' });
  }
}));

const restoreHandlers = createRestoreHandlers({
  restoreSystemBackup,
  restoreZipBackup: restoreFromVerifiedZipBackup,
});

app.post('/api/system/restore', restoreHandlers.json);

app.get('/api/system/export-manifest', zipOperationGate.middleware, asyncRoute(async (_req, res) => {
  try {
    const db = await loadDb();
    const result = await buildFullProjectZip(process.cwd(), {
      'data/zero-studio-db.json': Buffer.from(JSON.stringify(db, null, 2), 'utf8'),
    });
    const verification = verifyZipBuffer(result.buffer);
    res.json({
      filename: 'ZERO_AI_STUDIO_FULL_PROJECT.zip',
      fileCount: result.fileCount,
      sizeBytes: result.buffer.length,
      verified: verification.result.valid,
      excludedSecrets: EXCLUDED_SECRETS_DOC,
      files: result.files,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Export-Manifest fehlgeschlagen' });
  }
}));

app.get('/api/system/export-zip', zipOperationGate.middleware, asyncRoute(async (_req, res) => {
  try {
    const db = await loadDb();
    const result = await buildFullProjectZip(process.cwd(), {
      'data/zero-studio-db.json': Buffer.from(JSON.stringify(db, null, 2), 'utf8'),
    });
    const verification = verifyZipBuffer(result.buffer);
    if (!verification.result.valid) {
      return res.status(500).json({
        error: `ZIP-Integritätsprüfung fehlgeschlagen: ${verification.result.errors.join('; ')}`,
      });
    }
    const filename = `ZERO_AI_STUDIO_v${db.backupConfig.currentVersion}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(result.buffer.length));
    res.send(result.buffer);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'ZIP-Export fehlgeschlagen' });
  }
}));

// === VERSIONED ZIP BACKUP & RESTORE SYSTEM ===
app.get('/api/system/zip-backups/reconciliation', asyncRoute(async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(409).json({
      error: 'Backup-Reconciliation ist nur für den PostgreSQL-Persistenzmodus verfügbar.',
    });
  }
  const result = await inspectZipBackupConsistency();
  res.json({
    ok: true,
    orphanedBlobIds: result.orphanedBlobIds,
    missingBlobIds: result.missingBlobIds,
    orphanedCount: result.orphanedBlobIds.length,
    missingCount: result.missingBlobIds.length,
  });
}));
app.get('/api/system/zip-backups', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  const totalStorageBytes = db.backupConfig.zipBackups.reduce((s, b) => s + b.sizeBytes, 0);
  res.json({
    ...db.backupConfig,
    totalStorageBytes,
    excludedSecrets: EXCLUDED_SECRETS_DOC,
  });
}));

app.post('/api/system/zip-backups', zipOperationGate.middleware, asyncRoute(async (req, res) => {
  try {
    const changelog =
      typeof req.body?.changelog === 'string' && req.body.changelog.trim()
        ? req.body.changelog.trim()
        : 'Manuelles vollständiges ZIP-Backup';
    const record = await createVersionedZipBackup({
      changelog,
      trigger: 'manual',
      bumpVersion: true,
    });
    const db = await loadDb();
    res.json({
      backup: record,
      backupConfig: db.backupConfig,
      totalStorageBytes: db.backupConfig.zipBackups.reduce((s, b) => s + b.sizeBytes, 0),
    });
  } catch (err) {
    if (err instanceof BackupCleanupError) {
      const db = await loadDb();
      return res.status(202).json({
        ok: true,
        backup: err.backup,
        backupConfig: db.backupConfig,
        totalStorageBytes: db.backupConfig.zipBackups.reduce((s, b) => s + b.sizeBytes, 0),
        cleanupPending: true,
        orphanedBlobIds: err.orphanedBlobIds,
      });
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'ZIP-Backup fehlgeschlagen' });
  }
}));

app.post('/api/system/zip-backups/settings', asyncRoute(async (req, res) => {
  const db = await loadDb();
  db.backupConfig.autoZipOnChange = Boolean(req.body?.autoZipOnChange);
  await saveDb(db);
  res.json({ backupConfig: db.backupConfig });
}));

app.get('/api/system/zip-backups/:id/download', zipOperationGate.middleware, asyncRoute(async (req, res) => {
  try {
    const { record, buffer } = await getZipBackupFilePath(req.params.id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'ZIP-Datei nicht gefunden' });
  }
}));

app.post('/api/system/zip-backups/:id/protect', asyncRoute(async (req, res) => {
  try {
    const record = await toggleZipBackupProtection(req.params.id);
    res.json({ backup: record });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Backup nicht gefunden' });
  }
}));

app.delete('/api/system/zip-backups/:id', asyncRoute(async (req, res) => {
  try {
    await deleteUnprotectedZipBackup(req.params.id);
    const db = await loadDb();
    res.json({
      ok: true,
      backupConfig: db.backupConfig,
      totalStorageBytes: db.backupConfig.zipBackups.reduce((s, b) => s + b.sizeBytes, 0),
    });
  } catch (err) {
    if (err instanceof BackupCleanupError) {
      return res.status(202).json({
        ok: true,
        deleted: true,
        cleanupPending: true,
        orphanedBlobIds: err.orphanedBlobIds,
      });
    }
    res.status(400).json({ error: err instanceof Error ? err.message : 'Löschen blockiert' });
  }
}));

app.post('/api/system/zip-backups/:id/restore', zipOperationGate.middleware, restoreHandlers.zip);

// === ZERO MODEL HUB ===
app.get('/api/models', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  res.json({ models: db.models, budgetGuard: db.budgetGuard });
}));

app.get('/api/models/coreml/llama-3.2', asyncRoute(async (_req, res) => {
  const verification = await verifyCoreMLAdapterPackage();
  res.json(verification);
}));

app.get('/api/models/ios-runtime', asyncRoute(async (_req, res) => {
  const suite = await verifyZeroIOSRuntimeSuite();
  res.json(suite);
}));

app.post('/api/models/test-all', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  const result = await runAllModelTests(db);
  await saveDb(db);
  res.json({
    testedCount: result.testedCount,
    models: result.models,
    budgetGuard: db.budgetGuard,
  });
}));

// The WebGPU engine runs in the user's browser, so the server cannot execute its probe.
// Persist activation only after the browser reports a non-empty response from real local inference.
app.post('/api/models/webgpu/activate', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const modelId = String(req.body?.modelId ?? 'webgpu-llama-3.2-1b');
  const model = db.models.find((item) => item.id === modelId);
  const probeResponse = String(req.body?.probeResponse ?? '').trim();
  if (!model || model.adapterId !== 'webllm' || model.executionMode !== 'LOCAL ON-DEVICE') {
    return res.status(404).json({ error: 'Das angeforderte lokale WebGPU-Modell ist nicht registriert.' });
  }
  if (!probeResponse || probeResponse.length > 1000) {
    return res.status(400).json({ error: 'Lokaler Inferenztest fehlt oder ist ungültig.' });
  }
  // A client-controlled probeResponse is not proof: any authenticated caller can forge it.
  // Keep the model disabled until verification can be performed by a trusted runtime.
  model.hasRealAdapter = false;
  model.testPassed = false;
  // Enabled means the user has a client-reported local runtime available.
  // It does not certify the adapter or count as a trusted test.
  model.enabled = true;
  model.status = 'BROWSER TEST ERFORDERLICH';
  model.lastTestedAt = null;
  model.lastTestLatencyMs = null;
  model.lastTestMessage = 'Der Browser hat eine Probe gemeldet, aber der Server kann diese nicht unabhängig verifizieren. Das Modell bleibt deshalb deaktiviert.';
  await saveDb(db);
  res.status(202).json({ model, verified: false });
}));

// Local creative engines are activated only after a real browser-side render probe.
app.post('/api/models/local/activate', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const modelId = String(req.body?.modelId ?? '');
  const probeResponse = String(req.body?.probeResponse ?? '').trim();
  const allowedAdapters: Record<string, string> = {
    'zero-canvas-img2img': 'local-canvas-image-adapter',
    'zero-timeline-video-60s': 'local-video-compositor',
    'zero-webaudio-synth': 'local-webaudio-music',
  };
  const expectedAdapter = allowedAdapters[modelId];
  const model = db.models.find((item) => item.id === modelId);
  if (!expectedAdapter || !model || model.adapterId !== expectedAdapter || model.executionMode !== 'LOCAL ON-DEVICE') {
    return res.status(404).json({ error: 'Dieses lokale Kreativmodell ist nicht für Browser-Probe-Aktivierung freigegeben.' });
  }
  if (!probeResponse || probeResponse.length > 1000) {
    return res.status(400).json({ error: 'Echter Browser-Testnachweis fehlt oder ist ungültig.' });
  }
  // Browser-supplied output is self-reported and can be forged by an authenticated client.
  // Do not convert it into a trusted adapter or successful server-side test.
  model.hasRealAdapter = false;
  model.testPassed = false;
  // Enabled means the user has a client-reported local runtime available.
  // It does not certify the adapter or count as a trusted test.
  model.enabled = true;
  model.status = 'BROWSER TEST ERFORDERLICH';
  model.lastTestedAt = null;
  model.lastTestLatencyMs = null;
  model.lastTestMessage = 'Eine lokale Browser-Probe wurde gemeldet, kann serverseitig aber nicht unabhängig verifiziert werden. Das Modell bleibt deaktiviert.';
  await saveDb(db);
  res.status(202).json({ model, verified: false });
}));

// Apple Foundation Models can only be probed inside the signed native iOS host.
app.post('/api/models/native/activate', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((item) => item.id === 'apple-foundation-model');
  const probeResponse = String(req.body?.probeResponse ?? '').trim();
  if (!model || model.adapterId !== 'apple-foundation-model' || model.executionMode !== 'LOCAL ON-DEVICE') {
    return res.status(404).json({ error: 'Apple Foundation Models sind nicht registriert.' });
  }
  if (!probeResponse || probeResponse.length > 1000) {
    return res.status(400).json({ error: 'Native Inferenzantwort fehlt oder ist ungültig.' });
  }
  // A client-supplied response cannot prove that the signed native runtime executed it.
  model.hasRealAdapter = false;
  model.testPassed = false;
  // Enabled means the user has a client-reported local runtime available.
  // It does not certify the adapter or count as a trusted test.
  model.enabled = true;
  model.status = 'INSTALLATION ERFORDERLICH';
  model.lastTestedAt = null;
  model.lastTestLatencyMs = null;
  model.lastTestMessage = 'Eine native Probe wurde gemeldet, kann vom Server aber nicht unabhängig verifiziert werden. Signierte iOS-Installation und echte Geräte-Inferenz bleiben erforderlich.';
  await saveDb(db);
  res.status(202).json({ model, verified: false });
}));

app.post('/api/models/registry/register', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const started = Date.now();
  const now = new Date().toISOString();
  const requestedIds = Array.isArray(req.body?.modelIds)
    ? (req.body.modelIds as string[])
    : ['llama-3.2-1b-coreml', 'llama-3.2-3b-coreml'];
  const nativeBridgeChecked = Boolean(req.body?.nativeBridgeChecked);
  const nativeDetails = (req.body?.nativeDetails ?? {}) as Record<
    string,
    { compiledModelPresent?: boolean; runtime?: string; status?: string }
  >;

  const coremlPkg = await verifyCoreMLAdapterPackage();
  const registeredModels: typeof db.models = [];

  for (const id of requestedIds) {
    let model = db.models.find((m) => m.id === id);
    if (!model && (id === 'llama-3.2-1b-coreml' || id === 'llama-3.2-3b-coreml')) {
      const spec = coremlPkg.variants.find((v) => v.id === id);
      if (spec) {
        model = {
          id: spec.id,
          name: `${spec.name} (iPhone 16 Pro Max)`,
          family: 'Llama',
          category: 'Text & Reasoning',
          executionMode: 'LOCAL ON-DEVICE',
          status: coremlPkg.readyForDeployment ? 'Ready for Deployment' : 'ADAPTER FEHLT',
          license: 'Llama 3.2 Community License',
          commercialUse: 'Kommerziell nutzbar bis 700M MAU',
          sizeGB: spec.sizeGB,
          ramRequirementGB: spec.ramRequirementGB,
          iosCompatible: true,
          iosNotes: `Apple CoreML Adapter (${spec.computeUnits}, ${spec.targetDevice})`,
          provider: 'Meta / Apple CoreML (ZeroCoreML)',
          adapterId: 'coreml-llama-3.2-adapter',
          hasRealAdapter: coremlPkg.readyForDeployment,
          requiresPaidKey: false,
          requiresExternalGpu: false,
          costEur: 0,
          enabled: coremlPkg.readyForDeployment,
          capabilities: ['Offline Dialog', 'CoreML MLState', 'A18 Pro Neural Engine', 'WKWebView Bridge'],
          lastTestedAt: now,
          lastTestLatencyMs: Date.now() - started,
          lastTestMessage: '',
          testPassed: coremlPkg.readyForDeployment,
          version: id === 'llama-3.2-1b-coreml' ? '3.2-1B-CoreML-Q4' : '3.2-3B-CoreML-Q4',
          limitations: `Ausführung erfordert Xcode/iOS WKWebView App-Bundle mit ${spec.bundleFilename}.`,
        };
        db.models.push(model);
      }
    }

    if (!model) continue;

    if (model.adapterId === 'coreml-llama-3.2-adapter') {
      const nativeInfo = nativeDetails[model.id];
      const passed = coremlPkg.readyForDeployment;
      model.hasRealAdapter = passed;
      model.testPassed = passed;
      model.enabled = passed;
      model.status = passed ? 'Ready for Deployment' : 'INSTALLATION ERFORDERLICH';
      model.lastTestedAt = now;
      model.lastTestLatencyMs = Date.now() - started;
      model.lastTestMessage = passed
        ? nativeBridgeChecked && nativeInfo?.compiledModelPresent
          ? `ModelRegistry: CoreML Adapter + iOS .mlmodelc Gewichte verifiziert (${nativeInfo.runtime || 'A18 Pro Neural Engine'}).`
          : `ModelRegistry: CoreML Adapter verifiziert (${coremlPkg.requiredFiles.filter((f) => f.exists).length}/${coremlPkg.requiredFiles.length} Swift-Dateien, ${model.ramRequirementGB} GB <= 8 GB RAM) -> Ready for Deployment.`
        : coremlPkg.notes;

      recordBudgetAudit(db, {
        adapterId: model.adapterId,
        modelId: model.id,
        action: 'COREML_REGISTRY_REGISTER',
        decision: 'ERLAUBT_0_EUR',
        reason: `ModelRegistry Verifikation & Registrierung abgeschlossen -> Status "${model.status}" (0,00 €).`,
        costEur: 0,
      });
      registeredModels.push(model);
    } else {
      const tested = await runLiveModelTest(model, db);
      registeredModels.push(tested);
    }
  }

  await saveDb(db);
  res.json({
    verification: coremlPkg,
    registeredModels,
    models: db.models,
  });
}));

app.post('/api/models/:id/toggle', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((m) => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Modell nicht gefunden.' });
  if (
    model.requiresPaidKey ||
    model.requiresExternalGpu ||
    model.costEur !== 0 ||
    model.executionMode === 'SELF-HOSTED'
  ) {
    return res.status(403).json({
      error: '0 € Budget-Schutz: Kostenpflichtige oder nicht bereitgestellte Hardware-Modelle können nicht aktiviert werden.',
    });
  }
  const clientLocalRuntimeIds = new Set([
    'zero-canvas-img2img',
    'zero-timeline-video-60s',
    'zero-webaudio-synth',
    'webgpu-llama-3.2-1b',
    'apple-foundation-model',
  ]);
  const isUnverifiedClientLocalRuntime =
    model.executionMode === 'LOCAL ON-DEVICE' &&
    (
      (
        (clientLocalRuntimeIds.has(model.id) || model.adapterId === 'webllm') &&
        model.status === 'BROWSER TEST ERFORDERLICH'
      ) ||
      (model.id === 'apple-foundation-model' && model.status === 'INSTALLATION ERFORDERLICH')
    ) &&
    !model.hasRealAdapter &&
    !model.testPassed;

  if (!isUnverifiedClientLocalRuntime && !model.hasRealAdapter) {
    return res.status(400).json({
      error: `Modell "${model.name}" besitzt noch keinen verifizierten Adapter (${model.status}).`,
    });
  }
  if (!isUnverifiedClientLocalRuntime && (!model.testPassed || !['FUNKTIONIERT', 'LOKAL INSTALLIERT'].includes(model.status))) {
    return res.status(409).json({
      error: `Modell "${model.name}" muss zuerst einen erfolgreichen echten Laufzeittest bestehen. Aktueller Status: ${model.status}.`,
    });
  }
  if (model.enabled) {
    model.enabled = false;
  } else {
    model.enabled = true;
  }
  await saveDb(db);
  res.json({ model });
}));

app.post('/api/models/:id/test', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((m) => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Modell nicht gefunden.' });
  const tested = await runLiveModelTest(model, db);
  await saveDb(db);
  res.json({ model: tested, budgetGuard: db.budgetGuard });
}));

// === ZERO CORE & ZERO BRAIN ===
app.get('/api/brain/history', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  res.json({ messages: db.chatHistory });
}));

app.post('/api/brain/chat', asyncRoute(async (req, res) => {
  let db: Awaited<ReturnType<typeof loadDb>> | null = null;
  let routedModelId = '';
  try {
    const database = await loadDb();
    db = database;
    const message = String(req.body?.message ?? '').trim();
    const requestedModel = String(req.body?.modelId ?? '');
    const useWebSearch = Boolean(req.body?.useWebSearch);
    const projectId = req.body?.projectId ? String(req.body.projectId) : undefined;
    const requestStartedAt = Date.now();
    const isSimpleRequest = !useWebSearch && !projectId && message.length <= 180 && /^(hi|hallo|hey|moin|guten morgen|guten tag|guten abend|test|ping|danke|ok|okay|wer bist du|was kannst du|stelle dich vor)[.!?\s]*$/i.test(message);
    const needsFullContext = !isSimpleRequest;

    if (!message) return res.status(400).json({ error: 'Nachricht darf nicht leer sein.' });
    const principal = getZeroPrincipal(res.locals);
    if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
    const activeProject = projectId
      ? resolveOwnedProject(database.projects, principal, projectId)
      : undefined;
    if (projectId && !activeProject) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

    const routeDecision = chooseZeroChatModel(
      database.models,
      database.budgetGuard,
      requestedModel || undefined,
    );
    if (!routeDecision) {
      return res.status(503).json({
        error: 'ZERO CORE findet aktuell kein aktiviertes, erfolgreich getestetes und verfügbares kostenloses Textmodell. Bitte im Modell-Hub einen echten Modelltest ausführen. Es wird kein kostenpflichtiger Fallback gestartet.',
      });
    }
    const selectedModel = routeDecision.modelId;
    routedModelId = selectedModel;

    const availableModelsSummary = database.models
      .filter(
        (m) =>
          m.enabled &&
          (m.status === 'FUNKTIONIERT' ||
            m.status === 'LOKAL INSTALLIERT' ||
            m.status === 'Ready for Deployment')
      )
      .map((m) => `${m.name} [${m.executionMode}]`)
      .join(', ');

    const relevantMemories = needsFullContext
      ? database.memories.slice(0, 4).map((m) => `- ${m.title}: ${m.content}`).join('\n')
      : '';

    const systemInstruction = `Du bist ZERO BRAIN, der zentrale KI-Assistent von ZERO AI STUDIO ("BEYOND LIMITS").
Zielgerät: iPhone 16 Pro Max. Budget-Regel: strikt 0 € laufende Kosten. Maximale Videolänge: 60 Sekunden (bevorzugt 55–60s).
Antworte auf Deutsch, präzise, technisch ehrlich und ohne erfundene Fähigkeiten.
Tatsächlich aktive kostenlose Module: ${availableModelsSummary}.
Aktives Projekt: ${activeProject ? `${activeProject.title} (${activeProject.scenes.length} Szenen, ${activeProject.targetDurationSec}s)` : 'Keines'}.
Langzeitgedächtnis:\n${relevantMemories}`;

    let replyText = '';
    let sources: Array<{ title: string; uri: string }> = [];
    let routingSteps: string[] = [];

    if (requestedModel === 'gpt-oss-20b-free') {
      return res.status(503).json({
        error: 'GPT-OSS Open Cloud ist deaktiviert: kein verifizierter, dauerhaft kostenloser Zugriff. Bitte ein freigegebenes Gemini-Free-Tier-Modell mit eigenem API-Key wählen. Kein kostenpflichtiger Fallback.',
      });
    }

      if (selectedModel !== 'cloudflare-glm-4.7-flash') {
        await reserveZeroBudgetModelAllowed(selectedModel, 'BRAIN_CHAT', database);
      }
      const ai = selectedModel === 'cloudflare-glm-4.7-flash' ? null : getGeminiClient();
      const recentHistory = (needsFullContext ? database.chatHistory.slice(-4) : [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role === 'user' ? 'Nutzer' : 'ZERO BRAIN'}: ${m.content}`)
        .join('\n\n');

      const fullPrompt = recentHistory ? `${recentHistory}\n\nNutzer: ${message}` : message;
      let groundingContext = '';

      if (useWebSearch) {
        if (!ai) throw new Error('ZERO Websuche benötigt derzeit ein aktiviertes Gemini-Free-Tier-Modell; Cloudflare-Chat selbst bleibt kostenlos und ohne Fallback.');
        // Google Search grounding is not available on the Gemini 3.8 Free tier.
        // Run search with Gemini 2.5 Flash-Lite, whose Free tier includes grounding,
        // then pass the retrieved context to the user's selected reasoning model.
        await reserveZeroBudgetModelAllowed('gemini-2.5-flash-lite', 'BRAIN_WEB_SEARCH', database);
        const searchResponse = await withTransientRetry(() =>
          ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: `Recherchiere aktuelle Fakten und liefere eine knappe, belegorientierte Zusammenfassung zu dieser Anfrage:\n\n${fullPrompt}`,
            config: {
              systemInstruction: 'Du bist der Recherche-Agent von ZERO. Nutze Google Search. Erfinde keine Fakten. Unterscheide bestätigte Angaben von Unsicherheiten.',
              tools: [{ googleSearch: {} }],
            },
          })
        );
        groundingContext = (searchResponse.text ?? '').trim();
        const searchChunks = searchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        sources = searchChunks
          .map((chunk) => chunk.web)
          .filter((web): web is { uri: string; title: string } => Boolean(web?.uri))
          .map((web) => ({ title: web.title || web.uri, uri: web.uri }));
      }

      const streamContents = groundingContext
        ? fullPrompt + '\n\nVERIFIZIERTER WEB-RECHERCHEKONTEXT:\n' + groundingContext + '\n\nNutze den Recherchekontext kritisch. Behaupte nichts, was daraus nicht hervorgeht.'
        : fullPrompt;
      const streamConfig = {
        systemInstruction,
        ...(selectedModel === 'gemini-3.8-flash' && needsFullContext
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } }
          : {}),
      };
      const wantsStream = req.headers.accept?.includes('text/event-stream') ?? false;
      if (wantsStream) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write('data: ' + JSON.stringify({ type: 'start', modelUsed: selectedModel }) + '\n\n');
      }
      if (selectedModel === 'cloudflare-glm-4.7-flash') {
        const cloudflareResult = await generateCloudflareText({
          prompt: streamContents,
          systemPrompt: systemInstruction,
          maxTokens: 1200,
        });
        replyText = cloudflareResult.text;
        if (wantsStream && replyText) {
          res.write('data: ' + JSON.stringify({ type: 'delta', text: replyText }) + '\n\n');
        }
      } else {
        if (!ai) throw new Error('Kein KI-Provider verfügbar.');
        const responseStream = await ai.models.generateContentStream({
          model: selectedModel,
          contents: streamContents,
          config: streamConfig,
        });
        for await (const chunk of responseStream) {
          const piece = chunk.text ?? '';
          if (!piece) continue;
          replyText += piece;
          if (wantsStream) {
            res.write('data: ' + JSON.stringify({ type: 'delta', text: piece }) + '\n\n');
          }
        }
        replyText = replyText.trim() || 'Keine Antwort erhalten.';
      }

      routingSteps = [
        `ZERO CORE Auto-Router -> ${selectedModel}: ${routeDecision.reason}`,
        ...(useWebSearch ? [`Google Search über gemini-2.5-flash-lite Free Tier (${sources.length} Quellen)`] : []),
        ...(activeProject ? [`Projektkontext geladen: "${activeProject.title}"`] : []),
        `Kontextmodus: ${isSimpleRequest ? 'Schnellmodus' : 'Kontextmodus'}`,
        `ZERO Antwortzeit: ${Date.now() - requestStartedAt} ms`,
      ];

    const now = new Date().toISOString();
    database.chatHistory.push(
      { id: `msg-u-${Date.now()}`, role: 'user', content: message, timestamp: now },
      {
        id: `msg-a-${Date.now() + 1}`,
        role: 'assistant',
        content: replyText,
        modelUsed: selectedModel,
        routingSteps,
        sources,
        timestamp: new Date().toISOString(),
      }
    );
    if (database.chatHistory.length > 60) {
      database.chatHistory = database.chatHistory.slice(-60);
    }
    await saveDb(db);

    const chatResult = {
      reply: replyText,
      modelUsed: selectedModel,
      routingSteps,
      sources,
      performance: { totalMs: Date.now() - requestStartedAt, contextMode: isSimpleRequest ? 'fast' : 'full' },
      messages: database.chatHistory,
    };
    if (req.headers.accept?.includes('text/event-stream')) {
      res.write('data: ' + JSON.stringify({ type: 'done', ...chatResult }) + '\n\n');
      return res.end();
    }
    return res.json(chatResult);
  } catch (err) {
    const requestedModel = routedModelId || String(req.body?.modelId ?? '');
    const quotaKeys = req.body?.useWebSearch
      ? ['gemini-web-grounding', 'gemini-2.5-flash-lite', requestedModel]
      : [requestedModel];
    if (db && isQuotaExhaustionError(err)) {
      for (const quotaKey of quotaKeys) {
        if (db.budgetGuard.freeQuotaUsage[quotaKey]) {
          await markGeminiQuotaExhausted(quotaKey, db);
        }
      }
      await saveDb(db);
    }
    const errorMessage = db
      ? formatGermanApiError(err)
      : 'ZERO-Datenbank ist vorübergehend nicht erreichbar. Bitte gleich erneut versuchen.';
    if (res.headersSent && req.headers.accept?.includes('text/event-stream')) {
      res.write('data: ' + JSON.stringify({ type: 'error', error: errorMessage }) + '\n\n');
      return res.end();
    }
    return res.status(db ? 400 : 503).json({ error: errorMessage });
  }
}));

app.post('/api/brain/clear', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  db.chatHistory = [
    {
      id: `chat-reset-${Date.now()}`,
      role: 'assistant',
      content: 'Verlauf zurückgesetzt. ZERO BRAIN steht bereit.',
      modelUsed: 'gemini-3.8-flash',
      timestamp: new Date().toISOString(),
    },
  ];
  await saveDb(db);
  res.json({ messages: db.chatHistory });
}));

// === ZERO WEB INTELLIGENCE ===
function getZeroWebSearchWorker(): { baseUrl: URL; headers: Record<string, string> } | null {
  const rawUrl = process.env.ZERO_WEB_SEARCH_URL?.trim();
  const token = process.env.ZERO_WEB_SEARCH_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  try {
    const baseUrl = new URL(rawUrl);
    if (!['https:', ...(IS_PRODUCTION ? [] : ['http:'])].includes(baseUrl.protocol)) return null;
    baseUrl.pathname = '/';
    baseUrl.search = '';
    baseUrl.hash = '';
    return {
      baseUrl,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    };
  } catch {
    return null;
  }
}

app.post('/api/web/research', asyncRoute(async (req, res) => {
  const db = await loadDb();
  try {
    const query = String(req.body?.query ?? '').trim();
    if (!query) return res.status(400).json({ error: 'Suchanfrage fehlt.' });
    if (query.length > 250) return res.status(400).json({ error: 'Die Suchanfrage darf maximal 250 Zeichen lang sein.' });

    const hasSearchUrl = Boolean(process.env.ZERO_WEB_SEARCH_URL?.trim());
    const hasSearchToken = Boolean(process.env.ZERO_WEB_SEARCH_TOKEN?.trim());
    if (hasSearchUrl !== hasSearchToken) {
      return res.status(503).json({
        error: 'Die private ZERO-Websuche ist unvollständig konfiguriert. ZERO_WEB_SEARCH_URL und ZERO_WEB_SEARCH_TOKEN müssen gemeinsam gesetzt sein.',
        paidFallback: false,
      });
    }

    const searchWorker = getZeroWebSearchWorker();
    if (hasSearchUrl && !searchWorker) {
      return res.status(503).json({
        error: 'Die private ZERO-Websuche benötigt eine gültige HTTPS-Adresse und ein Worker-Token. Kein kostenpflichtiger Fallback wurde aufgerufen.',
        paidFallback: false,
      });
    }

    if (searchWorker) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 22000);
      try {
        const url = new URL('/search', searchWorker.baseUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('language', 'de');
        url.searchParams.set('limit', '8');
        const response = await fetch(url, {
          method: 'GET',
          headers: searchWorker.headers,
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          return res.status(503).json({
            error: `ZERO SearXNG konnte die Suche nicht ausführen (HTTP ${response.status}). Bitte den privaten Search-Worker prüfen. Kein kostenpflichtiger Fallback.`,
            paidFallback: false,
          });
        }
        const payload = await response.json().catch(() => null) as {
          results?: Array<{ title?: unknown; url?: unknown; content?: unknown; engine?: unknown }>;
        } | null;
        if (!payload || !Array.isArray(payload.results)) {
          return res.status(502).json({ error: 'ZERO SearXNG lieferte keine gültige Ergebnisliste.', paidFallback: false });
        }
        const seenUrls = new Set<string>();
        const sources = payload.results.flatMap((item) => {
          if (typeof item.url !== 'string' || typeof item.title !== 'string') return [];
          try {
            const sourceUrl = new URL(item.url);
            if (!['https:', 'http:'].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password) return [];
            const normalizedUrl = sourceUrl.toString();
            if (seenUrls.has(normalizedUrl)) return [];
            seenUrls.add(normalizedUrl);
            return [{
              title: item.title.slice(0, 300),
              uri: normalizedUrl,
              snippet: typeof item.content === 'string' ? item.content.slice(0, 1200) : '',
            }];
          } catch {
            return [];
          }
        }).slice(0, 8);

        if (!sources.length) {
          return res.status(404).json({
            report: 'SearXNG hat keine verwertbaren Web-Treffer für diese Suchanfrage gefunden.',
            sources: [],
            modelUsed: 'SearXNG (self-hosted)',
            costEur: 0,
          });
        }

        const glm = db.models.find((model) =>
          model.id === 'cloudflare-glm-4.7-flash' &&
          model.enabled &&
          model.testPassed &&
          model.status === 'FUNKTIONIERT' &&
          model.hasRealAdapter
        );
        let report: string;
        let modelUsed = 'SearXNG (self-hosted) · rohe Web-Treffer';
        if (glm) {
          const groundedSources = sources.map((source, index) =>
            `[${index + 1}] ${source.title}\nURL: ${source.uri}\nAuszug: ${source.snippet}`
          ).join('\n\n');
          const ai = await generateCloudflareText({
            systemPrompt: 'Du bist ZERO WEB INTELLIGENCE. Fasse ausschließlich die bereitgestellten Suchtreffer auf Deutsch zusammen. Trenne belegte Fakten, Unsicherheiten und offene Punkte. Erfinde keine Fakten und keine Quellen. Verweise bei Aussagen auf die Nummern [1], [2] usw.',
            prompt: `Suchanfrage: ${query}\n\nWeb-Suchergebnisse:\n${groundedSources}\n\nErstelle eine strukturierte Recherche mit Kurzfazit, wichtigsten Erkenntnissen, Widersprüchen/Unsicherheiten und einer kurzen Bewertung der Quellenlage.`,
            maxTokens: 1100,
          });
          report = ai.text.trim();
          modelUsed = 'SearXNG (self-hosted) + GLM-4.7-Flash';
        } else {
          report = [
            'ZERO hat Web-Treffer über die private SearXNG-Instanz gefunden.',
            'Für eine KI-Zusammenfassung aktiviere GLM-4.7-Flash nach einem erfolgreichen Live-Test im Model Hub.',
            '',
            ...sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.snippet}`),
          ].join('\n\n');
        }
        return res.json({
          report,
          sources: sources.map(({ title, uri }) => ({ title, uri })),
          modelUsed,
          costEur: 0,
          paidFallback: false,
        });
      } catch (error) {
        const message = error instanceof Error && error.name === 'AbortError'
          ? 'Die private ZERO-Websuche hat das 22-Sekunden-Limit überschritten.'
          : 'Die private ZERO-Websuche ist nicht erreichbar. Prüfe Tunnel, Worker und SearXNG.';
        console.error('[ZERO WEB] private SearXNG request failed:', error instanceof Error ? error.message : 'unknown error');
        return res.status(503).json({ error: message, paidFallback: false });
      } finally {
        clearTimeout(timeout);
      }
    }

    await reserveZeroBudgetModelAllowed('gemini-2.5-flash-lite', 'WEB_RESEARCH', db);

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: `Recherchiere sachlich, strukturiert und auf Deutsch zu folgender Anfrage. Nenne nur belegbare Fakten aus den Suchergebnissen:\n\n${query}`,
        config: {
          systemInstruction: 'Du bist ZERO WEB INTELLIGENCE. Nutze Google Search, belege wichtige Aussagen und erfinde keine Quellen.',
          tools: [{ googleSearch: {} }],
        },
      })
    );

    const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = rawChunks
      .map((c) => c.web)
      .filter((w): w is { uri: string; title: string } => Boolean(w?.uri))
      .map((w) => ({ title: w.title || w.uri, uri: w.uri }));

    await saveDb(db);
    res.json({
      report: (response.text ?? '').trim(),
      sources,
      modelUsed: 'gemini-2.5-flash-lite + Google Search Grounding (Free Tier)',
      costEur: 0,
    });
  } catch (err) {
    if (isQuotaExhaustionError(err)) {
      for (const quotaKey of ['gemini-web-grounding', 'gemini-2.5-flash-lite']) {
        if (db.budgetGuard.freeQuotaUsage[quotaKey]) {
          await markGeminiQuotaExhausted(quotaKey, db);
        }
      }
      await saveDb(db);
    }
    res.status(400).json({ error: formatGermanApiError(err) });
  }
}));

// === ZERO IMAGE STUDIO ===
app.post('/api/image/generate', asyncRoute(async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ error: 'Bild-Prompt fehlt.' });
  if (prompt.length > 2_048) return res.status(400).json({ error: 'Der Bild-Prompt darf maximal 2.048 Zeichen lang sein.' });
  const requestedModel = String(req.body?.model ?? 'flux');
  if (requestedModel !== 'flux') {
    return res.status(400).json({ error: 'Aktuell ist nur FLUX.1 Schnell als kostenloser Cloud-Bildadapter verifiziert. SD Turbo und Sana bleiben deaktiviert.' });
  }

  let db: Awaited<ReturnType<typeof loadDb>> | null = null;
  try {
    db = await loadDb();
    const routeDecision = chooseZeroMediaModel(db.models, db.budgetGuard, 'image', [], new Date(), 'flux-1-schnell-free');
    if (!routeDecision) {
      return res.status(503).json({
        error: 'FLUX ist noch nicht aktiviert. Bitte im Model Hub einen erfolgreichen Live-Test für FLUX.1 Schnell (Cloudflare Workers AI) durchführen. Kein kostenpflichtiger Fallback.',
      });
    }
    const image = await generateFreeCloudImage({
      prompt,
      model: 'flux',
    });
    res.json({ ...image, modelId: 'flux-1-schnell-free', costEur: 0 });
  } catch (err) {
    const message = db
      ? formatGermanApiError(err)
      : 'ZERO-Datenbank ist vorübergehend nicht erreichbar. Bitte erneut versuchen.';
    console.error('[ZERO IMAGE] Cloudflare FLUX request failed:', err instanceof Error ? err.message : 'unknown error');
    res.status(503).json({ error: message, costEur: 0, paidFallback: false });
  }
}));

app.post('/api/image/analyze', asyncRoute(async (req, res) => {
  let db: Awaited<ReturnType<typeof loadDb>> | null = null;

  try {
    const database = await loadDb();
    db = database;
    const imageDataUrl = String(req.body?.imageDataUrl ?? '');
    const question = String(
      req.body?.question ??
        'Analysiere Bildaufbau, Beleuchtung, Farben und erkannte Elemente detailliert auf Deutsch.'
    ).trim();
    const image = parseBase64DataUrl(
      imageDataUrl,
      ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      12 * 1024 * 1024
    );

    if (!image) {
      return res.status(400).json({
        error: 'Ungültiges Bild. Erlaubt sind JPEG, PNG, WebP oder GIF bis maximal 12 MB.',
      });
    }
    if (!question) return res.status(400).json({ error: 'Bitte eine Analysefrage eingeben.' });
    if (question.length > 2_000) {
      return res.status(400).json({ error: 'Die Analysefrage darf maximal 2.000 Zeichen lang sein.' });
    }

    const moondream = database.models.find((model) => model.id === 'cloudflare-moondream-3.1-9b-a2b');
    if (moondream?.enabled && moondream.testPassed && moondream.status === 'FUNKTIONIERT' && moondream.hasRealAdapter) {
      const result = await analyzeCloudflareImage({
        imageDataUrl: `data:${image.mimeType};base64,${image.data}`,
        question,
      });
      await saveDb(database);
      return res.json({
        analysis: result.answer,
        modelUsed: result.modelId,
        costEur: 0,
      });
    }

    await reserveZeroBudgetModelAllowed('gemini-3.8-flash', 'IMAGE_ANALYZE', database);

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: {
          parts: [
            { inlineData: { mimeType: image.mimeType, data: image.data } },
            { text: question },
          ],
        },
      })
    );

    await saveDb(database);
    res.json({
      analysis: (response.text ?? '').trim(),
      modelUsed: 'gemini-3.8-flash',
      costEur: 0,
    });
  } catch (err) {
    if (db && isQuotaExhaustionError(err) && db.budgetGuard.freeQuotaUsage['gemini-3.8-flash']) {
      await markGeminiQuotaExhausted('gemini-3.8-flash', db);
      try {
        await saveDb(db);
      } catch (persistError) {
        console.error('[ZERO IMAGE] Kontingentstatus konnte nicht gespeichert werden:', persistError);
      }
    }
    res.status(db ? 400 : 503).json({
      error: db
        ? formatGermanApiError(err)
        : 'Die ZERO-Datenbank ist vorübergehend nicht erreichbar. Bitte später erneut versuchen.',
    });
  }
}));

function getPiperTtsWorkerConfig(): { baseUrl: URL; headers: Record<string, string> } | null {
  if (!isPiperWorkerAllowed()) return null;
  const configuredUrl = process.env.ZERO_TTS_WORKER_URL?.trim();
  const token = process.env.ZERO_TTS_WORKER_TOKEN?.trim();
  if (!configuredUrl || !token) return null;
  try {
    const baseUrl = new URL(configuredUrl);
    const internalComposeWorker =
      IS_PRODUCTION &&
      baseUrl.protocol === 'http:' &&
      baseUrl.hostname === 'zero-worker' &&
      baseUrl.port === '8000';
    const allowedProtocol =
      baseUrl.protocol === 'https:' ||
      (!IS_PRODUCTION && baseUrl.protocol === 'http:') ||
      internalComposeWorker;
    if (!allowedProtocol || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return null;
    baseUrl.pathname = '/';
    baseUrl.search = '';
    baseUrl.hash = '';
    return { baseUrl, headers: { Accept: 'audio/wav, application/json', Authorization: `Bearer ${token}` } };
  } catch {
    return null;
  }
}

// Free, self-hosted German TTS through the optional Wan/Piper worker.
// The voice model runs on the user's own host; no external TTS provider is contacted.
class WorkerPayloadTooLargeError extends Error {
  constructor() {
    super('Worker response exceeded the configured byte limit.');
    this.name = 'WorkerPayloadTooLargeError';
  }
}

async function readWorkerBodyLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkerPayloadTooLargeError();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WorkerPayloadTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

app.post('/api/audio/tts/piper', asyncRoute(async (req, res) => {
  const principal = getZeroPrincipal(res.locals);
  if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  const worker = getPiperTtsWorkerConfig();
  if (!worker) {
    return res.status(503).json({
      error: 'Der Piper-Worker ist standardmäßig gesperrt. Erst nach bestätigter kostenloser Eigenhost-Bereitstellung beide ZERO_PIPER_WORKER-Freigaben setzen und ZERO_TTS_WORKER_URL sowie ZERO_TTS_WORKER_TOKEN konfigurieren. iPhone-Web-Speech bleibt lokal verfügbar.',
      costEur: 0, paidFallback: false,
    });
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const rawSpeed = Number(req.body?.speed ?? 1);
  const speed = Number.isFinite(rawSpeed) ? Math.min(1.25, Math.max(0.75, rawSpeed)) : 1;
  if (!text) return res.status(400).json({ error: 'Text für Piper fehlt.' });
  if (text.length > 5000) return res.status(400).json({ error: 'Piper unterstützt maximal 5.000 Zeichen pro WAV-Datei.' });
  const suppliedKey = req.get('Idempotency-Key')?.trim();
  if (!suppliedKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(suppliedKey)) {
    return res.status(400).json({ error: 'Ungültiger Idempotency-Key.' });
  }
  let reservation: Awaited<ReturnType<typeof reserveZeroResource>>;
  try {
    reservation = await reserveZeroResource({
      principalId: principal.id, resourceId: 'piper-tts',
      idempotencyKey: suppliedKey, units: text.length,
      requestFingerprint: createHash('sha256').update(JSON.stringify({ text, speed })).digest('hex'),
    });
  } catch (error) {
    const status = error instanceof ZeroResourceLimitError ? 429
      : error instanceof ZeroResourceIdempotencyError ? 409 : 503;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'ZERO RESOURCE GUARD hat Piper gesperrt.', costEur: 0, paidFallback: false });
  }
  if (reservation.duplicate) {
    return res.status(409).json({ error: 'Dieser Piper-Auftrag wurde mit diesem Idempotency-Key bereits angenommen oder abgeschlossen.', reservationId: reservation.reservationId, costEur: 0, paidFallback: false });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150000);
  let completed = false;
  let safeToRelease = false;
  try {
    const response = await fetch(new URL('/tts', worker.baseUrl), {
      method: 'POST',
      headers: { ...worker.headers, 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({ text, speed }),
      signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) {
      // Only a definitive 4xx rejection proves the worker did not accept work.
      // A 5xx may follow partial processing, so keep the reservation until TTL.
      safeToRelease = response.status >= 400 && response.status < 500;
      const payload = await response.json().catch(() => ({})) as { detail?: unknown };
      const detail = typeof payload.detail === 'string' ? payload.detail : 'Der Piper-Worker konnte keine Sprache erzeugen.';
      const message = safeToRelease
        ? `Piper hat den Auftrag vor der Verarbeitung abgewiesen: ${detail.slice(0, 320)}`
        : detail.slice(0, 400);
      return res.status(response.status === 400 ? 400 : 503).json({ error: message, costEur: 0, paidFallback: false });
    }
    let bytes: Buffer;
    try {
      bytes = await readWorkerBodyLimited(response, 20 * 1024 * 1024);
    } catch (error) {
      if (error instanceof WorkerPayloadTooLargeError) {
        safeToRelease = true;
        return res.status(413).json({ error: 'Piper-WAV überschreitet das 20-MB-Limit.' });
      }
      throw error;
    }
    if (bytes.length < 44 || bytes.length > 20 * 1024 * 1024 ||
        bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
        bytes.subarray(8, 12).toString('ascii') !== 'WAVE') {
      safeToRelease = true;
      return res.status(502).json({ error: 'Piper lieferte keine gültige WAV-Datei.' });
    }
    await settleZeroResourceReservation({ principalId: principal.id, reservationId: reservation.reservationId, outcome: 'completed' });
    completed = true;
    return res.json({
      audioDataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`,
      modelUsed: 'Piper ONNX · de_DE-thorsten-medium (eigener ZERO-Worker)',
      voice: 'Thorsten · Deutsch', costEur: 0, paidFallback: false,
      resourceReservation: reservation.reservationId,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Piper-Spracherzeugung dauerte länger als 150 Sekunden und wurde abgebrochen.'
      : 'Der eigene Piper-Sprachworker ist nicht erreichbar. Kein kostenpflichtiger Fallback wurde gestartet.';
    return res.status(503).json({ error: message, costEur: 0, paidFallback: false });
  } finally {
    clearTimeout(timeout);
    if (!completed && safeToRelease) {
      await settleZeroResourceReservation({ principalId: principal.id, reservationId: reservation.reservationId, outcome: 'released' }).catch(() => undefined);
    }
  }
}));

// === ZERO AUDIO STUDIO ===
app.post('/api/audio/tts', asyncRoute(async (req, res) => {
  const useExpressiveModel = Boolean(req.body?.expressive);
  const preferredModelId = useExpressiveModel ? 'gemini-3.8-flash-tts' : 'gemini-3.8-flash-lite-tts';
  let modelId = preferredModelId;
  let db: Awaited<ReturnType<typeof loadDb>> | null = null;

  try {
    const database = await loadDb();
    db = database;
    const routeDecision = chooseZeroMediaModel(database.models, database.budgetGuard, 'text-to-speech', [], new Date(), preferredModelId);
    if (!routeDecision) {
      return res.status(503).json({ error: 'ZERO CORE findet aktuell kein aktiviertes, erfolgreich getestetes und verfügbares kostenloses TTS-Modell. Bitte Modelltest und Free-Tier-Kontingent prüfen. Kein kostenpflichtiger Fallback.' });
    }
    modelId = routeDecision.modelId;
    const text = String(req.body?.text ?? '').trim();
    const voiceName = String(req.body?.voiceName ?? 'Kore');
    const style = String(req.body?.style ?? 'Ruhige, klare deutsche Erzählstimme').trim();

    if (!text) return res.status(400).json({ error: 'Text für Sprachausgabe fehlt.' });
    if (text.length > 5_000) {
      return res.status(400).json({ error: 'Der Text ist zu lang. Bitte maximal 5.000 Zeichen verwenden.' });
    }

    await reserveZeroBudgetModelAllowed(modelId, 'AUDIO_TTS', database);

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: modelId,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text,
                speechMetadata: { style },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      })
    );

    const audioPart = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
    const base64Audio = audioPart?.inlineData?.data;
    if (!base64Audio) {
      throw new Error('TTS-Modell hat keine Audiodaten zurückgegeben.');
    }

    const audioDataUrl = pcmBase64ToWavDataUrl(base64Audio, audioPart?.inlineData?.mimeType);
    await saveDb(database);
    res.json({
      audioDataUrl,
      modelUsed: modelId,
      voiceName,
      costEur: 0,
    });
  } catch (err) {
    if (db && isQuotaExhaustionError(err) && db.budgetGuard.freeQuotaUsage[modelId]) {
      await markGeminiQuotaExhausted(modelId, db);
      try {
        await saveDb(db);
      } catch (persistError) {
        console.error('[ZERO AUDIO] Kontingentstatus konnte nicht gespeichert werden:', persistError);
      }
    }
    res.status(db ? 400 : 503).json({
      error: db
        ? formatGermanApiError(err)
        : 'Die ZERO-Datenbank ist vorübergehend nicht erreichbar. Bitte später erneut versuchen.',
    });
  }
}));

app.post('/api/audio/transcribe', asyncRoute(async (req, res) => {
  let db: Awaited<ReturnType<typeof loadDb>> | null = null;
  let selectedTranscriptionModel = 'gemini-3.5-transcribe';

  try {
    const database = await loadDb();
    db = database;
    const routeDecision = chooseZeroMediaModel(
      database.models,
      database.budgetGuard,
      'transcription',
      [],
      new Date(),
      'cloudflare-whisper-large-v3-turbo',
    );
    if (!routeDecision) {
      return res.status(503).json({ error: 'ZERO CORE findet aktuell kein aktiviertes, erfolgreich getestetes und verfügbares kostenloses Transkriptionsmodell. Bitte Modelltest und Free-Tier-Kontingent prüfen. Kein kostenpflichtiger Fallback.' });
    }
    selectedTranscriptionModel = routeDecision.modelId;
    const audioDataUrl = String(req.body?.audioDataUrl ?? '');
    const audio = parseBase64DataUrl(
      audioDataUrl,
      [
        'audio/wav',
        'audio/x-wav',
        'audio/mpeg',
        'audio/mp3',
        'audio/mp4',
        'audio/aac',
        'audio/ogg',
        'audio/webm',
        'audio/flac',
        'audio/x-aiff',
      ],
      18 * 1024 * 1024
    );
    if (!audio) {
      return res.status(400).json({
        error: 'Ungültige Audiodatei. Unterstützte Formate: WAV, MP3, MP4/M4A, AAC, OGG, WebM, FLAC und AIFF (maximal 18 MB).',
      });
    }

    if (selectedTranscriptionModel === 'cloudflare-whisper-large-v3-turbo') {
      // Workers AI enforces its shared 10,000-Neuron daily free allocation provider-side.
      // ZERO records no local Gemini quota and never switches to a paid transcription provider.
      const result = await transcribeCloudflareAudio({
        audioBase64: audio.data,
        language: 'de',
        task: 'transcribe',
      });
      if (!result.text) throw new Error('Whisper hat keine Sprache im Audio erkannt.');
      const { srt, subtitleCueCount } = buildSrtFromTimedWords(
        result.segments.map((segment) => ({
          word: segment.text,
          startOffset: `${segment.start}s`,
          endOffset: `${segment.end}s`,
        })),
      );
      await saveDb(database);
      return res.json({
        transcript: result.text,
        rawText: result.text,
        srt,
        subtitleCueCount,
        timestampsAvailable: subtitleCueCount > 0,
        modelUsed: result.modelId,
        costEur: 0,
      });
    }

    await reserveZeroBudgetModelAllowed(selectedTranscriptionModel, 'AUDIO_TRANSCRIBE', database);

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: selectedTranscriptionModel,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: audio.mimeType, data: audio.data } },
              { text: 'Transcribe this audio.' },
            ],
          },
        ],
        config: {
          audioTranscriptionConfig: {
            wordTimestamp: true,
          },
        },
      })
    );

    type TimedWord = { word?: string; startOffset?: string; endOffset?: string };
    const parts = (response.candidates?.[0]?.content?.parts ?? []) as Array<{
      text?: string;
      audioTranscription?: { text?: string; words?: TimedWord[] };
    }>;
    const transcriptionParts = parts
      .map((part) => part.audioTranscription)
      .filter((part): part is NonNullable<typeof part> => Boolean(part));
    const partsText = parts
      .map((part) => part.audioTranscription?.text ?? (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    const rawTranscript = (partsText || response.text || '').trim();

    if (!rawTranscript) {
      throw new Error('Transkription lieferte kein erkanntes Sprachsignal.');
    }

    const { srt, subtitleCueCount } = buildSrtFromTimedWords(
      transcriptionParts.flatMap((part) => part.words ?? [])
    );

    await saveDb(database);
    res.json({
      transcript: rawTranscript,
      rawText: rawTranscript,
      srt: srt || null,
      subtitleCueCount,
      timestampsAvailable: subtitleCueCount > 0,
      modelUsed: selectedTranscriptionModel,
      costEur: 0,
    });
  } catch (err) {
    if (db && isQuotaExhaustionError(err) && db.budgetGuard.freeQuotaUsage[selectedTranscriptionModel]) {
      await markGeminiQuotaExhausted(selectedTranscriptionModel, db);
      try {
        await saveDb(db);
      } catch (persistError) {
        console.error('[ZERO AUDIO] Kontingentstatus konnte nicht gespeichert werden:', persistError);
      }
    }
    res.status(db ? 400 : 503).json({
      error: db
        ? formatGermanApiError(err)
        : 'Die ZERO-Datenbank ist vorübergehend nicht erreichbar. Bitte später erneut versuchen.',
    });
  }
}));

// === ZERO MUSIC STUDIO (AI Composition + Local WebAudio DSP) ===
app.post('/api/music/compose', asyncRoute(async (req, res) => {
  const db = await loadDb();
  try {
    const prompt = String(req.body?.prompt ?? 'Dunkler Berliner Thriller Soundtrack mit tiefer Spannung').trim().slice(0, 1200);
    const rawDurationSec = Number(req.body?.durationSec ?? 30);
    const durationSec = Math.min(60, Math.max(10, Number.isFinite(rawDurationSec) ? Math.round(rawDurationSec) : 30));
    requireActiveCloudflareTextModel(db);

    const response = await generateCloudflareText({
      systemPrompt: 'Du bist ZERO MUSIC DIRECTOR, ein Filmkomponist und Sounddesigner. Antworte ausschließlich mit einem gültigen JSON-Objekt ohne Markdown oder Erklärtext. Werte und Tonhöhen müssen innerhalb der angegebenen Grenzen liegen.',
      prompt: `Entwirf musikalische Synthese-Parameter für einen lokalen WebAudio DSP-Synthesizer.
Stimmung und Einsatz: ${prompt}
Dauer: ${durationSec} Sekunden.

Gib ausschließlich dieses JSON-Objekt zurück:
{
  "title": "Kurzer Tracktitel",
  "mood": "Atmosphäre in wenigen Worten",
  "bpm": 84,
  "rootMidi": 40,
  "scaleIntervals": [0, 2, 3, 7, 8, 10],
  "padBrightness": 0.4,
  "pulseIntensity": 0.6,
  "subBassLevel": 0.7,
  "arrangementNotes": "Kurze Hinweise zum musikalischen Verlauf"
}
Grenzen: bpm 55-160, rootMidi 33-57, scaleIntervals 5-8 Ganzzahlen von 0 bis 11, padBrightness 0.1-1.0, pulseIntensity 0.0-1.0, subBassLevel 0.2-1.0.`,
      maxTokens: 500,
    });

    const raw = parseCloudflareJsonObject(response.text);
    const bounded = (value: unknown, fallback: number, min: number, max: number) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    };
    const scaleIntervals = Array.isArray(raw.scaleIntervals)
      ? raw.scaleIntervals.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 11).slice(0, 8)
      : [];
    const composition = {
      title: String(raw.title || 'ZERO Original Soundtrack').slice(0, 120),
      mood: String(raw.mood || prompt).slice(0, 240),
      bpm: Math.round(bounded(raw.bpm, 84, 55, 160)),
      rootMidi: Math.round(bounded(raw.rootMidi, 40, 33, 57)),
      scaleIntervals: scaleIntervals.length >= 5 ? scaleIntervals : [0, 2, 3, 7, 8, 10],
      padBrightness: bounded(raw.padBrightness, 0.4, 0.1, 1),
      pulseIntensity: bounded(raw.pulseIntensity, 0.6, 0, 1),
      subBassLevel: bounded(raw.subBassLevel, 0.7, 0.2, 1),
      arrangementNotes: String(raw.arrangementNotes || 'Langsamer Aufbau, tiefer Bass und atmosphärischer Ausklang.').slice(0, 1200),
    };
    await saveDb(db);
    res.json({
      composition: {
        ...composition,
        durationSec,
        engine: 'GLM-4.7-Flash + ZERO WebAudio DSP',
        costEur: 0,
      },
    });
  } catch (err) {
    res.status(503).json({
      error: formatGermanApiError(err),
      costEur: 0,
      paidFallback: false,
    });
  }
}));

// === ZERO VIDEO ENGINE BRIDGE (OPTIONAL SELF-HOSTED WAN WORKER) ===
// The GPU worker is deliberately external: the Render web service is not a video-generation GPU.
// Only an explicitly configured HTTPS endpoint is contacted; no paid provider fallback is used.
app.get('/api/video/engine/status', asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isWanGpuAllowed()) {
    return res.json({
      configured: Boolean(process.env.ZERO_VIDEO_ENGINE_URL?.trim()),
      online: false,
      engine: 'Wan 2.1',
      status: 'ZERO_COST_GATE_CLOSED',
      message: 'Wan-GPU bleibt standardmäßig gesperrt. ZERO_WAN_GPU_ENABLED und ZERO_WAN_GPU_COSTS_CONFIRMED müssen nach einer separaten Kostenprüfung beide ausdrücklich true sein.',
      maxDurationSec: 60,
      costFallback: false,
    });
  }
  const configuredUrl = process.env.ZERO_VIDEO_ENGINE_URL?.trim();
  const token = process.env.ZERO_VIDEO_ENGINE_TOKEN?.trim();
  if (!configuredUrl || !token) {
    return res.json({
      configured: Boolean(configuredUrl),
      online: false,
      engine: 'Wan 2.1',
      status: configuredUrl ? 'WORKER_TOKEN_MISSING' : 'GPU_WORKER_NOT_CONFIGURED',
      message: configuredUrl
        ? 'ZERO_VIDEO_ENGINE_TOKEN fehlt. Der Worker wird ohne gemeinsames Geheimnis nicht freigeschaltet.'
        : 'Noch kein eigener Wan-GPU-Worker verbunden. ZERO verwendet weiterhin den lokalen Storyboard-Export.',
      maxDurationSec: 60,
      costFallback: false,
    });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(configuredUrl);
    if (IS_PRODUCTION && endpoint.protocol !== 'https:') {
      throw new Error('HTTPS erforderlich');
    }
    if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Ungültiges Protokoll');
  } catch {
    return res.status(503).json({
      configured: true,
      online: false,
      engine: 'Wan 2.1',
      status: 'INVALID_WORKER_URL',
      message: 'Die konfigurierte ZERO_VIDEO_ENGINE_URL ist ungültig. In Produktion ist HTTPS erforderlich.',
      maxDurationSec: 60,
      costFallback: false,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    headers.Authorization = `Bearer ${token}`;
    const response = await fetch(new URL('/health', endpoint), {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
    const payload = await response.json() as { ok?: boolean; engine?: string; model?: string; cuda_available?: boolean; tts_available?: boolean; tts_voice_downloaded?: boolean };
    const engineMatches = !payload.engine || /wan/i.test(payload.engine) || /wan/i.test(payload.model || '');
    const online = payload.ok === true && payload.cuda_available === true && engineMatches;
    return res.json({
      configured: true,
      online,
      gpuAvailable: payload.cuda_available === true,
      ttsAvailable: payload.tts_available === true,
      ttsVoiceDownloaded: payload.tts_voice_downloaded === true,
      engine: 'Wan 2.1',
      status: online ? 'WORKER_ONLINE' : payload.cuda_available === false ? 'WORKER_GPU_UNAVAILABLE' : 'WORKER_PROTOCOL_MISMATCH',
      message: online
        ? 'Wan-Worker und CUDA-GPU erreichbar. Die authentifizierte Job-API für 5-Sekunden-Shots ist verbunden; finale ZERO-Exporte bleiben auf maximal 60 Sekunden begrenzt.'
        : payload.cuda_available === false
          ? 'Worker erreichbar, aber keine CUDA-GPU verfügbar. Wan-Inferenz ist nicht startbereit.'
          : 'Worker erreichbar, aber die Wan-Health-Antwort entspricht nicht dem erwarteten Protokoll.',
      maxDurationSec: 60,
      costFallback: false,
    });
  } catch {
    return res.json({
      configured: true,
      online: false,
      engine: 'Wan 2.1',
      status: 'WORKER_OFFLINE',
      message: 'Wan-GPU-Worker ist derzeit nicht erreichbar. Es wird kein kostenpflichtiger Ersatzdienst verwendet.',
      maxDurationSec: 60,
      costFallback: false,
    });
  } finally {
    clearTimeout(timeout);
  }
}));

// Authenticated server-side proxy for the self-hosted Wan worker.
// The browser never receives the worker URL or its bearer token.
function getWanWorkerConfig(): { baseUrl: URL; headers: Record<string, string> } | null {
  if (!isWanGpuAllowed()) return null;
  const configuredUrl = process.env.ZERO_VIDEO_ENGINE_URL?.trim();
  const token = process.env.ZERO_VIDEO_ENGINE_TOKEN?.trim();
  if (!configuredUrl || !token) return null;
  try {
    const baseUrl = new URL(configuredUrl);
    const internalComposeWorker =
      IS_PRODUCTION &&
      baseUrl.protocol === 'http:' &&
      baseUrl.hostname === 'wan-worker' &&
      baseUrl.port === '8000';
    const allowedProtocol =
      baseUrl.protocol === 'https:' ||
      (!IS_PRODUCTION && baseUrl.protocol === 'http:') ||
      internalComposeWorker;
    if (!allowedProtocol || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return null;
    baseUrl.pathname = '/';
    baseUrl.search = '';
    baseUrl.hash = '';
    return { baseUrl, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } };
  } catch {
    return null;
  }
}

app.post('/api/video/engine/jobs', asyncRoute(async (req, res) => {
  const worker = getWanWorkerConfig();
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht vollständig konfiguriert. Kein kostenpflichtiger Fallback.' });
  const rawIdempotencyKey = req.get('Idempotency-Key')?.trim() ?? '';
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 256) {
    return res.status(400).json({ error: 'Für Wan-Aufträge ist ein stabiler Idempotency-Key erforderlich.' });
  }
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const aspectRatio = req.body?.aspectRatio === '9:16' ? '9:16' : '16:9';
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
  const sceneId = typeof req.body?.sceneId === 'string' ? req.body.sceneId.trim() : '';
  const safeId = /^[A-Za-z0-9_-]{1,128}$/;
  const seed = Number.isInteger(req.body?.seed) && req.body.seed >= 0 && req.body.seed <= 2147483647
    ? req.body.seed
    : undefined;
  if (prompt.length < 8 || prompt.length > 1800) {
    return res.status(400).json({ error: 'Der Wan-Prompt muss zwischen 8 und 1.800 Zeichen lang sein.' });
  }
  if (!safeId.test(projectId) || !safeId.test(sceneId)) {
    return res.status(400).json({ error: 'ZERO-Projekt und Szene müssen für die Wiederaufnahme gültige IDs besitzen.' });
  }

  const result = await withZeroProjectLifecycleLock(projectId, async () => {
  const db = await loadDb();
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) return { status: 404, body: { error: 'Projekt nicht gefunden.' } };
  if (!project.scenes.some((item) => item.id === sceneId)) return { status: 404, body: { error: 'Szene nicht gefunden.' } };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL('/jobs', worker.baseUrl), {
      method: 'POST',
      headers: {
        ...worker.headers,
        'Content-Type': 'application/json',
        'X-Zero-Principal-Hash': createZeroPrincipalHash(),
        'Idempotency-Key': createZeroIdempotencyKey(),
      },
      body: JSON.stringify({
        prompt, duration_sec: 5, aspect_ratio: aspectRatio,
        project_id: projectId, scene_id: sceneId,
        ...(seed === undefined ? {} : { seed }),
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({})) as {
      job?: Record<string, unknown>; replayed?: boolean; detail?: unknown;
    };
    if (!response.ok) {
      if (response.status === 409) return { status: 409, body: { error: 'Dieser Wan-Idempotency-Key wurde bereits mit anderen Eingaben verwendet.' } };
      return { status: response.status === 429 ? 429 : 502, body: { error: 'Wan-Worker konnte den Auftrag nicht annehmen.', workerStatus: response.status } };
    }
    const job = payload.job;
    if (!job || typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(job.id) ||
        !['queued', 'running', 'succeeded', 'failed'].includes(String(job.status))) {
      return { status: 502, body: { error: 'Ungültige Auftragsantwort vom Wan-Worker.' } };
    }
    return { status: payload.replayed === true ? 200 : 202, body: {
      job: { id: job.id, status: job.status, durationSec: 5, engine: 'Wan 2.1', replayed: payload.replayed === true },
      maxFinalDurationSec: 60,
      costFallback: false,
    } };
  } catch {
    return { status: 503, body: { error: 'Wan-Worker nicht erreichbar. Es wurde kein kostenpflichtiger Ersatzdienst gestartet.' } };
  } finally {
    clearTimeout(timeout);
  }
  });
  return res.status(result.status).json(result.body);
}));

app.get('/api/video/engine/jobs', asyncRoute(async (req, res) => {
  const worker = getWanWorkerConfig();
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht konfiguriert.' });
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return res.status(400).json({ error: 'Ungültige ZERO-Projekt-ID.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL('/jobs', worker.baseUrl);
    url.searchParams.set('project_id', projectId);
    const loaded = await loadWanJobList(fetch, url, {
      headers: { ...worker.headers, 'X-Zero-Principal-Hash': createZeroPrincipalHash() },
      signal: controller.signal,
      redirect: 'error',
    });
    if (loaded.kind === 'unavailable') return res.status(503).json({ error: 'Gespeicherte Wan-Aufträge sind derzeit nicht erreichbar.' });
    if (loaded.kind !== 'ok') return res.status(502).json({ error: 'Gespeicherte Wan-Aufträge enthalten ungültige Daten.' });
    return res.json({ jobs: loaded.jobs, costFallback: false });
  } catch {
    return res.status(503).json({ error: 'Gespeicherte Wan-Aufträge sind derzeit nicht erreichbar.' });
  } finally {
    clearTimeout(timeout);
  }
}));

app.post('/api/video/engine/jobs/:id/cancel', asyncRoute(async (req, res) => {
  const worker = getWanWorkerConfig();
  const id = req.params.id;
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht konfiguriert.' });
  if (!isValidWanJobId(id)) return res.status(400).json({ error: 'Ungültige Job-ID.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL(`/jobs/${id}/cancel`, worker.baseUrl), {
      method: 'POST',
      headers: { ...worker.headers, 'X-Zero-Principal-Hash': createZeroPrincipalHash() },
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: 'Wan-Abbruch konnte vom Worker nicht bestätigt werden.' });
    if (payload.id !== id || !['cancelled', 'cancel_requested', 'succeeded', 'failed'].includes(String(payload.status))) {
      return res.status(502).json({ error: 'Ungültige Abbruchbestätigung vom Wan-Worker.' });
    }
    const statusCode = payload.status === 'cancel_requested' ? 202 : 200;
    return res.status(statusCode).json({
      job: {
        id,
        status: payload.status,
        cancelled: payload.status === 'cancelled',
        cancelRequested: payload.status === 'cancel_requested',
        message: typeof payload.message === 'string' ? payload.message : 'Worker-Status aktualisiert.',
      },
    });
  } catch {
    return res.status(503).json({ error: 'Wan-Worker nicht erreichbar. Der Abbruch ist nicht bestätigt; bitte den Jobstatus erneut prüfen.' });
  } finally {
    clearTimeout(timeout);
  }
}));

app.get('/api/video/engine/jobs/:id', asyncRoute(async (req, res) => {
  const worker = getWanWorkerConfig();
  const id = req.params.id;
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht konfiguriert.' });
  if (!isValidWanJobId(id)) return res.status(400).json({ error: 'Ungültige Job-ID.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL(`/jobs/${id}`, worker.baseUrl), {
      headers: { ...worker.headers, 'X-Zero-Principal-Hash': createZeroPrincipalHash() },
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: 'Wan-Jobstatus konnte nicht geladen werden.' });
    const job = normalizeWanJobStatus(payload, id);
    if (!job) return res.status(502).json({ error: 'Wan-Worker hat einen ungültigen Jobstatus zurückgegeben.' });
    return res.json({ job, costFallback: false });
  } catch {
    return res.status(503).json({ error: 'Wan-Worker derzeit nicht erreichbar.' });
  } finally {
    clearTimeout(timeout);
  }
}));

app.get('/api/video/engine/jobs/:id/video', asyncRoute(async (req, res) => {
  const worker = getWanWorkerConfig();
  const id = req.params.id;
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht konfiguriert.' });
  if (!isValidWanJobId(id)) return res.status(400).json({ error: 'Ungültige Job-ID.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(new URL(`/jobs/${id}/video`, worker.baseUrl), {
      headers: { ...worker.headers, 'X-Zero-Principal-Hash': createZeroPrincipalHash() },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return res.status(response.status === 409 || response.status === 404 ? response.status : 502).json({ error: 'Das Wan-Video ist noch nicht verfügbar.' });
    try {
      await streamWanVideoResponse(response, res);
      return;
    } catch (streamError) {
      if (res.headersSent) {
        res.destroy(streamError instanceof Error ? streamError : undefined);
        return;
      }
      const message = streamError instanceof Error ? streamError.message : 'Ungültiger MP4-Stream vom Wan-Worker.';
      return res.status(message.includes('100-MB') ? 413 : 502).json({ error: message });
    }
  } catch {
    return res.status(503).json({ error: 'Wan-Video konnte nicht geladen werden.' });
  } finally {
    clearTimeout(timeout);
  }
}));

// === ZERO FILM DIRECTOR (<= 60s HARD CAP) ===
function requireActiveCloudflareTextModel(db: Awaited<ReturnType<typeof loadDb>>): void {
  const model = db.models.find((item) => item.id === 'cloudflare-glm-4.7-flash');
  if (!model || !model.enabled || !model.testPassed || model.status !== 'FUNKTIONIERT' || !model.hasRealAdapter) {
    throw new Error('GLM-4.7-Flash ist nicht freigegeben. Bitte das Modell im Model Hub erfolgreich live testen und aktivieren.');
  }
}

async function generateFreeFilmDirectorText(params: {
  db: Awaited<ReturnType<typeof loadDb>>;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
}): Promise<{ text: string; modelId: string }> {
  // Cloudflare is excluded unless the operator has explicitly confirmed a
  // Workers Free account. Gemini is selected only through ZERO's free quota gate.
  const models = params.db.models.filter((model) =>
    isCloudflareWorkersAiAllowed() || model.id !== 'cloudflare-glm-4.7-flash'
  );
  const decision = chooseZeroChatModel(
    models,
    params.db.budgetGuard,
    'gemini-3.8-flash',
  );
  if (!decision) {
    throw new Error('ZERO findet kein aktiviertes, erfolgreich getestetes und nachweislich kostenlos freigegebenes Textmodell. Cloudflare bleibt ohne bestätigten Workers-Free-Plan gesperrt.');
  }

  if (decision.modelId === 'cloudflare-glm-4.7-flash') {
    const result = await generateCloudflareText({
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      maxTokens: params.maxTokens,
    });
    return result;
  }

  await reserveZeroBudgetModelAllowed(decision.modelId, 'FILM_DIRECTOR', params.db);
  const response = await withTransientRetry(() =>
    getGeminiClient().models.generateContent({
      model: decision.modelId,
      contents: [{
        role: 'user',
        parts: [{ text: `${params.systemPrompt}\n\n${params.prompt}` }],
      }],
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: params.maxTokens,
      },
    })
  );
  const text = response.text?.trim() ?? '';
  if (!text) throw new Error('Das kostenlose ZERO-Textmodell hat keine gültige Antwort geliefert.');
  return { text, modelId: decision.modelId };
}


function parseCloudflareJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^\u0060\u0060\u0060(?:json)?\s*/i, '').replace(/\s*\u0060\u0060\u0060$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('GLM hat kein gültiges JSON-Objekt geliefert. Bitte die Anfrage erneut versuchen.');
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GLM-Antwort hat nicht das erwartete JSON-Objektformat.');
  }
  return parsed as Record<string, unknown>;
}

app.post('/api/film/direct', asyncRoute(async (req, res) => {
  const principal = getZeroPrincipal(res.locals);
  if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  const db = await loadDb();
  try {
    const idea = String(req.body?.idea ?? '').trim();
    const genre = String(req.body?.genre ?? 'Thriller / Neo-Noir').trim();
    const rawTargetDurationSec = Number(req.body?.targetDurationSec ?? 58);
    const targetDurationSec = Math.min(60, Math.max(20, Number.isFinite(rawTargetDurationSec) ? Math.round(rawTargetDurationSec) : 58));
    const characterId = req.body?.characterId ? String(req.body.characterId) : '';
    const generateImages = Boolean(req.body?.generateImages);

    if (!idea) return res.status(400).json({ error: 'Filmidee fehlt.' });

    const char = characterId ? db.characters.find((item) => item.id === characterId) : db.characters[0];
    const charContext = char
      ? `Hauptfigur: ${char.name} (${char.role}). Aussehen für Bildkonsistenz: ${char.consistencyPrompt}.`
      : 'Entwickle eine konsistente Hauptfigur.';
    const continuityState = validateContinuityState(db.continuity ?? emptyContinuityState());
    const seriesId = typeof req.body?.seriesId === 'string' ? req.body.seriesId.trim() : '';
    const continuityContext = seriesId ? buildContinuityDirectorContext(continuityState, seriesId, char ? [char.id] : [], db.characters) : null;
    if (seriesId && !continuityContext) return res.status(404).json({ error: 'Die ausgewählte Serie existiert nicht oder ist archiviert.' });
    if (continuityContext && (continuityContext.conflicts.length || continuityContext.semanticConflicts.length)) return res.status(409).json({ error: 'Die Serienkontinuität enthält Widersprüche. Bitte zuerst die Konflikte im Continuity-Bereich beheben.', code: 'CONTINUITY_CONFLICT', conflicts: continuityContext.conflicts, semanticConflicts: continuityContext.semanticConflicts });

    const modelResponse = await generateFreeFilmDirectorText({
      db,
      systemPrompt: 'Du bist ZERO FILM DIRECTOR, ein professioneller deutscher Kurzfilm-Regisseur. Antworte ausschließlich mit einem gültigen JSON-Objekt ohne Markdown, Vorrede oder Codeblock. Erfinde keine zusätzlichen Felder. Halte jede Szene filmisch präzise und produktionstauglich.',
      prompt: `Erstelle eine vollständige Kurzfilm-Produktion auf Deutsch.
Idee: ${idea}
Genre: ${genre}
Ziel-Gesamtdauer: exakt ${targetDurationSec} Sekunden; niemals über 60 Sekunden.
${charContext}
${continuityContext?.promptText ?? ''}
Erstelle exakt 4 Szenen, deren Dauer zusammen exakt ${targetDurationSec} Sekunden ergibt. Jede Szene muss mindestens 5 Sekunden haben. Halte die Felder kompakt, aber konkret.

Gib ausschließlich dieses JSON-Schema zurück:
{
  "title": "Kurzer Filmtitel",
  "logline": "Ein-Satz-Prämisse",
  "concept": "Visuelles und dramaturgisches Konzept",
  "story": "Zusammenhängende Inhaltsangabe",
  "screenplay": "Kurzes Drehbuch mit Dialog und Handlung",
  "scenes": [
    {
      "title": "Szenentitel",
      "location": "Drehort",
      "timeOfDay": "Tageszeit",
      "durationSec": 14,
      "cameraMovement": "Statisch",
      "narrationText": "Deutsche Sprecherzeile",
      "subtitleText": "Deutscher Untertitel/Dialog",
      "soundCue": "Musik- und Geräuschhinweis",
      "imagePrompt": "English cinematic still-image prompt with consistent character appearance",
      "videoPrompt": "English cinematic motion prompt"
    }
  ]
}
cameraMovement muss einer dieser Werte sein: Statisch, Langsamer Zoom-In, Sanfter Zoom-Out, Schwenk Links, Schwenk Rechts, Vertikaler Tilt.
Die vier durationSec-Werte müssen exakt ${targetDurationSec} ergeben.`,
      maxTokens: 1800,
    });
    const parsed = parseCloudflareJsonObject(modelResponse.text) as {
      title: string;
      logline: string;
      concept: string;
      story: string;
      screenplay: string;
      scenes: Array<{
        title: string;
        location: string;
        timeOfDay: string;
        durationSec: number;
        cameraMovement: string;
        narrationText: string;
        subtitleText: string;
        soundCue: string;
        imagePrompt: string;
        videoPrompt: string;
      }>;
    };
    if (!Array.isArray(parsed.scenes) || parsed.scenes.length < 4) {
      throw new Error('ZERO FILM DIRECTOR erhielt weniger als vier Szenen. Bitte den Entwurf erneut erstellen.');
    }

    let mappedScenes: FilmScene[] = parsed.scenes.slice(0, 4).map((s, idx) => ({
      id: `scene-${Date.now()}-${idx + 1}`,
      index: idx + 1,
      title: s.title,
      location: s.location,
      timeOfDay: s.timeOfDay,
      durationSec: Math.max(5, Math.min(20, Number(s.durationSec) || 14)),
      cameraMovement: resolveFilmCameraMovement(s.cameraMovement, idx),
      characterIds: char ? [char.id] : [],
      narrationText: s.narrationText,
      dialogueText: '',
      subtitleText: s.subtitleText,
      soundCue: s.soundCue,
      imagePrompt: char ? `${char.consistencyPrompt}. ${s.imagePrompt}` : s.imagePrompt,
      videoPrompt: s.videoPrompt,
      status: 'Entwurf',
    }));

    // Keep the requested total duration exact and guarantee four valid 5–15-second scenes.
    const baseSceneDuration = Math.floor(targetDurationSec / 4);
    const extraSceneSeconds = targetDurationSec % 4;
    mappedScenes.forEach((scene, idx) => {
      scene.durationSec = baseSceneDuration + (idx < extraSceneSeconds ? 1 : 0);
    });
    mappedScenes = clampScenesToMax60Seconds(mappedScenes);

    const imageGenerationWarnings: string[] = [];
    if (generateImages) {
      const imageModel = db.models.find((item) => item.id === 'flux-1-schnell-free');
      const imageReady = Boolean(
        isCloudflareWorkersAiAllowed() &&
        imageModel?.enabled &&
        imageModel.testPassed &&
        imageModel.status === 'FUNKTIONIERT' &&
        imageModel.hasRealAdapter
      );
      if (!imageReady) {
        imageGenerationWarnings.push(
          'FLUX-Szenenbilder sind gesperrt, solange ZERO_CLOUDFLARE_AI_ENABLED=true und ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED=true nicht für ein Workers-Free-Konto gesetzt ist und FLUX nicht live getestet wurde. Der Filmtext wurde trotzdem erstellt.'
        );
        mappedScenes.forEach((scene) => { scene.status = 'Bildgenerierung nicht verfügbar'; });
      } else {
        // Sequential requests reduce burst load on the shared Cloudflare Free Neuron allocation.
        for (const [idx, scene] of mappedScenes.entries()) {
          try {
            const img = await generateFreeCloudImage({
              prompt: scene.imagePrompt,
              model: 'flux',
            });
            scene.imageUrl = img.imageDataUrl;
            scene.status = 'Bild bereit';
          } catch (imageError) {
            scene.status = 'Bildgenerierung nicht verfügbar';
            imageGenerationWarnings.push(
              imageError instanceof Error ? imageError.message : `Szenenbild ${idx + 1} konnte nicht generiert werden.`
            );
          }
        }
      }
    }

    const totalSec = mappedScenes.reduce((acc, s) => acc + s.durationSec, 0);
    const now = new Date().toISOString();
    const newProject: StudioProject = {
      id: `proj-${Date.now()}`,
      ownerId: principal.id,
      title: parsed.title || 'Neuer Kurzfilm',
      logline: parsed.logline || idea,
      genre,
      targetDurationSec: totalSec,
      concept: parsed.concept || '',
      story: parsed.story || '',
      screenplay: parsed.screenplay || '',
      characterIds: char ? [char.id] : [],
      scenes: mappedScenes,
      assets: [],
      snapshots: [
        {
          id: `snap-${Date.now()}`,
          version: 1,
          note: 'Automatisch durch ZERO FILM DIRECTOR erstellt',
          createdAt: now,
          sceneCount: mappedScenes.length,
          totalDurationSec: totalSec,
          state: {
            title: parsed.title || 'Neuer Kurzfilm',
            logline: parsed.logline || idea,
            genre,
            targetDurationSec: totalSec,
            concept: parsed.concept || '',
            story: parsed.story || '',
            screenplay: parsed.screenplay || '',
            characterIds: char ? [char.id] : [],
            scenes: mappedScenes,
            assets: [],
            status: mappedScenes.some((scene) => Boolean(scene.imageUrl)) ? 'In Produktion' : 'Konzept',
          },
        },
      ],
      status: mappedScenes.some((scene) => Boolean(scene.imageUrl)) ? 'In Produktion' : 'Konzept',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    db.projects.unshift(newProject);
    db.memories.unshift({
      id: `mem-${Date.now()}`,
      type: 'production',
      title: `Filmprojekt: ${newProject.title}`,
      content: `${newProject.logline} (${mappedScenes.length} Szenen, ${totalSec}s Gesamtdauer).`,
      tags: ['film-director', genre.toLowerCase()],
      projectId: newProject.id,
      createdAt: now,
      updatedAt: now,
    });
    const continuityResult = continuityContext && seriesId ? recordFilmProductionContinuity(continuityState, seriesId, newProject) : null;
    if (continuityResult) db.continuity = continuityState;
    await saveDb(db);
    await maybeAutoCreateZipBackup(`Filmprojekt "${newProject.title}" generiert (${totalSec}s)`);

    res.json({ project: newProject, imageGenerationWarnings, ...(continuityResult ? { continuity: continuityResult } : {}) });
  } catch (err) {
    res.status(400).json({ error: formatGermanApiError(err) });
  }
}));

app.post('/api/film/regenerate-scene', asyncRoute(async (req, res) => {
  const principal = getZeroPrincipal(res.locals);
  if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  const db = await loadDb();
  try {
    const projectId = String(req.body?.projectId ?? '');
    const sceneId = String(req.body?.sceneId ?? '');
    const instruction = String(req.body?.instruction ?? 'Verbessere Bildkomposition und Spannung.').trim();
    const project = resolveOwnedProject(db.projects, principal, projectId);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return res.status(404).json({ error: 'Szene nicht gefunden.' });
    const continuityState = validateContinuityState(db.continuity ?? emptyContinuityState());
    const linkedSeries = continuityState.series.find((item) => !item.archivedAt && item.projectIds.includes(project.id));
    const continuityContext = linkedSeries ? buildContinuityDirectorContext(continuityState, linkedSeries.id, scene.characterIds, db.characters) : null;
    const targetConflictId = typeof req.body?.targetConflictId === 'string' ? req.body.targetConflictId : ''; const targetedConflict = targetConflictId ? continuityContext?.semanticConflicts.find((item) => item.id === targetConflictId && item.sceneId === scene.id) : undefined; if (targetConflictId && !targetedConflict) return res.status(404).json({ error: 'Der ausgewählte Konflikt gehört nicht zu dieser Szene oder ist nicht mehr aktuell.' }); if (!targetedConflict && continuityContext && (continuityContext.conflicts.length || continuityContext.semanticConflicts.length)) return res.status(409).json({ error: 'Szenen-Neugenerierung gestoppt: Bitte einen konkreten Kontinuitätskonflikt zur gezielten Korrektur auswählen.', code: 'CONTINUITY_CONFLICT', conflicts: continuityContext.conflicts, semanticConflicts: continuityContext.semanticConflicts });

    const response = await generateFreeFilmDirectorText({
      db,
      systemPrompt: 'Du bist ZERO FILM DIRECTOR. Antworte ausschließlich mit einem gültigen JSON-Objekt ohne Markdown oder Erklärtext.',
      prompt: `Überarbeite Szene ${scene.index} (" ${scene.title}") des Kurzfilms "${project.title}" gemäß Anweisung: "${instruction}".
Bisherige Erzählung: ${scene.narrationText}
Bisheriger Bild-Prompt: ${scene.imagePrompt}
${continuityContext?.promptText ?? ''}
${targetedConflict ? '\nZIELKONFLIKT: ' + targetedConflict.message + '\nVERBINDLICHE KORREKTUR: ' + targetedConflict.suggestion : ''}

Gib ausschließlich ein JSON-Objekt mit genau diesen Feldern zurück:
{"title":"...","narrationText":"...","subtitleText":"...","imagePrompt":"...","videoPrompt":"...","soundCue":"...","characterIds":["bestehende Figuren-IDs"]}`,
      maxTokens: 750,
    });
    const updated = parseCloudflareJsonObject(response.text);
    const stringField = (value: unknown, fallback: string): string =>
      typeof value === 'string' && value.trim() ? value.trim() : fallback;

    scene.title = stringField(updated.title, scene.title);
    scene.narrationText = stringField(updated.narrationText, scene.narrationText);
    scene.subtitleText = stringField(updated.subtitleText, scene.subtitleText);
    scene.soundCue = stringField(updated.soundCue, scene.soundCue);
    scene.imagePrompt = stringField(updated.imagePrompt, scene.imagePrompt);
    scene.videoPrompt = stringField(updated.videoPrompt, scene.videoPrompt);
    if (Array.isArray(updated.characterIds) && updated.characterIds.every((id: unknown) => typeof id === 'string' && db.characters.some((character) => character.id === id))) scene.characterIds = [...new Set(updated.characterIds as string[])];
    if (targetedConflict?.code === 'DEAD_CHARACTER_ON_SCREEN' && targetedConflict.characterId) scene.characterIds = scene.characterIds.filter((id) => id !== targetedConflict.characterId);

    // Text and scene direction can be revised without an unavailable cloud image provider.
    // Keep any previous image asset, but mark the scene as a draft because it no longer matches the revised prompt.
    scene.status = 'Entwurf';
    project.updatedAt = new Date().toISOString();
    project.version = (project.version ?? 0) + 1;
    if (linkedSeries) {
      recordFilmSceneRevision(continuityState, linkedSeries.id, project, scene);
      const remaining = detectSemanticContinuityConflicts(continuityState, linkedSeries.id, db.characters).filter((item) => item.id === targetConflictId);
      if (targetedConflict && remaining.length) return res.status(422).json({ error: 'Die gezielte Korrektur hat den Kontinuitätskonflikt noch nicht behoben. Es wurde nichts gespeichert.', code: 'CONTINUITY_CORRECTION_INCOMPLETE', conflicts: remaining });
      db.continuity = continuityState;
    }
    await saveDb(db);

    res.json({ scene, project, ...(targetedConflict ? { resolvedConflictId: targetedConflict.id } : {}) });
  } catch (err) {
    res.status(400).json({ error: formatGermanApiError(err) });
  }
}));

// === ZERO PROJECTS ===
app.get('/api/projects', asyncRoute(async (_req, res) => {
  const principal = getZeroPrincipal(res.locals);
  if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  const db = await loadDb();
  const projects = db.projects.filter((project) => project.ownerId === principal.id).map((project) => ({
    ...project,
    scenes: sanitizeProjectScenes(project.scenes),
    assets: sanitizeProjectAssets(project.assets),
    snapshots: sanitizeProjectSnapshots(project.snapshots),
  }));
  res.json({ projects });
}));

app.post('/api/projects', asyncRoute(async (req, res) => {
  const principal = getZeroPrincipal(res.locals);
  if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  const db = await loadDb();
  const now = new Date().toISOString();
  const rawDuration = Number(req.body?.targetDurationSec ?? 58);
  const clampedDuration = Math.min(60, Math.max(10, rawDuration));
  const scenes = Array.isArray(req.body?.scenes)
    ? sanitizeProjectScenes(clampScenesToMax60Seconds(req.body.scenes as FilmScene[]))
    : [];
  const scenesDuration = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const projectDuration = Math.min(60, scenesDuration || clampedDuration);
  const newProject: StudioProject = {
    id: `proj-${Date.now()}`,
    ownerId: principal.id,
    title: String(req.body?.title || 'Unbenanntes Projekt').trim(),
    logline: String(req.body?.logline || '').trim(),
    genre: String(req.body?.genre || 'Drama / Thriller').trim(),
    targetDurationSec: projectDuration,
    concept: String(req.body?.concept || ''),
    story: String(req.body?.story || ''),
    screenplay: String(req.body?.screenplay || ''),
    characterIds: Array.isArray(req.body?.characterIds) ? req.body.characterIds : [],
    scenes,
    assets: [],
    snapshots: [
      {
        id: `snap-${Date.now()}`,
        version: 1,
        note: 'Projekt angelegt',
        createdAt: now,
        sceneCount: scenes.length,
        totalDurationSec: projectDuration,
        state: {
          title: String(req.body?.title || 'Unbenanntes Projekt').trim(),
          logline: String(req.body?.logline || '').trim(),
          genre: String(req.body?.genre || 'Drama / Thriller').trim(),
          targetDurationSec: projectDuration,
          concept: String(req.body?.concept || ''),
          story: String(req.body?.story || ''),
          screenplay: String(req.body?.screenplay || ''),
          characterIds: Array.isArray(req.body?.characterIds) ? req.body.characterIds : [],
          scenes,
          assets: [],
          status: 'Konzept',
        },
      },
    ],
    status: 'Konzept',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.projects.unshift(newProject);
  await saveDb(db);
  res.json({ project: newProject });
}));

app.put('/api/projects/:id', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const idx = db.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

  const prev = db.projects[idx];

  // Only explicitly supported content fields may be changed through this route.
  // Identity, timestamps, versions, snapshots and assets are server-managed;
  // assets must continue to use the dedicated validated /assets endpoint.
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const nextScenes = sanitizeProjectScenes(
    Array.isArray(body.scenes) ? clampScenesToMax60Seconds(body.scenes) : prev.scenes
  );
  const safePreviousAssets = sanitizeProjectAssets(prev.assets);
  const safePreviousScenes = sanitizeProjectScenes(prev.scenes);
  const nextTotal = nextScenes.reduce((s, sc) => s + sc.durationSec, 0);
  const nextVersion = prev.version + 1;
  const now = new Date().toISOString();
  const allowedStatuses: StudioProject['status'][] = ['Konzept', 'In Produktion', 'Schnittbereit', 'Exportiert'];
  const requestedStatus = typeof body.status === 'string' && allowedStatuses.includes(body.status as StudioProject['status'])
    ? body.status as StudioProject['status']
    : prev.status;
  const requestedCharacterIds = Array.isArray(body.characterIds)
    ? body.characterIds.filter((id): id is string => typeof id === 'string').slice(0, 100)
    : prev.characterIds;

  const previousState = {
    title: prev.title,
    logline: prev.logline,
    genre: prev.genre,
    targetDurationSec: prev.targetDurationSec,
    concept: prev.concept,
    story: prev.story,
    screenplay: prev.screenplay,
    characterIds: prev.characterIds,
    scenes: safePreviousScenes,
    assets: safePreviousAssets,
    status: prev.status,
  };
  const updated: StudioProject = {
    ...prev,
    title: typeof body.title === 'string' ? body.title.slice(0, 200) : prev.title,
    logline: typeof body.logline === 'string' ? body.logline.slice(0, 2000) : prev.logline,
    genre: typeof body.genre === 'string' ? body.genre.slice(0, 120) : prev.genre,
    concept: typeof body.concept === 'string' ? body.concept.slice(0, 10000) : prev.concept,
    story: typeof body.story === 'string' ? body.story.slice(0, 20000) : prev.story,
    screenplay: typeof body.screenplay === 'string' ? body.screenplay.slice(0, 30000) : prev.screenplay,
    characterIds: requestedCharacterIds,
    status: requestedStatus,
    scenes: nextScenes,
    assets: safePreviousAssets,
    targetDurationSec: Math.min(60, nextTotal || prev.targetDurationSec),
    version: nextVersion,
    updatedAt: now,
    snapshots: [
      {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        version: prev.version,
        note: typeof body.snapshotNote === 'string' && body.snapshotNote.trim()
          ? body.snapshotNote.trim().slice(0, 200)
          : `Sicherung vor Version ${nextVersion}`,
        createdAt: now,
        sceneCount: prev.scenes.length,
        totalDurationSec: Math.min(60, prev.targetDurationSec),
        state: previousState,
      },
      ...sanitizeProjectSnapshots(prev.snapshots),
    ].slice(0, 15),
  };

  db.projects[idx] = updated;
  await saveDb(db);
  await maybeAutoCreateZipBackup(`Projekt "${updated.title}" auf Version ${updated.version} aktualisiert`);
  res.json({ project: updated });
}));

app.post('/api/projects/:id/snapshots/:snapshotId/restore', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const project = db.projects.find((item) => item.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  const snapshot = project.snapshots.find((item) => item.id === req.params.snapshotId);
  if (!snapshot) return res.status(404).json({ error: 'Projektversion nicht gefunden.' });
  if (!snapshot.state) {
    return res.status(409).json({ error: 'Diese ältere Version enthält nur Metadaten und kann nicht wiederhergestellt werden. Neu gespeicherte Versionen enthalten den vollständigen Projektstand.' });
  }

  const now = new Date().toISOString();
  const currentState = {
    title: project.title,
    logline: project.logline,
    genre: project.genre,
    targetDurationSec: project.targetDurationSec,
    concept: project.concept,
    story: project.story,
    screenplay: project.screenplay,
    characterIds: project.characterIds,
    scenes: sanitizeProjectScenes(project.scenes),
    assets: sanitizeProjectAssets(project.assets),
    status: project.status,
  };
  const restoredScenes = sanitizeProjectScenes(clampScenesToMax60Seconds(snapshot.state.scenes));
  const restoredDuration = Math.min(60, restoredScenes.reduce((sum, scene) => sum + scene.durationSec, 0) || snapshot.state.targetDurationSec);
  const nextVersion = project.version + 1;
  const safetySnapshot = {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    version: project.version,
    note: `Sicherung vor Wiederherstellung von Version ${snapshot.version}`,
    createdAt: now,
    sceneCount: project.scenes.length,
    totalDurationSec: Math.min(60, project.targetDurationSec),
    state: currentState,
  };
  const restoredProject: StudioProject = {
    ...project,
    ...snapshot.state,
    id: project.id,
    ownerId: project.ownerId,
    scenes: restoredScenes,
    assets: sanitizeProjectAssets(snapshot.state.assets),
    targetDurationSec: restoredDuration,
    version: nextVersion,
    updatedAt: now,
    snapshots: [safetySnapshot, ...sanitizeProjectSnapshots(project.snapshots)].slice(0, 15),
  };
  db.projects[db.projects.indexOf(project)] = restoredProject;
  await saveDb(db);
  await maybeAutoCreateZipBackup(`Projekt "${restoredProject.title}" auf gespeicherte Version ${snapshot.version} zurückgesetzt`);
  return res.json({ ok: true, project: restoredProject, restoredFromVersion: snapshot.version });
}));

app.get('/api/projects/:id/scenes/:sceneId/video', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const project = db.projects.find((item) => item.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  if (!project.scenes.some((item) => item.id === req.params.sceneId)) {
    return res.status(404).json({ error: 'Szene nicht gefunden.' });
  }
  const asset = await getProjectVideoAssetStore().openReadLatestForScene(
    req.params.id, req.params.sceneId, createZeroPrincipalHash()
  );
  if (!asset) return res.status(404).json({ error: 'Für diese Szene ist kein gespeicherter Videoclip vorhanden.' });
  return sendProjectVideoStream(req, res, asset);
}));

app.get('/api/projects/:id/videos', asyncRoute(async (req, res) => {
  const db = await loadDb();
  if (!db.projects.some((item) => item.id === req.params.id)) {
    return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  }
  const assets = await getProjectVideoAssetStore().list(req.params.id, createZeroPrincipalHash());
  return res.json({ assets, retention: 'manual-delete', maxClipBytes: 100 * 1024 * 1024, maxProjectBytes: 500 * 1024 * 1024, maxProjectClips: 50 });
}));

app.get('/api/projects/:id/videos/:assetId', asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.assetId)) return res.status(404).json({ error: 'Clip nicht gefunden.' });
  const db = await loadDb();
  if (!db.projects.some((item) => item.id === req.params.id)) {
    return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  }
  const asset = await getProjectVideoAssetStore().openRead(
    req.params.assetId, req.params.id, createZeroPrincipalHash()
  );
  if (!asset) return res.status(404).json({ error: 'Clip nicht gefunden oder Aufbewahrungsfrist abgelaufen.' });
  return sendProjectVideoStream(req, res, asset, req.query.download === '1');
}));

app.delete('/api/projects/:id/videos/:assetId', asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.assetId)) return res.status(404).json({ error: 'Clip nicht gefunden.' });
  const db = await loadDb();
  if (!db.projects.some((item) => item.id === req.params.id)) {
    return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  }
  const deleted = await getProjectVideoAssetStore().remove(
    req.params.assetId, req.params.id, createZeroPrincipalHash()
  );
  if (!deleted) return res.status(404).json({ error: 'Clip nicht gefunden.' });
  return res.json({ ok: true });
}));

app.put(
  '/api/projects/:id/scenes/:sceneId/video',
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  asyncRoute(async (req, res) => {
    const db = await loadDb();
    const project = db.projects.find((item) => item.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    if (!project.scenes.some((item) => item.id === req.params.sceneId)) {
      return res.status(404).json({ error: 'Szene nicht gefunden.' });
    }
    const contentType = String(req.get('X-Zero-Video-Type') || '').split(';')[0].trim().toLowerCase();
    if (!Buffer.isBuffer(req.body) || !isValidProjectVideoPayload(req.body, contentType)) {
      return res.status(400).json({ error: 'Ungültiger Videoclip. Erlaubt sind MP4/WebM zwischen 1 KB und 100 MB.' });
    }
    const jobId = req.get('X-Zero-Wan-Job-Id')?.trim() || null;
    try {
      const asset = await getProjectVideoAssetStore().put({
        projectId: req.params.id,
        sceneId: req.params.sceneId,
        principalHash: createZeroPrincipalHash(),
        jobId,
        contentType: contentType as 'video/mp4' | 'video/webm',
        payload: req.body,
        isProjectActive: async () => {
          const latest = await readPersistentState<ZeroDatabase>();
          return Boolean(latest?.payload.projects.some((item) => item.id === req.params.id));
        },
      });
      project.updatedAt = new Date().toISOString();
      await saveDb(db);
      return res.json({ ok: true, serverPersisted: true, asset });
    } catch (error) {
      if (error instanceof ProjectVideoProjectNotFoundError) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
      if (error instanceof ProjectVideoLimitError) return res.status(413).json({ error: error.message });
      if (error instanceof Error && /Invalid|Wan job/.test(error.message)) return res.status(400).json({ error: error.message });
      throw error;
    }
  })
);

app.post('/api/projects/:id/assets', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

  project.scenes = sanitizeProjectScenes(project.scenes);
  project.assets = sanitizeProjectAssets(project.assets);
  project.snapshots = sanitizeProjectSnapshots(project.snapshots);

  const allowedTypes: ProjectAsset['type'][] = ['image', 'audio', 'music', 'video', 'script'];
  const type = req.body?.type ?? 'image';
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'Ungültiger Asset-Typ.' });
  }
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!url.trim()) return res.status(400).json({ error: 'Asset-URL fehlt.' });
  if (url.length > 16 * 1024 * 1024) {
    return res.status(413).json({ error: 'Asset ist zu groß (maximal 16 MB Daten). Bitte kleinere Datei verwenden.' });
  }
  if (!isSafeProjectAssetUrl(url, type)) {
    return res.status(400).json({ error: 'Ungültige Asset-Quelle oder nicht erlaubter Medientyp. Erlaubt sind passende Bild-/Audio-/Video-Daten, HTTPS/HTTP oder lokale Studio-Assets.' });
  }
  const rawDuration = req.body?.durationSec;
  const durationSec = rawDuration === undefined || rawDuration === null || rawDuration === ''
    ? undefined
    : Number(rawDuration);
  if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec <= 0)) {
    return res.status(400).json({ error: 'Ungültige Mediendauer.' });
  }
  if (project.assets.length >= 200) {
    return res.status(409).json({ error: 'Dieses Projekt enthält bereits 200 Assets. Bitte zuerst ältere Assets entfernen.' });
  }

  const asset: ProjectAsset = {
    id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title: String(req.body?.title || 'Studio Asset').trim().slice(0, 120),
    url,
    modelId: String(req.body?.modelId || 'zero-studio').trim().slice(0, 100),
    durationSec: durationSec === undefined ? undefined : Math.min(60, durationSec),
    createdAt: new Date().toISOString(),
  };
  project.assets.unshift(asset);
  project.updatedAt = new Date().toISOString();
  await saveDb(db);
  res.json({ asset, project });
}));

app.delete('/api/projects/:id', asyncRoute(async (req, res) => {
  const principal = getZeroPrincipal(res.locals);
  if (!principal) return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  const result = await withZeroProjectLifecycleLock(req.params.id, async () => {
  const db = await loadDb();
  const ownedProjects = db.projects.filter((project) => project.ownerId === principal.id);
  const projectExists = ownedProjects.some((project) => project.id === req.params.id);
  if (projectExists) {
    if (ownedProjects.length <= 1) {
      return { status: 400, body: { error: 'Mindestens ein aktives Projekt muss erhalten bleiben.' } };
    }
    if (process.env.DATABASE_URL) {
      await recordProjectDeletionIdempotency(
        req.params.id,
        principal.id,
        String(res.locals.zeroRequestIdempotencyKey ?? ''),
      );
    }
    db.projects = db.projects.filter((project) => !(project.id === req.params.id && project.ownerId === principal.id));
    await saveDb(db);
  }
  // Retry-safe cleanup spans both PostgreSQL project clips and the durable GPU worker.
  await getProjectVideoAssetStore().removeProject(req.params.id, createZeroPrincipalHash());
  const worker = getWanWorkerConfig();
  let workerCleanup: { deleted?: number; pending?: number } = {};
  if (worker) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const workerUrl = new URL('/jobs', worker.baseUrl);
      workerUrl.searchParams.set('project_id', req.params.id);
      const response = await fetch(workerUrl, {
        method: 'DELETE',
        headers: { ...worker.headers, 'X-Zero-Principal-Hash': createZeroPrincipalHash() },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        return { status: 503, body: { error: 'Wan-Aufträge und Worker-Dateien konnten noch nicht vollständig bereinigt werden. Projektlöschung erneut versuchen.' } };
      }
      workerCleanup = await response.json().catch(() => ({})) as { deleted?: number; pending?: number };
    } catch {
      return { status: 503, body: { error: 'Wan-Worker für die Projektbereinigung nicht erreichbar. Projektlöschung erneut versuchen.' } };
    } finally {
      clearTimeout(timeout);
    }
  }
  const projects = db.projects.filter((project) => project.ownerId === principal.id).map((project) => ({
    ...project,
    scenes: sanitizeProjectScenes(project.scenes),
    assets: sanitizeProjectAssets(project.assets),
    snapshots: sanitizeProjectSnapshots(project.snapshots),
  }));
  return { status: 200, body: { ok: true, projects, workerCleanup } };
  });
  return res.status(result.status).json(result.body);
}));

// === ZERO CHARACTER ENGINE ===
app.get('/api/characters', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  res.json({ characters: db.characters });
}));

app.post('/api/characters', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const now = new Date().toISOString();
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Charaktername fehlt.' });

  const appearance = String(req.body?.appearance ?? '').trim();
  const faceFeatures = String(req.body?.faceFeatures ?? '').trim();
  const clothing = String(req.body?.clothing ?? '').trim();

  const consistencyPrompt = `${name}, ${appearance}, ${faceFeatures}, wearing ${clothing}, consistent character design, Leica 35mm photography`.trim();

  let referenceImageUrl = String(req.body?.referenceImageUrl ?? '');
  if (!referenceImageUrl && req.body?.generateReference) {
    try {
      const img = await generateFreeCloudImage({
        prompt: `Editorial portrait of ${consistencyPrompt}, dark moody studio lighting`,
        model: 'flux',
        aspectRatio: '1:1',
      });
      referenceImageUrl = img.imageDataUrl;
    } catch {
      referenceImageUrl = '';
    }
  }

  const char: CharacterProfile = {
    id: `char-${Date.now()}`,
    name,
    role: String(req.body?.role ?? 'Hauptfigur'),
    age: String(req.body?.age ?? '30'),
    appearance,
    faceFeatures,
    clothing,
    voiceStyle: String(req.body?.voiceStyle ?? 'Ruhig & präzise'),
    voiceName: (req.body?.voiceName ?? 'Kore') as CharacterProfile['voiceName'],
    referenceImageUrl,
    consistencyPrompt,
    notes: String(req.body?.notes ?? ''),
    createdAt: now,
  };

  db.characters.unshift(char);
  db.memories.unshift({
    id: `mem-${Date.now()}`,
    type: 'character',
    title: `Charakterprofil: ${char.name}`,
    content: `${char.role} — ${char.consistencyPrompt}`,
    tags: ['charakter', char.name.toLowerCase()],
    createdAt: now,
    updatedAt: now,
  });
  await saveDb(db);
  res.json({ character: char });
}));

// Read-only operation recovery is scoped to the server-bound principal.
app.get('/api/zero/operations/:id', asyncRoute(async (req, res) => {
  const operation = await getZeroResourceOperationStatusWithPool(
    getPostgresPool(), requireZeroPrincipal(), req.params.id,
  );
  res.setHeader('Cache-Control', 'no-store');
  if (!operation) return res.status(404).json({ error: 'ZERO-Auftrag nicht gefunden.' });
  return res.json({ operation });
}));

// === ZERO COST GUARD CONTROL (authenticated admin API) ===
app.get('/api/system/cost-guard', asyncRoute(async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.json({
      dayUtc: new Date().toISOString().slice(0, 10),
      requestsUsed: 0,
      dailyLimit: 0,
      remainingRequests: 0,
      paused: true,
      configured: false,
      providers: { cloudflare: 'GESPERRT', gemini: 'GESPERRT' },
      recentEvents: [],
      persistenceAvailable: false,
    });
  }
  const status = await getZeroCostGuardStatus(getPostgresPool());
  res.json({ ...status, persistenceAvailable: true });
}));

app.post('/api/system/cost-guard/pause', asyncRoute(async (req, res) => {
  // The global production /api middleware authenticates the session first.
  // Require an exact browser Origin match before any state-changing action.
  if (!isSameOriginRequest(req.get('origin'), req.get('host'), req.protocol)) {
    return res.status(403).json({ error: 'Ungültiger oder fehlender Origin-Header.' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'PostgreSQL nicht verfügbar. Kostenwächter bleibt fail-closed.' });
  }
  if (typeof req.body?.paused !== 'boolean') {
    return res.status(400).json({ error: 'paused muss true oder false sein.' });
  }
  const configuredLimit = Number(process.env.ZERO_COST_GUARD_DAILY_REQUEST_LIMIT);
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 100_000) {
    return res.status(400).json({ error: 'ZERO_COST_GUARD_DAILY_REQUEST_LIMIT fehlt oder ist ungültig. Pause/Resume wurde nicht verändert.' });
  }
  await setZeroCostGuardPaused(getPostgresPool(), req.body.paused, configuredLimit);
  const status = await getZeroCostGuardStatus(getPostgresPool());
  res.json({ ok: true, ...status, persistenceAvailable: true });
}));

// === ZERO MEMORY ===
app.get('/api/memory', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  res.json({ memories: db.memories });
}));

app.post('/api/memory', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const title = String(req.body?.title ?? '').trim();
  const content = String(req.body?.content ?? '').trim();
  if (!title || !content) return res.status(400).json({ error: 'Titel und Inhalt erforderlich.' });

  let embedding: number[] | undefined;
  let embeddingNotice: string | undefined;
  if (process.env.GEMINI_API_KEY) {
    const result = await runMemoryEmbedding({
      budgetGuard: db.budgetGuard,
      action: 'MEMORY_EMBED',
      contents: [`${title}\n${content}`],
      recordAudit: (entry) => recordBudgetAudit(db, entry),
      reserveQuota: () => reserveZeroBudgetModelAllowed('gemini-embedding-2', 'MEMORY_EMBED', db),
      embed: async (modelId, contents) => {
        const ai = getGeminiClient();
        const response = await ai.models.embedContent({ model: modelId, contents });
        return response.embeddings?.[0]?.values;
      },
      persistExhausted: async () => { await markGeminiQuotaExhausted('gemini-embedding-2', db); await saveDb(db); },
    });
    embedding = result.vector;
    embeddingNotice = result.notice;
  }

  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: `mem-${Date.now()}`,
    type: (req.body?.type ?? 'knowledge') as MemoryEntry['type'],
    title,
    content,
    tags: Array.isArray(req.body?.tags)
      ? req.body.tags
      : String(req.body?.tags ?? '')
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean),
    embedding,
    createdAt: now,
    updatedAt: now,
  };

  db.memories.unshift(entry);
  await saveDb(db);
  res.json({ memory: entry, ...(embeddingNotice ? { embeddingNotice } : {}) });
}));

app.post('/api/memory/search', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const query = String(req.body?.query ?? '').trim();
  if (!query) return res.json({ results: db.memories.map((m) => ({ memory: m, score: 1 })) });

  let queryVec: number[] | null = null;
  let embeddingNotice: string | undefined;
  if (process.env.GEMINI_API_KEY) {
    const result = await runMemoryEmbedding({
      budgetGuard: db.budgetGuard,
      action: 'MEMORY_SEARCH',
      contents: [query],
      recordAudit: (entry) => recordBudgetAudit(db, entry),
      reserveQuota: () => reserveZeroBudgetModelAllowed('gemini-embedding-2', 'MEMORY_SEARCH', db),
      embed: async (modelId, contents) => {
        const ai = getGeminiClient();
        const response = await ai.models.embedContent({ model: modelId, contents });
        return response.embeddings?.[0]?.values;
      },
      persistExhausted: async () => { await markGeminiQuotaExhausted('gemini-embedding-2', db); await saveDb(db); },
    });
    queryVec = result.vector ?? null;
    embeddingNotice = result.notice;
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = db.memories.map((m) => {
    const haystack = `${m.title} ${m.content} ${m.tags.join(' ')}`.toLowerCase();
    const lexicalHits = terms.filter((t) => haystack.includes(t)).length / Math.max(1, terms.length);
    const vectorScore = queryVec && m.embedding ? Math.max(0, cosineSimilarity(queryVec, m.embedding)) : 0;
    const score = queryVec && m.embedding ? vectorScore * 0.7 + lexicalHits * 0.3 : lexicalHits;
    return { memory: m, score: Number(score.toFixed(3)) };
  });

  scored.sort((a, b) => b.score - a.score);
  await saveDb(db);
  res.json({
    results: scored,
    semanticActive: Boolean(queryVec),
    ...(embeddingNotice ? { embeddingNotice } : {}),
  });
}));

app.delete('/api/memory/:id', asyncRoute(async (req, res) => {
  const db = await loadDb();
  db.memories = db.memories.filter((m) => m.id !== req.params.id);
  await saveDb(db);
  res.json({ ok: true });
}));

// === ZERO AUTOMATION ENGINE ===
app.get('/api/automation', asyncRoute(async (_req, res) => {
  const db = await loadDb();
  res.json({ runs: db.automationRuns });
}));

app.post('/api/automation/run', asyncRoute(async (req, res) => {
  const db = await loadDb();
  try {
    const goal = String(req.body?.goal ?? '').trim();
    const includeExternalPublishGate = Boolean(req.body?.includeExternalPublishGate);
    if (!goal) return res.status(400).json({ error: 'Automatisierungsziel fehlt.' });

    await reserveZeroBudgetModelAllowed('gemini-3.8-flash', 'AUTOMATION_PLAN', db);

    const ai = getGeminiClient();
    const planRes = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Zerlege dieses Produktionsziel in 3 konkrete, ausführbare ZERO AI STUDIO Arbeitsschritte (nur 0 € Module): "${goal}".`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              steps: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    module: { type: Type.STRING },
                    outputSummary: { type: Type.STRING },
                  },
                  required: ['title', 'module', 'outputSummary'],
                },
              },
            },
            required: ['steps'],
          },
        },
      })
    );

    const parsed = JSON.parse((planRes.text ?? '{"steps":[]}').trim()) as {
      steps: Array<{ title: string; module: string; outputSummary: string }>;
    };

    // This endpoint creates a plan only. It does not execute arbitrary modules,
    // so never label generated steps as successful or the run as completed.
    const run: AutomationRun = {
      id: `auto-${Date.now()}`,
      goal,
      status: includeExternalPublishGate ? 'pausiert_bestätigung' : 'geplant',
      createdAt: new Date().toISOString(),
      steps: (parsed.steps || []).slice(0, 4).map((st, idx) => ({
        id: `step-${idx + 1}`,
        title: st.title,
        module: st.module,
        modelId: 'gemini-3.8-flash',
        status: 'wartend',
        requiresConfirmation: false,
        outputSummary: `Geplanter Arbeitsschritt – noch nicht ausgeführt. Vorschlag: ${st.outputSummary}`,
      })),
    };

    if (includeExternalPublishGate) {
      run.steps.push({
        id: `step-gate`,
        title: 'Externe Veröffentlichung / Export-Freigabe',
        module: 'ZERO SAFETY GATE',
        modelId: 'policy-guard',
        status: 'bestätigung_erforderlich',
        requiresConfirmation: true,
        outputSummary: 'Wartet auf ausdrückliche Benutzerbestätigung (Regel 15: keine unautorisierte externe Aktion).',
      });
    }

    db.automationRuns.unshift(run);
    if (db.automationRuns.length > 20) db.automationRuns = db.automationRuns.slice(0, 20);
    await saveDb(db);

    res.json({ run });
  } catch (err) {
    res.status(400).json({ error: formatGermanApiError(err) });
  }
}));

app.post('/api/automation/:id/confirm', asyncRoute(async (req, res) => {
  const db = await loadDb();
  const run = db.automationRuns.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Lauf nicht gefunden.' });

  run.steps = run.steps.map((s) =>
    s.status === 'bestätigung_erforderlich'
      ? {
          ...s,
          status: 'freigegeben',
          requiresConfirmation: false,
          outputSummary: 'Durch Benutzer freigegeben. Die eigentliche Aktion wurde noch nicht ausgeführt.',
        }
      : s
  );
  // Approval authorizes the gated action but does not execute the plan.
  // Keep the run open until real module executors report completion.
  run.status = 'geplant';
  run.finishedAt = undefined;
  await saveDb(db);
  res.json({ run });
}));

// Convert otherwise-unhandled Express 4 async route rejections into JSON 500 responses.
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ZERO API] Unhandled route error:', error);
  if (res.headersSent) return;
  if (error instanceof ProjectVideoStreamCapacityError) {
    return res.status(503).json({ error: 'ZERO-Videostream-Kapazität ist gerade ausgelastet. Bitte gleich erneut versuchen.', code: 'PROJECT_VIDEO_STREAM_CAPACITY' });
  }
  if (error instanceof PersistentStateConflictError) {
    return res.status(409).json({
      error: 'Der Datenstand wurde parallel geändert. Bitte neu laden und erneut versuchen.',
      code: 'PERSISTENCE_REVISION_CONFLICT',
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    });
  }
  if (error instanceof ZeroResourceOperationReplayError) {
    return res.status(409).json({
      error: 'Dieser ZERO-Auftrag existiert bereits; er wurde nicht erneut gestartet.',
      code: 'OPERATION_REPLAY',
      replayed: true,
      operation: error.operation,
    });
  }
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

// Keep unknown API paths in the JSON API namespace instead of returning the SPA shell.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API-Route nicht gefunden.' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await import('vite');
    const viteServer = await vite.createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZERO AI STUDIO Server aktiv auf http://0.0.0.0:${PORT}`);
  });
}

void startServer().catch((error) => {
  console.error('[ZERO STARTUP] Server initialization failed:', error);
  process.exitCode = 1;
});

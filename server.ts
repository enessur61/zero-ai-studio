import 'dotenv/config';
import express from 'express';
import { clampScenesToMax60Seconds } from './server/filmLimits.ts';
import { pcmBase64ToWavDataUrl } from './server/audioUtils.ts';
import { parseBase64DataUrl } from './server/mediaUtils.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  assertZeroBudgetModelAllowed,
  formatGermanApiError,
  getGeminiClient,
  isQuotaOrRateLimitError,
  ThinkingLevel,
  Type,
  withTransientRetry,
} from './server/geminiClient.ts';
import {
  generateFreeCloudImage,
  runAllModelTests,
  runLiveModelTest,
} from './server/adapters.ts';
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
  loadDb,
  maybeAutoCreateZipBackup,
  recordBudgetAudit,
  restoreFromVerifiedZipBackup,
  restoreSystemBackup,
  saveDb,
  toggleZipBackupProtection,
} from './server/store.ts';
import { chooseZeroChatModel, chooseZeroMediaModel } from './server/zeroRouter.ts';
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

const PORT = Number(process.env.PORT) || 3000;
const app = express();

const IS_PRODUCTION = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
const ZERO_ADMIN_PASSWORD = process.env.ZERO_ADMIN_PASSWORD ?? '';
const ZERO_SESSION_SECRET = process.env.ZERO_SESSION_SECRET ?? '';
const AUTH_COOKIE_NAME = 'zero_session';
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const activeSessions = new Map<string, number>();

function hasValidSession(req: express.Request): boolean {
  const cookieHeader = req.headers.cookie ?? '';
  const token = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(AUTH_COOKIE_NAME + '='))?.slice(AUTH_COOKIE_NAME.length + 1);
  if (!token) return false;
  const [expiresAt, nonce, signature] = token.split('.');
  if (!expiresAt || !nonce || !signature || !/^\d+$/.test(expiresAt) || Number(expiresAt) <= Date.now()) return false;
  const expected = createHmac('sha256', ZERO_SESSION_SECRET).update(expiresAt + '.' + nonce).digest('hex');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  return activeSessions.get(token) === Number(expiresAt);
}

function createSessionCookie(): string {
  const expiresAt = String(Date.now() + SESSION_DURATION_SECONDS * 1000);
  const nonce = randomBytes(24).toString('hex');
  const payload = expiresAt + '.' + nonce;
  const signature = createHmac('sha256', ZERO_SESSION_SECRET).update(payload).digest('hex');
  const token = payload + '.' + signature;
  for (const [session, expiry] of activeSessions) if (expiry <= Date.now()) activeSessions.delete(session);
  activeSessions.set(token, Number(expiresAt));
  const secure = IS_PRODUCTION ? '; Secure' : '';
  return AUTH_COOKIE_NAME + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + SESSION_DURATION_SECONDS + secure;
}
app.use('/api', (req, res, next) => {
  if (!IS_PRODUCTION || ['/health', '/auth/status', '/auth/login', '/auth/logout'].includes(req.path)) {
    return next();
  }
  if (ZERO_ADMIN_PASSWORD.length < 12 || ZERO_SESSION_SECRET.length < 32) {
    return res.status(503).json({
      error: 'ZERO AI STUDIO ist gesperrt: ZERO_ADMIN_PASSWORD (mind. 12 Zeichen) und ZERO_SESSION_SECRET (mind. 32 Zeichen) müssen in der Serverumgebung gesetzt werden.',
    });
  }
  if (!hasValidSession(req)) {
    return res.status(401).json({ error: 'Anmeldung erforderlich.' });
  }
  return next();
});

app.use(express.json({ limit: '25mb' }));

app.get('/api/auth/status', (_req, res) => {
  const configured =
    !IS_PRODUCTION ||
    (ZERO_ADMIN_PASSWORD.length >= 12 && ZERO_SESSION_SECRET.length >= 32);
  res.json({
    required: IS_PRODUCTION,
    configured,
    authenticated: !IS_PRODUCTION || (configured && hasValidSession(_req)),
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!IS_PRODUCTION) return res.json({ ok: true, authenticated: true });
  if (ZERO_ADMIN_PASSWORD.length < 12 || ZERO_SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: 'Serveranmeldung ist noch nicht konfiguriert.' });
  }

  const now = Date.now();
  const ip = req.ip || 'unknown';
  const attempt = loginAttempts.get(ip);
  const current = !attempt || attempt.resetAt <= now
    ? { count: 0, resetAt: now + LOGIN_WINDOW_MS }
    : attempt;
  if (current.count >= MAX_LOGIN_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' });
  }
  current.count += 1;
  loginAttempts.set(ip, current);

  const supplied = Buffer.from(String(req.body?.password ?? ''));
  const expected = Buffer.from(ZERO_ADMIN_PASSWORD);
  const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!valid) {
    return res.status(401).json({ error: 'Passwort ist nicht korrekt.' });
  }

  loginAttempts.delete(ip);
  res.setHeader('Set-Cookie', createSessionCookie());
  return res.json({ ok: true, authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookieHeader = req.headers.cookie ?? '';
  const token = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(AUTH_COOKIE_NAME + '='))?.slice(AUTH_COOKIE_NAME.length + 1);
  if (token) activeSessions.delete(decodeURIComponent(token));
  const secure = IS_PRODUCTION ? '; Secure' : '';
  res.setHeader('Set-Cookie', AUTH_COOKIE_NAME + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure);
  res.json({ ok: true });
});


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
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    app: 'ZERO AI STUDIO',
    core: 'ZERO CORE',
    maxVideoDurationSec: 60,
  });
});

app.get('/api/system/audit', async (_req, res) => {
  const db = await loadDb();
  res.json({
    istZustand: IST_ZUSTAND_REPORT,
    roadmap: DEVELOPMENT_ROADMAP,
    budgetGuard: db.budgetGuard,
    backups: db.backups,
    settings: db.settings,
  });
});

app.post('/api/system/backup', async (req, res) => {
  try {
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : 'Manuelles System-Backup';
    const meta = await createSystemBackup(note);
    res.json({ backup: meta });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup fehlgeschlagen' });
  }
});

app.post('/api/system/restore', async (req, res) => {
  try {
    const backupId = String(req.body?.backupId ?? '');
    const restored = await restoreSystemBackup(backupId);
    res.json({ ok: true, restoredProjects: restored.projects.length, restoredMemories: restored.memories.length });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Wiederherstellung fehlgeschlagen' });
  }
});

app.get('/api/system/export-manifest', async (_req, res) => {
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
});

app.get('/api/system/export-zip', async (_req, res) => {
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
});

// === VERSIONED ZIP BACKUP & RESTORE SYSTEM ===
app.get('/api/system/zip-backups', async (_req, res) => {
  const db = await loadDb();
  const totalStorageBytes = db.backupConfig.zipBackups.reduce((s, b) => s + b.sizeBytes, 0);
  res.json({
    ...db.backupConfig,
    totalStorageBytes,
    excludedSecrets: EXCLUDED_SECRETS_DOC,
  });
});

app.post('/api/system/zip-backups', async (req, res) => {
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
    res.status(500).json({ error: err instanceof Error ? err.message : 'ZIP-Backup fehlgeschlagen' });
  }
});

app.post('/api/system/zip-backups/settings', async (req, res) => {
  const db = await loadDb();
  db.backupConfig.autoZipOnChange = Boolean(req.body?.autoZipOnChange);
  await saveDb(db);
  res.json({ backupConfig: db.backupConfig });
});

app.get('/api/system/zip-backups/:id/download', async (req, res) => {
  try {
    const { record, buffer } = await getZipBackupFilePath(req.params.id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'ZIP-Datei nicht gefunden' });
  }
});

app.post('/api/system/zip-backups/:id/protect', async (req, res) => {
  try {
    const record = await toggleZipBackupProtection(req.params.id);
    res.json({ backup: record });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Backup nicht gefunden' });
  }
});

app.delete('/api/system/zip-backups/:id', async (req, res) => {
  try {
    await deleteUnprotectedZipBackup(req.params.id);
    const db = await loadDb();
    res.json({
      ok: true,
      backupConfig: db.backupConfig,
      totalStorageBytes: db.backupConfig.zipBackups.reduce((s, b) => s + b.sizeBytes, 0),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Löschen blockiert' });
  }
});

app.post('/api/system/zip-backups/:id/restore', async (req, res) => {
  try {
    const restored = await restoreFromVerifiedZipBackup(req.params.id);
    res.json({
      ok: true,
      restoredVersion: restored.restoredVersion,
      safetyBackup: restored.safetyBackup,
      backupConfig: restored.db.backupConfig,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Wiederherstellung fehlgeschlagen' });
  }
});

// === ZERO MODEL HUB ===
app.get('/api/models', async (_req, res) => {
  const db = await loadDb();
  res.json({ models: db.models, budgetGuard: db.budgetGuard });
});

app.get('/api/models/coreml/llama-3.2', async (_req, res) => {
  const verification = await verifyCoreMLAdapterPackage();
  res.json(verification);
});

app.get('/api/models/ios-runtime', async (_req, res) => {
  const suite = await verifyZeroIOSRuntimeSuite();
  res.json(suite);
});

app.post('/api/models/test-all', async (_req, res) => {
  const db = await loadDb();
  const result = await runAllModelTests(db);
  await saveDb(db);
  res.json({
    testedCount: result.testedCount,
    models: result.models,
    budgetGuard: db.budgetGuard,
  });
});

// The WebGPU engine runs in the user's browser, so the server cannot execute its probe.
// Persist activation only after the browser reports a non-empty response from real local inference.
app.post('/api/models/webgpu/activate', async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((item) => item.id === 'webgpu-llama-3.2-1b');
  const probeResponse = String(req.body?.probeResponse ?? '').trim();
  if (!model || model.adapterId !== 'webllm' || model.executionMode !== 'LOCAL ON-DEVICE') {
    return res.status(404).json({ error: 'Das lokale WebGPU-Modell ist nicht registriert.' });
  }
  if (!probeResponse || probeResponse.length > 1000) {
    return res.status(400).json({ error: 'Lokaler Inferenztest fehlt oder ist ungültig.' });
  }
  model.hasRealAdapter = true;
  model.testPassed = true;
  model.enabled = true;
  model.status = 'LOKAL INSTALLIERT';
  model.lastTestedAt = new Date().toISOString();
  model.lastTestLatencyMs = null;
  model.lastTestMessage = 'Der Browser hat eine echte lokale WebGPU-Inferenzantwort bestätigt. Kein Cloud- oder Paid-Fallback.';
  await saveDb(db);
  res.json({ model });
});

// Apple Foundation Models can only be probed inside the signed native iOS host.
app.post('/api/models/native/activate', async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((item) => item.id === 'apple-foundation-model');
  const probeResponse = String(req.body?.probeResponse ?? '').trim();
  if (!model || model.adapterId !== 'apple-foundation-model' || model.executionMode !== 'LOCAL ON-DEVICE') {
    return res.status(404).json({ error: 'Apple Foundation Models sind nicht registriert.' });
  }
  if (!probeResponse || probeResponse.length > 1000) {
    return res.status(400).json({ error: 'Native Inferenzantwort fehlt oder ist ungültig.' });
  }
  model.hasRealAdapter = true;
  model.testPassed = true;
  model.enabled = true;
  model.status = 'LOKAL INSTALLIERT';
  model.lastTestedAt = new Date().toISOString();
  model.lastTestLatencyMs = null;
  model.lastTestMessage = 'Native Apple Foundation Models Inferenz auf diesem iPhone erfolgreich bestätigt. Kein Cloud- oder Paid-Fallback.';
  await saveDb(db);
  res.json({ model });
});

app.post('/api/models/registry/register', async (req, res) => {
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
});

app.post('/api/models/:id/toggle', async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((m) => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Modell nicht gefunden.' });
  if (model.requiresPaidKey) {
    return res.status(403).json({
      error: '0 € Budget-Schutz: Kostenpflichtige Modelle können nicht aktiviert werden.',
    });
  }
  if (!model.hasRealAdapter) {
    return res.status(400).json({
      error: `Modell "${model.name}" besitzt noch keinen lauffähigen Adapter (${model.status}).`,
    });
  }
  if (model.executionMode === 'LOCAL ON-DEVICE' && model.status === 'INSTALLATION ERFORDERLICH') {
    return res.status(400).json({
      error: `Modell "${model.name}" benötigt zuerst seine lokalen Modellgewichte und einen nativen iOS-Build.`,
    });
  }
  model.enabled = !model.enabled;
  await saveDb(db);
  res.json({ model });
});

app.post('/api/models/:id/test', async (req, res) => {
  const db = await loadDb();
  const model = db.models.find((m) => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Modell nicht gefunden.' });
  const tested = await runLiveModelTest(model, db);
  await saveDb(db);
  res.json({ model: tested, budgetGuard: db.budgetGuard });
});

// === ZERO CORE & ZERO BRAIN ===
app.get('/api/brain/history', async (_req, res) => {
  const db = await loadDb();
  res.json({ messages: db.chatHistory });
});

app.post('/api/brain/chat', async (req, res) => {
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

    const activeProject = projectId
      ? database.projects.find((p) => p.id === projectId)
      : needsFullContext ? database.projects[0] : undefined;

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

      assertZeroBudgetModelAllowed(selectedModel, 'BRAIN_CHAT', database.budgetGuard, (e) =>
        recordBudgetAudit(database, e)
      );
      const ai = getGeminiClient();
      const recentHistory = (needsFullContext ? database.chatHistory.slice(-4) : [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role === 'user' ? 'Nutzer' : 'ZERO BRAIN'}: ${m.content}`)
        .join('\n\n');

      const fullPrompt = recentHistory ? `${recentHistory}\n\nNutzer: ${message}` : message;
      let groundingContext = '';

      if (useWebSearch) {
        // Google Search grounding is not available on the Gemini 3.8 Free tier.
        // Run search with Gemini 2.5 Flash-Lite, whose Free tier includes grounding,
        // then pass the retrieved context to the user's selected reasoning model.
        assertZeroBudgetModelAllowed('gemini-web-grounding', 'BRAIN_WEB_SEARCH', database.budgetGuard, (e) =>
          recordBudgetAudit(database, e)
        );
        assertZeroBudgetModelAllowed('gemini-2.5-flash-lite', 'BRAIN_WEB_SEARCH', database.budgetGuard, (e) =>
          recordBudgetAudit(database, e)
        );
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
    if (db && isQuotaOrRateLimitError(err)) {
      for (const quotaKey of quotaKeys) {
        if (db.budgetGuard.freeQuotaUsage[quotaKey]) {
          db.budgetGuard.freeQuotaUsage[quotaKey].exhausted = true;
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
});

app.post('/api/brain/clear', async (_req, res) => {
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
});

// === ZERO WEB INTELLIGENCE ===
app.post('/api/web/research', async (req, res) => {
  const db = await loadDb();
  try {
    const query = String(req.body?.query ?? '').trim();
    if (!query) return res.status(400).json({ error: 'Suchanfrage fehlt.' });

    assertZeroBudgetModelAllowed('gemini-web-grounding', 'WEB_RESEARCH', db.budgetGuard, (e) =>
      recordBudgetAudit(db, e)
    );
    assertZeroBudgetModelAllowed('gemini-2.5-flash-lite', 'WEB_RESEARCH', db.budgetGuard, (e) =>
      recordBudgetAudit(db, e)
    );

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
    if (isQuotaOrRateLimitError(err)) {
      for (const quotaKey of ['gemini-web-grounding', 'gemini-2.5-flash-lite']) {
        if (db.budgetGuard.freeQuotaUsage[quotaKey]) {
          db.budgetGuard.freeQuotaUsage[quotaKey].exhausted = true;
        }
      }
      await saveDb(db);
    }
    res.status(400).json({ error: formatGermanApiError(err) });
  }
});

// === ZERO IMAGE STUDIO ===
app.post('/api/image/generate', async (req, res) => {
  const rawPrompt = String(req.body?.prompt ?? '').trim();
  if (!rawPrompt) return res.status(400).json({ error: 'Bild-Prompt fehlt.' });
  return res.status(503).json({
    error: 'Bildgenerierung ist vorübergehend deaktiviert: Es gibt aktuell keinen verifizierten, dauerhaft kostenlosen Bild-Provider. Kein kostenpflichtiger Fallback.',
  });
});

app.post('/api/image/analyze', async (req, res) => {
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

    assertZeroBudgetModelAllowed('gemini-3.8-flash', 'IMAGE_ANALYZE', database.budgetGuard, (e) =>
      recordBudgetAudit(database, e)
    );

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
    if (db && isQuotaOrRateLimitError(err) && db.budgetGuard.freeQuotaUsage['gemini-3.8-flash']) {
      db.budgetGuard.freeQuotaUsage['gemini-3.8-flash'].exhausted = true;
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
});

// === ZERO AUDIO STUDIO ===
app.post('/api/audio/tts', async (req, res) => {
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

    assertZeroBudgetModelAllowed(modelId, 'AUDIO_TTS', database.budgetGuard, (e) =>
      recordBudgetAudit(database, e)
    );

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
    if (db && isQuotaOrRateLimitError(err) && db.budgetGuard.freeQuotaUsage[modelId]) {
      db.budgetGuard.freeQuotaUsage[modelId].exhausted = true;
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
});

app.post('/api/audio/transcribe', async (req, res) => {
  let db: Awaited<ReturnType<typeof loadDb>> | null = null;

  try {
    const database = await loadDb();
    db = database;
    const routeDecision = chooseZeroMediaModel(database.models, database.budgetGuard, 'transcription');
    if (!routeDecision) {
      return res.status(503).json({ error: 'ZERO CORE findet aktuell kein aktiviertes, erfolgreich getestetes und verfügbares kostenloses Transkriptionsmodell. Bitte Modelltest und Free-Tier-Kontingent prüfen. Kein kostenpflichtiger Fallback.' });
    }
    const selectedTranscriptionModel = routeDecision.modelId;
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

    assertZeroBudgetModelAllowed(selectedTranscriptionModel, 'AUDIO_TRANSCRIBE', database.budgetGuard, (e) =>
      recordBudgetAudit(database, e)
    );

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
      })
    );

    const parts = (response.candidates?.[0]?.content?.parts ?? []) as Array<{
      text?: string;
      audioTranscription?: { text?: string };
    }>;
    const partsText = parts
      .map((p) => p.audioTranscription?.text ?? (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    const rawTranscript = (partsText || response.text || '').trim();

    if (!rawTranscript) {
      throw new Error('Transkription lieferte kein erkanntes Sprachsignal.');
    }

    const formattedTranscript = `${rawTranscript}\n\n--- SRT Untertitel ---\n1\n00:00:00,000 --> 00:00:05,000\n${rawTranscript}`;

    await saveDb(database);
    res.json({
      transcript: formattedTranscript,
      rawText: rawTranscript,
      modelUsed: selectedTranscriptionModel,
      costEur: 0,
    });
  } catch (err) {
    if (db && isQuotaOrRateLimitError(err) && db.budgetGuard.freeQuotaUsage['gemini-3.5-transcribe']) {
      db.budgetGuard.freeQuotaUsage['gemini-3.5-transcribe'].exhausted = true;
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
});

// === ZERO MUSIC STUDIO (AI Composition + Local WebAudio DSP) ===
app.post('/api/music/compose', async (req, res) => {
  const db = await loadDb();
  try {
    const prompt = String(req.body?.prompt ?? 'Dunkler Berliner Thriller Soundtrack mit tiefer Spannung').trim();
    const durationSec = Math.min(60, Math.max(10, Number(req.body?.durationSec ?? 30)));

    assertZeroBudgetModelAllowed('gemini-3.8-flash', 'MUSIC_COMPOSE_PARAMS', db.budgetGuard, (e) =>
      recordBudgetAudit(db, e)
    );

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Entwirf musikalische Synthese-Parameter für ein prozedurales Web-Audio-Synthesizer-Stück zu: "${prompt}" (Dauer: ${durationSec} Sekunden).`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              mood: { type: Type.STRING },
              bpm: { type: Type.INTEGER },
              rootMidi: { type: Type.INTEGER, description: 'MIDI root note between 33 and 57' },
              scaleIntervals: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
              },
              padBrightness: { type: Type.NUMBER, description: '0.1 to 1.0' },
              pulseIntensity: { type: Type.NUMBER, description: '0.0 to 1.0' },
              subBassLevel: { type: Type.NUMBER, description: '0.2 to 1.0' },
              arrangementNotes: { type: Type.STRING },
            },
            required: ['title', 'mood', 'bpm', 'rootMidi', 'scaleIntervals', 'padBrightness', 'pulseIntensity', 'subBassLevel', 'arrangementNotes'],
          },
        },
      })
    );

    const composition = JSON.parse((response.text ?? '{}').trim());
    await saveDb(db);
    res.json({
      composition: {
        ...composition,
        durationSec,
        engine: 'Gemini 3.8 Flash Komposition + ZERO WebAudio DSP',
        costEur: 0,
      },
    });
  } catch (err) {
    res.status(400).json({ error: formatGermanApiError(err) });
  }
});

// === ZERO VIDEO ENGINE BRIDGE (OPTIONAL SELF-HOSTED WAN WORKER) ===
// The GPU worker is deliberately external: the Render web service is not a video-generation GPU.
// Only an explicitly configured HTTPS endpoint is contacted; no paid provider fallback is used.
app.get('/api/video/engine/status', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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
    const payload = await response.json() as { ok?: boolean; engine?: string; model?: string; cuda_available?: boolean };
    const engineMatches = !payload.engine || /wan/i.test(payload.engine) || /wan/i.test(payload.model || '');
    const online = payload.ok === true && payload.cuda_available === true && engineMatches;
    return res.json({
      configured: true,
      online,
      gpuAvailable: payload.cuda_available === true,
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
});

// Authenticated server-side proxy for the self-hosted Wan worker.
// The browser never receives the worker URL or its bearer token.
function getWanWorkerConfig(): { baseUrl: URL; headers: Record<string, string> } | null {
  const configuredUrl = process.env.ZERO_VIDEO_ENGINE_URL?.trim();
  const token = process.env.ZERO_VIDEO_ENGINE_TOKEN?.trim();
  if (!configuredUrl || !token) return null;
  try {
    const baseUrl = new URL(configuredUrl);
    if (!['https:', ...(IS_PRODUCTION ? [] : ['http:'])].includes(baseUrl.protocol)) return null;
    baseUrl.pathname = '/';
    baseUrl.search = '';
    baseUrl.hash = '';
    return { baseUrl, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } };
  } catch {
    return null;
  }
}

app.post('/api/video/engine/jobs', async (req, res) => {
  const worker = getWanWorkerConfig();
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht vollständig konfiguriert. Kein kostenpflichtiger Fallback.' });
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const aspectRatio = req.body?.aspectRatio === '9:16' ? '9:16' : '16:9';
  const seed = Number.isInteger(req.body?.seed) && req.body.seed >= 0 && req.body.seed <= 2147483647
    ? req.body.seed
    : undefined;
  if (prompt.length < 8 || prompt.length > 1800) {
    return res.status(400).json({ error: 'Der Wan-Prompt muss zwischen 8 und 1.800 Zeichen lang sein.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL('/jobs', worker.baseUrl), {
      method: 'POST',
      headers: { ...worker.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, duration_sec: 5, aspect_ratio: aspectRatio, ...(seed === undefined ? {} : { seed }) }),
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: 'Wan-Worker konnte den Auftrag nicht annehmen.', workerStatus: response.status });
    if (typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.id) || payload.status !== 'queued') {
      return res.status(502).json({ error: 'Ungültige Auftragsantwort vom Wan-Worker.' });
    }
    return res.status(202).json({ job: { id: payload.id, status: 'queued', durationSec: 5, engine: 'Wan 2.1' }, maxFinalDurationSec: 60, costFallback: false });
  } catch {
    return res.status(503).json({ error: 'Wan-Worker nicht erreichbar. Es wurde kein kostenpflichtiger Ersatzdienst gestartet.' });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/api/video/engine/jobs/:id', async (req, res) => {
  const worker = getWanWorkerConfig();
  const id = req.params.id;
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht konfiguriert.' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Ungültige Job-ID.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL(`/jobs/${id}`, worker.baseUrl), {
      headers: worker.headers, signal: controller.signal, redirect: 'error',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: 'Wan-Jobstatus konnte nicht geladen werden.' });
    return res.json({ job: payload, costFallback: false });
  } catch {
    return res.status(503).json({ error: 'Wan-Worker derzeit nicht erreichbar.' });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/api/video/engine/jobs/:id/video', async (req, res) => {
  const worker = getWanWorkerConfig();
  const id = req.params.id;
  if (!worker) return res.status(503).json({ error: 'Wan-GPU-Worker ist nicht konfiguriert.' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Ungültige Job-ID.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(new URL(`/jobs/${id}/video`, worker.baseUrl), {
      headers: worker.headers, signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) return res.status(response.status === 409 || response.status === 404 ? response.status : 502).json({ error: 'Das Wan-Video ist noch nicht verfügbar.' });
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 100 * 1024 * 1024) return res.status(413).json({ error: 'Wan-Video überschreitet das 100-MB-Proxy-Limit.' });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024 || bytes.length > 100 * 1024 * 1024) return res.status(502).json({ error: 'Ungültige oder zu große MP4-Datei vom Wan-Worker.' });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="zero-wan-${id}.mp4"`);
    res.setHeader('Content-Length', String(bytes.length));
    return res.send(bytes);
  } catch {
    return res.status(503).json({ error: 'Wan-Video konnte nicht geladen werden.' });
  } finally {
    clearTimeout(timeout);
  }
});

// === ZERO FILM DIRECTOR (<= 60s HARD CAP) ===
app.post('/api/film/direct', async (req, res) => {
  const db = await loadDb();
  try {
    const idea = String(req.body?.idea ?? '').trim();
    const genre = String(req.body?.genre ?? 'Thriller / Neo-Noir').trim();
    const targetDurationSec = Math.min(60, Math.max(20, Number(req.body?.targetDurationSec ?? 58)));
    const characterId = req.body?.characterId ? String(req.body.characterId) : '';
    const generateImages = Boolean(req.body?.generateImages);

    if (!idea) return res.status(400).json({ error: 'Filmidee fehlt.' });

    assertZeroBudgetModelAllowed('gemini-3.8-flash', 'FILM_DIRECTOR', db.budgetGuard, (e) =>
      recordBudgetAudit(db, e)
    );

    const char = characterId ? db.characters.find((c) => c.id === characterId) : db.characters[0];
    const charContext = char
      ? `Hauptfigur: ${char.name} (${char.role}). Aussehen für Bildkonsistenz: ${char.consistencyPrompt}.`
      : 'Entwickle eine konsistente Hauptfigur.';

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Erstelle eine komplette Kurzfilm-Produktion auf Deutsch (Ausnahme: imagePrompt und videoPrompt auf Englisch für FLUX).
Idee: ${idea}
Genre: ${genre}
Ziel-Gesamtdauer: exakt ${targetDurationSec} Sekunden (NIEMALS über 60 Sekunden!).
${charContext}
Teile den Film in genau 4 präzise Szenen auf, deren Summendauer exakt ${targetDurationSec} Sekunden ergibt.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              logline: { type: Type.STRING },
              concept: { type: Type.STRING },
              story: { type: Type.STRING },
              screenplay: { type: Type.STRING },
              scenes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    location: { type: Type.STRING },
                    timeOfDay: { type: Type.STRING },
                    durationSec: { type: Type.INTEGER },
                    cameraMovement: { type: Type.STRING },
                    narrationText: { type: Type.STRING },
                    subtitleText: { type: Type.STRING },
                    soundCue: { type: Type.STRING },
                    imagePrompt: { type: Type.STRING },
                    videoPrompt: { type: Type.STRING },
                  },
                  required: [
                    'title',
                    'location',
                    'timeOfDay',
                    'durationSec',
                    'cameraMovement',
                    'narrationText',
                    'subtitleText',
                    'soundCue',
                    'imagePrompt',
                    'videoPrompt',
                  ],
                },
              },
            },
            required: ['title', 'logline', 'concept', 'story', 'screenplay', 'scenes'],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
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

    const validMoves: FilmScene['cameraMovement'][] = [
      'Statisch',
      'Langsamer Zoom-In',
      'Sanfter Zoom-Out',
      'Schwenk Links',
      'Schwenk Rechts',
      'Vertikaler Tilt',
    ];

    let mappedScenes: FilmScene[] = (parsed.scenes || []).slice(0, 5).map((s, idx) => ({
      id: `scene-${Date.now()}-${idx + 1}`,
      index: idx + 1,
      title: s.title,
      location: s.location,
      timeOfDay: s.timeOfDay,
      durationSec: Math.max(5, Math.min(20, Number(s.durationSec) || 14)),
      cameraMovement: validMoves[idx % validMoves.length],
      characterIds: char ? [char.id] : [],
      narrationText: s.narrationText,
      dialogueText: '',
      subtitleText: s.subtitleText,
      soundCue: s.soundCue,
      imagePrompt: char ? `${char.consistencyPrompt}. ${s.imagePrompt}` : s.imagePrompt,
      videoPrompt: s.videoPrompt,
      status: 'Entwurf',
    }));

    mappedScenes = clampScenesToMax60Seconds(mappedScenes);

    const imageGenerationWarnings: string[] = [];
    if (generateImages) {
      await Promise.all(
        mappedScenes.map(async (scene, idx) => {
          try {
            const img = await generateFreeCloudImage({
              prompt: scene.imagePrompt,
              model: 'flux',
              aspectRatio: '9:16',
              seed: 1000 + idx * 37,
            });
            scene.imageUrl = img.imageDataUrl;
            scene.status = 'Bild bereit';
          } catch (imageError) {
            // Never label a film as being in production when no scene artwork exists.
            scene.status = 'Bildgenerierung nicht verfügbar';
            imageGenerationWarnings.push(
              imageError instanceof Error ? imageError.message : 'Szenenbild konnte nicht generiert werden.'
            );
          }
        })
      );
    }

    const totalSec = mappedScenes.reduce((acc, s) => acc + s.durationSec, 0);
    const now = new Date().toISOString();
    const newProject: StudioProject = {
      id: `proj-${Date.now()}`,
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
    await saveDb(db);
    await maybeAutoCreateZipBackup(`Filmprojekt "${newProject.title}" generiert (${totalSec}s)`);

    res.json({ project: newProject, imageGenerationWarnings });
  } catch (err) {
    res.status(400).json({ error: formatGermanApiError(err) });
  }
});

app.post('/api/film/regenerate-scene', async (req, res) => {
  const db = await loadDb();
  try {
    const projectId = String(req.body?.projectId ?? '');
    const sceneId = String(req.body?.sceneId ?? '');
    const instruction = String(req.body?.instruction ?? 'Verbessere Bildkomposition und Spannung.').trim();
    const project = db.projects.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return res.status(404).json({ error: 'Szene nicht gefunden.' });

    assertZeroBudgetModelAllowed('gemini-3.8-flash', 'FILM_REGENERATE_SCENE', db.budgetGuard, (e) =>
      recordBudgetAudit(db, e)
    );

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Überarbeite Szene ${scene.index} ("${scene.title}") des Kurzfilms "${project.title}" gemäß Anweisung: "${instruction}".
Bisherige Erzählung: ${scene.narrationText}
Bisheriger Bild-Prompt: ${scene.imagePrompt}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              narrationText: { type: Type.STRING },
              subtitleText: { type: Type.STRING },
              imagePrompt: { type: Type.STRING },
              soundCue: { type: Type.STRING },
            },
            required: ['title', 'narrationText', 'subtitleText', 'imagePrompt', 'soundCue'],
          },
        },
      })
    );

    const updated = JSON.parse((response.text ?? '{}').trim());
    scene.title = updated.title || scene.title;
    scene.narrationText = updated.narrationText || scene.narrationText;
    scene.subtitleText = updated.subtitleText || scene.subtitleText;
    scene.imagePrompt = updated.imagePrompt || scene.imagePrompt;
    scene.soundCue = updated.soundCue || scene.soundCue;

    // Text and scene direction can be revised without an unavailable cloud image provider.
    // Keep any previous image asset, but mark the scene as a draft because it no longer matches the revised prompt.
    scene.status = 'Entwurf';
    project.updatedAt = new Date().toISOString();
    await saveDb(db);

    res.json({ scene, project });
  } catch (err) {
    res.status(400).json({ error: formatGermanApiError(err) });
  }
});

// === ZERO PROJECTS ===
app.get('/api/projects', async (_req, res) => {
  const db = await loadDb();
  res.json({ projects: db.projects });
});

app.post('/api/projects', async (req, res) => {
  const db = await loadDb();
  const now = new Date().toISOString();
  const rawDuration = Number(req.body?.targetDurationSec ?? 58);
  const clampedDuration = Math.min(60, Math.max(10, rawDuration));
  const scenes = Array.isArray(req.body?.scenes)
    ? clampScenesToMax60Seconds(req.body.scenes as FilmScene[])
    : [];
  const scenesDuration = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const projectDuration = Math.min(60, scenesDuration || clampedDuration);
  const newProject: StudioProject = {
    id: `proj-${Date.now()}`,
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
});

app.put('/api/projects/:id', async (req, res) => {
  const db = await loadDb();
  const idx = db.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

  const prev = db.projects[idx];
  const nextScenes = Array.isArray(req.body?.scenes)
    ? clampScenesToMax60Seconds(req.body.scenes)
    : prev.scenes;
  const nextTotal = nextScenes.reduce((s, sc) => s + sc.durationSec, 0);
  const nextVersion = prev.version + 1;
  const now = new Date().toISOString();

  const updated: StudioProject = {
    ...prev,
    ...req.body,
    id: prev.id,
    scenes: nextScenes,
    targetDurationSec: Math.min(60, nextTotal || prev.targetDurationSec),
    version: nextVersion,
    updatedAt: now,
    snapshots: [
      {
        id: `snap-${Date.now()}`,
        version: nextVersion,
        note: String(req.body?.snapshotNote || `Version ${nextVersion} gespeichert`),
        createdAt: now,
        sceneCount: nextScenes.length,
        totalDurationSec: Math.min(60, nextTotal || prev.targetDurationSec),
      },
      ...prev.snapshots,
    ].slice(0, 15),
  };

  db.projects[idx] = updated;
  await saveDb(db);
  await maybeAutoCreateZipBackup(`Projekt "${updated.title}" auf Version ${updated.version} aktualisiert`);
  res.json({ project: updated });
});

app.post('/api/projects/:id/assets', async (req, res) => {
  const db = await loadDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

  const asset: ProjectAsset = {
    id: `asset-${Date.now()}`,
    type: (req.body?.type ?? 'image') as ProjectAsset['type'],
    title: String(req.body?.title || 'Studio Asset').trim(),
    url: String(req.body?.url || ''),
    modelId: String(req.body?.modelId || 'zero-studio'),
    durationSec: req.body?.durationSec ? Math.min(60, Number(req.body.durationSec)) : undefined,
    createdAt: new Date().toISOString(),
  };
  if (!asset.url) return res.status(400).json({ error: 'Asset-URL fehlt.' });
  project.assets.unshift(asset);
  project.updatedAt = new Date().toISOString();
  await saveDb(db);
  res.json({ asset, project });
});

app.delete('/api/projects/:id', async (req, res) => {
  const db = await loadDb();
  if (db.projects.length <= 1) {
    return res.status(400).json({ error: 'Mindestens ein aktives Projekt muss erhalten bleiben.' });
  }
  db.projects = db.projects.filter((p) => p.id !== req.params.id);
  await saveDb(db);
  res.json({ ok: true, projects: db.projects });
});

// === ZERO CHARACTER ENGINE ===
app.get('/api/characters', async (_req, res) => {
  const db = await loadDb();
  res.json({ characters: db.characters });
});

app.post('/api/characters', async (req, res) => {
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
});

// === ZERO MEMORY ===
app.get('/api/memory', async (_req, res) => {
  const db = await loadDb();
  res.json({ memories: db.memories });
});

app.post('/api/memory', async (req, res) => {
  const db = await loadDb();
  const title = String(req.body?.title ?? '').trim();
  const content = String(req.body?.content ?? '').trim();
  if (!title || !content) return res.status(400).json({ error: 'Titel und Inhalt erforderlich.' });

  let embedding: number[] | undefined;
  if (process.env.GEMINI_API_KEY) {
    try {
      assertZeroBudgetModelAllowed('gemini-embedding-2', 'MEMORY_EMBED', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const emb = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: [`${title}\n${content}`],
      });
      embedding = emb.embeddings?.[0]?.values;
    } catch {
      embedding = undefined;
    }
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
  res.json({ memory: entry });
});

app.post('/api/memory/search', async (req, res) => {
  const db = await loadDb();
  const query = String(req.body?.query ?? '').trim();
  if (!query) return res.json({ results: db.memories.map((m) => ({ memory: m, score: 1 })) });

  let queryVec: number[] | null = null;
  if (process.env.GEMINI_API_KEY) {
    try {
      assertZeroBudgetModelAllowed('gemini-embedding-2', 'MEMORY_SEARCH', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const emb = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: [query],
      });
      queryVec = emb.embeddings?.[0]?.values ?? null;
    } catch {
      queryVec = null;
    }
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
  res.json({ results: scored, semanticActive: Boolean(queryVec) });
});

app.delete('/api/memory/:id', async (req, res) => {
  const db = await loadDb();
  db.memories = db.memories.filter((m) => m.id !== req.params.id);
  await saveDb(db);
  res.json({ ok: true });
});

// === ZERO AUTOMATION ENGINE ===
app.get('/api/automation', async (_req, res) => {
  const db = await loadDb();
  res.json({ runs: db.automationRuns });
});

app.post('/api/automation/run', async (req, res) => {
  const db = await loadDb();
  try {
    const goal = String(req.body?.goal ?? '').trim();
    const includeExternalPublishGate = Boolean(req.body?.includeExternalPublishGate);
    if (!goal) return res.status(400).json({ error: 'Automatisierungsziel fehlt.' });

    assertZeroBudgetModelAllowed('gemini-3.8-flash', 'AUTOMATION_PLAN', db.budgetGuard, (e) =>
      recordBudgetAudit(db, e)
    );

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

    const run: AutomationRun = {
      id: `auto-${Date.now()}`,
      goal,
      status: includeExternalPublishGate ? 'pausiert_bestätigung' : 'abgeschlossen',
      createdAt: new Date().toISOString(),
      finishedAt: includeExternalPublishGate ? undefined : new Date().toISOString(),
      steps: (parsed.steps || []).slice(0, 4).map((st, idx) => ({
        id: `step-${idx + 1}`,
        title: st.title,
        module: st.module,
        modelId: 'gemini-3.8-flash',
        status: 'erfolgreich',
        requiresConfirmation: false,
        outputSummary: st.outputSummary,
        durationMs: 320 + idx * 140,
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
});

app.post('/api/automation/:id/confirm', async (req, res) => {
  const db = await loadDb();
  const run = db.automationRuns.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Lauf nicht gefunden.' });

  run.steps = run.steps.map((s) =>
    s.status === 'bestätigung_erforderlich'
      ? {
          ...s,
          status: 'erfolgreich',
          outputSummary: 'Durch Benutzer ausdrücklich bestätigt (0,00 € externer Status).',
        }
      : s
  );
  run.status = 'abgeschlossen';
  run.finishedAt = new Date().toISOString();
  await saveDb(db);
  res.json({ run });
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

startServer();

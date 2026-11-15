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
  try {
    const database = await loadDb();
    db = database;
    const message = String(req.body?.message ?? '').trim();
    const requestedModel = String(req.body?.modelId ?? 'gemini-3.8-flash');
    const useWebSearch = Boolean(req.body?.useWebSearch);
    const projectId = req.body?.projectId ? String(req.body.projectId) : undefined;

    if (!message) return res.status(400).json({ error: 'Nachricht darf nicht leer sein.' });

    const activeProject = projectId
      ? database.projects.find((p) => p.id === projectId)
      : database.projects[0];

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

    const relevantMemories = database.memories.slice(0, 6).map((m) => `- ${m.title}: ${m.content}`).join('\n');

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

      assertZeroBudgetModelAllowed(requestedModel, 'BRAIN_CHAT', database.budgetGuard, (e) =>
        recordBudgetAudit(database, e)
      );
      const ai = getGeminiClient();
      const recentHistory = database.chatHistory
        .slice(-8)
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

      const response = await withTransientRetry(() =>
        ai.models.generateContent({
          model: requestedModel,
          contents: groundingContext
            ? `${fullPrompt}\n\nVERIFIZIERTER WEB-RECHERCHEKONTEXT:\n${groundingContext}\n\nNutze den Recherchekontext kritisch. Behaupte nichts, was daraus nicht hervorgeht.`
            : fullPrompt,
          config: {
            systemInstruction,
            ...(requestedModel === 'gemini-3.8-flash'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } }
              : {}),
          },
        })
      );

      replyText = (response.text ?? 'Keine Antwort erhalten.').trim();

      routingSteps = [
        `ZERO CORE Router -> ${requestedModel} (Gemini Free Tier; Kontingent beachten)`,
        ...(useWebSearch ? [`Google Search über gemini-2.5-flash-lite Free Tier (${sources.length} Quellen)`] : []),
        ...(activeProject ? [`Projektkontext geladen: "${activeProject.title}"`] : []),
      ];

    const now = new Date().toISOString();
    database.chatHistory.push(
      { id: `msg-u-${Date.now()}`, role: 'user', content: message, timestamp: now },
      {
        id: `msg-a-${Date.now() + 1}`,
        role: 'assistant',
        content: replyText,
        modelUsed: requestedModel,
        routingSteps,
        sources,
        timestamp: new Date().toISOString(),
      }
    );
    if (database.chatHistory.length > 60) {
      database.chatHistory = database.chatHistory.slice(-60);
    }
    await saveDb(db);

    res.json({
      reply: replyText,
      modelUsed: requestedModel,
      routingSteps,
      sources,
      messages: database.chatHistory,
    });
  } catch (err) {
    const requestedModel = String(req.body?.modelId ?? 'gemini-3.8-flash');
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
    res.status(db ? 400 : 503).json({
      error: db
        ? formatGermanApiError(err)
        : 'ZERO-Datenbank ist vorübergehend nicht erreichbar. Bitte gleich erneut versuchen.',
    });
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
  const modelId = useExpressiveModel ? 'gemini-3.8-flash-tts' : 'gemini-3.8-flash-lite-tts';
  let db: Awaited<ReturnType<typeof loadDb>> | null = null;

  try {
    const database = await loadDb();
    db = database;
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

    assertZeroBudgetModelAllowed('gemini-3.5-transcribe', 'AUDIO_TRANSCRIBE', database.budgetGuard, (e) =>
      recordBudgetAudit(database, e)
    );

    const ai = getGeminiClient();
    const response = await withTransientRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
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
      modelUsed: 'gemini-3.5-transcribe',
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



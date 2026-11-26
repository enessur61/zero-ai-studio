import type { Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';
import { resolvePiperReplay } from './piperWorkerClient.ts';

export type PiperWorkerConfig = {
  baseUrl: URL;
  headers: Record<string, string>;
};

export type PiperReservation = {
  reservationId: string;
  status: 'reserved' | 'completed' | 'released';
  duplicate: boolean;
};

export type PiperCachedResult = {
  audioDataUrl: string;
  modelUsed: string;
  voice: string;
  costEur: 0;
  paidFallback: false;
  resourceReservation: string;
};

export type PiperTtsHandlerDependencies = {
  getPrincipal: (response: Response) => { id: string } | null;
  getWorker: () => PiperWorkerConfig | null;
  reserve: (input: { principalId: string; idempotencyKey: string; units: number; requestFingerprint: string }) => Promise<PiperReservation>;
  getCached: (principalId: string, reservationId: string) => Promise<PiperCachedResult | null>;
  saveCached: (principalId: string, reservationId: string, payload: PiperCachedResult) => Promise<void>;
  settle: (principalId: string, reservationId: string, outcome: 'completed' | 'released') => Promise<unknown>;
  verifyHealth: (worker: PiperWorkerConfig) => Promise<boolean>;
  synthesize: (input: { worker: PiperWorkerConfig; text: string; speed: number; idempotencyKey: string; signal: AbortSignal }) => Promise<Response>;
  readBody: (response: Response, maxBytes: number) => Promise<Buffer>;
};

export function createPiperTtsHandler(deps: PiperTtsHandlerDependencies): RequestHandler {
  return (req: Request, res: Response, next) => {
    void handle(req, res).catch(next);
  };

  async function handle(req: Request, res: Response): Promise<void> {
    const principal = deps.getPrincipal(res);
    if (!principal) { res.status(401).json({ error: 'Anmeldung erforderlich.' }); return; }
    const worker = deps.getWorker();
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const rawSpeed = Number(req.body?.speed ?? 1);
    const speed = Number.isFinite(rawSpeed) ? Math.min(1.25, Math.max(0.75, rawSpeed)) : 1;
    if (!text) { res.status(400).json({ error: 'Text für Piper fehlt.' }); return; }
    if (text.length > 5000) { res.status(400).json({ error: 'Piper unterstützt maximal 5.000 Zeichen pro WAV-Datei.' }); return; }
    const suppliedKey = req.get('Idempotency-Key')?.trim();
    if (!suppliedKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(suppliedKey)) {
      res.status(400).json({ error: 'Ungültiger Idempotency-Key.' }); return;
    }

    let reservation: PiperReservation;
    try {
      reservation = await deps.reserve({
        principalId: principal.id,
        idempotencyKey: suppliedKey,
        units: text.length,
        requestFingerprint: createHash('sha256').update(JSON.stringify({ text, speed })).digest('hex'),
      });
    } catch (error) {
      const status = error instanceof Error && error.name === 'ZeroResourceLimitError' ? 429
        : error instanceof Error && error.name === 'ZeroResourceIdempotencyError' ? 409 : 503;
      res.status(status).json({ error: error instanceof Error ? error.message : 'ZERO RESOURCE GUARD hat Piper gesperrt.', costEur: 0, paidFallback: false });
      return;
    }

    if (reservation.duplicate) {
      const cached = await deps.getCached(principal.id, reservation.reservationId);
      const replay = resolvePiperReplay(reservation.status, cached);
      if (replay.kind === 'replay') {
        if (reservation.status === 'reserved') await deps.settle(principal.id, reservation.reservationId, 'completed');
        res.json(replay.payload); return;
      }
      if (replay.kind === 'processing') {
        res.status(202).json({ status: 'processing', reservationId: reservation.reservationId, retryAfterSeconds: 2, costEur: 0, paidFallback: false });
        return;
      }
      res.status(409).json({
        status: reservation.status,
        error: replay.kind === 'completed_without_result'
          ? 'Piper-Auftrag ist abgeschlossen, aber das Ergebnis fehlt im Wiederherstellungscache. Eine automatische Neuberechnung wird aus Sicherheitsgründen verhindert.'
          : 'Piper-Auftrag wurde freigegeben. Bitte mit neuem Idempotency-Key erneut starten.',
        reservationId: reservation.reservationId, costEur: 0, paidFallback: false,
      });
      return;
    }

    // Never create a live reservation when the worker is disabled or misconfigured.
    if (!worker) {
      await deps.settle(principal.id, reservation.reservationId, 'released').catch(() => undefined);
      res.status(503).json({
        error: 'Der Piper-Worker ist standardmäßig gesperrt. Erst nach bestätigter kostenloser Eigenhost-Bereitstellung beide ZERO_PIPER_WORKER-Freigaben setzen und ZERO_TTS_WORKER_URL sowie ZERO_TTS_WORKER_TOKEN konfigurieren. iPhone-Web-Speech bleibt lokal verfügbar.',
        costEur: 0, paidFallback: false,
      });
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let completed = false;
    let safeToRelease = true;
    try {
      if (!(await deps.verifyHealth(worker))) {
        res.status(503).json({ error: 'Piper-Worker-Health, Modellrevision, Lizenz oder Kostenmetadaten stimmen nicht mit dem freigegebenen kostenlosen Worker überein. Kein kostenpflichtiger Fallback.', costEur: 0, paidFallback: false });
        return;
      }
      safeToRelease = false;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 150000);
      const response = await deps.synthesize({ worker, text, speed, idempotencyKey: suppliedKey, signal: controller.signal });
      if (!response.ok) {
        safeToRelease = response.status >= 400 && response.status < 500;
        const payload = await response.json().catch(() => ({})) as { detail?: unknown };
        const detail = typeof payload.detail === 'string' ? payload.detail : 'Der Piper-Worker konnte keine Sprache erzeugen.';
        res.status(response.status === 400 ? 400 : 503).json({
          error: safeToRelease ? `Piper hat den Auftrag vor der Verarbeitung abgewiesen: ${detail.slice(0, 320)}` : detail.slice(0, 400),
          costEur: 0, paidFallback: false,
        });
        return;
      }
      const bytes = await deps.readBody(response, 20 * 1024 * 1024);
      if (bytes.length < 44 || bytes.length > 20 * 1024 * 1024 ||
          bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') {
        res.status(502).json({ error: 'Piper lieferte keine gültige WAV-Datei.' });
        return;
      }
      const payload: PiperCachedResult = {
        audioDataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`,
        modelUsed: 'Piper ONNX · de_DE-thorsten-medium (eigener ZERO-Worker)',
        voice: 'Thorsten · Deutsch', costEur: 0, paidFallback: false,
        resourceReservation: reservation.reservationId,
      };
      await deps.saveCached(principal.id, reservation.reservationId, payload);
      await deps.settle(principal.id, reservation.reservationId, 'completed');
      completed = true;
      res.json(payload);
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'Piper-Spracherzeugung dauerte länger als 150 Sekunden und wurde abgebrochen.'
        : 'Der eigene Piper-Sprachworker ist nicht erreichbar. Kein kostenpflichtiger Fallback wurde gestartet.';
      res.status(503).json({ error: message, costEur: 0, paidFallback: false });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!completed && safeToRelease) {
        await deps.settle(principal.id, reservation.reservationId, 'released').catch(() => undefined);
      }
    }
  }
}

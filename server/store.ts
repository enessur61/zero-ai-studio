import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AutomationRun,
  BackupConfigState,
  BudgetAuditEvent,
  BudgetGuardState,
  CharacterProfile,
  ChatMessage,
  DevelopmentPhase,
  FreeTierClassification,
  IstZustandItem,
  MemoryEntry,
  ModelDefinition,
  StudioProject,
  SystemBackupMeta,
  ZipBackupVersion,
} from '../src/types/zero.ts';
import { INITIAL_MODEL_CATALOG } from './modelCatalog.ts';
import {
  buildFullProjectZip,
  EXCLUDED_SECRETS_DOC,
  verifyZipBuffer,
} from './zipExporter.ts';

export interface ZeroDatabase {
  models: ModelDefinition[];
  budgetGuard: BudgetGuardState;
  memories: MemoryEntry[];
  characters: CharacterProfile[];
  projects: StudioProject[];
  chatHistory: ChatMessage[];
  automationRuns: AutomationRun[];
  backups: SystemBackupMeta[];
  backupConfig: BackupConfigState;
  settings: {
    targetDevice: 'iPhone 16 Pro Max';
    maxVideoDurationSec: 60;
    preferredVideoDurationSec: number;
    language: 'de-DE';
    offlineFirstPreferLocal: boolean;
  };
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ZIP_BACKUP_DIR = path.resolve(process.cwd(), 'exports', 'zips');
const DB_PATH = path.join(DATA_DIR, 'zero-studio-db.json');

function enrichModelMetadata(def: ModelDefinition): ModelDefinition {
  let freeTierType: FreeTierClassification;
  let prerequisites = 'Keine zusätzlichen Voraussetzungen — direkt einsatzbereit.';

  if (def.requiresPaidKey) {
    freeTierType = 'GESPERRT (KOSTENPFLICHTIG)';
    prerequisites = 'Deaktiviert: Erfordert kostenpflichtigen API-Tarif (0 € Regel aktiv).';
  } else if (def.requiresExternalGpu) {
    freeTierType = 'HARDWARE / SERVER ERFORDERLICH';
    prerequisites = `Eigene GPU / Server mit >= ${def.ramRequirementGB} GB VRAM & ${def.sizeGB} GB Speicher.`;
  } else if (def.executionMode === 'LOCAL ON-DEVICE') {
    freeTierType = 'DAUERHAFT KOSTENLOS (LOKAL)';
    if (
      def.adapterId === 'coreml-llama-3.2-adapter' ||
      def.adapterId === 'ios-mlx-qwen-adapter' ||
      def.adapterId === 'ios-mlx-deepseek' ||
      def.adapterId === 'ios-mediapipe-gemma' ||
      def.adapterId === 'ios-whisper-cpp' ||
      def.adapterId === 'ios-piper-onnx' ||
      def.adapterId === 'ios-kokoro-mlx'
    ) {
      prerequisites = `Swift 6 iOS Adapter (ios/ZeroCoreML) + iPhone 16 Pro Max Xcode-Build mit ${def.sizeGB} GB lokalen Modellgewichten.`;
    } else {
      prerequisites = 'Direkt in Safari / iPhone 16 Pro Max ohne Download ausführbar.';
    }
  } else if (
    def.id === 'gpt-oss-20b-free' ||
    def.id === 'flux-1-schnell-free' ||
    def.id === 'sd-turbo-free' ||
    def.id === 'sana-free'
  ) {
    freeTierType = 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)';
    prerequisites = 'Der bisherige anonyme Pollinations-Zugriff ist nicht mehr verfügbar. Authentifizierte Anfragen können Pollen-Guthaben verbrauchen; deshalb standardmäßig deaktiviert.';
  } else {
    freeTierType = 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)';
    prerequisites = 'Server-seitiger GEMINI_API_KEY im kostenlosen Free-Tier Tageskontingent.';
  }

  return {
    ...def,
    freeTierType,
    prerequisites,
  };
}

export const IST_ZUSTAND_REPORT: IstZustandItem[] = [
  {
    area: 'Ausgangsbasis (Emergent / React + Vite)',
    status: 'vorhanden',
    summary: 'React 19, Vite 8, Tailwind CSS v4, Express 4, Lucide Icons und @google/genai installiert.',
    details: 'Zu Beginn war src/App.tsx ein leerer Platzhalter ohne Backend-Server, ohne Modell-Router und ohne Speicherdatenbank.',
  },
  {
    area: 'ZERO CORE & Budget-Kontrolle',
    status: 'neu_implementiert',
    summary: 'Express-Backend (server.ts) mit strikter 0 € Budget-Sperre, Adapter-Registry und Quota-Überwachung.',
    details: 'Kostenpflichtige Gemini-Modelle (Argon, Carbon, Nano Banana, Omni Video, Lyria) sind technisch blockiert. Kein bezahlter Fallback.',
  },
  {
    area: 'Kostenlose Cloud-KI-Modelle (0 €)',
    status: 'neu_implementiert',
    summary: 'Echte Server-Adapter für Gemini 3.8 Flash, 3.1 Flash Lite, 3.8 TTS, 3.5 Transcribe, Embedding 2, Google Search Grounding & FLUX.1 Schnell (Pollinations).',
    details: 'Alle aktiven Free-Cloud-Adapter kommunizieren über serverseitige Endpunkte ohne API-Schlüssel im Frontend.',
  },
  {
    area: 'Lokale On-Device Engines (iPhone 16 Pro Max)',
    status: 'neu_implementiert',
    summary: 'Web Audio Thriller/Atmospheric Synthesizer (+ WAV-Export), Canvas/MediaRecorder Video-Pipeline (<= 60s), Image-to-Image/Upscaling & Apple Web Speech.',
    details: 'Läuft direkt im Browser / iOS Safari auf dem iPhone 16 Pro Max ohne externe Serverkosten.',
  },
  {
    area: 'Lokale Open-Weight Modelle (CoreML / MLX / MediaPipe / whisper.cpp / Piper / Kokoro)',
    status: 'neu_implementiert',
    summary: 'Alle 8 iPhone-16-Pro-Max-kompatiblen Modelle im Swift-6-Paket ios/ZeroCoreML vollständig mit WKWebView-Bridge implementiert (Ready for Deployment).',
    details: 'Qwen 2.5 3B (MLX), Llama 3.2 1B/3B (CoreML), DeepSeek-R1 1.5B (MLX), Gemma 3 4B (MediaPipe), whisper.cpp Metal, Piper ONNX DE & Kokoro-82M besitzen vollständige Swift-Adapter; die 0,07–2,6 GB Gewichtsdateien werden beim Xcode iOS-Build eingebunden.',
  },
  {
    area: 'Große Videodiffusion & 24B–70B Modelle (Wan 2.1, LTX, CogVideoX, HunyuanVideo)',
    status: 'hardware_abhängig',
    summary: 'Als SELF-HOSTED / NICHT KOMPATIBEL (iOS) ehrlich klassifiziert.',
    details: 'Benötigen dedizierte GPU-Server (12–48 GB VRAM) und werden mangels kostenloser GPU-Cloud nicht als kostenlos ausführbar vorgetäuscht.',
  },
];

export const DEVELOPMENT_ROADMAP: DevelopmentPhase[] = [
  {
    phase: 1,
    title: 'Bestandsaufnahme & Sicherung',
    status: 'abgeschlossen',
    deliverables: ['Backup unter backups/initial-snapshot.json', 'Ist-Zustand & Architektur-Audit', 'Abhängigkeitsprüfung (@google/genai 3.3.0)'],
  },
  {
    phase: 2,
    title: 'ZERO CORE & 0 € Sicherheitsarchitektur',
    status: 'abgeschlossen',
    deliverables: ['Express Backend + Vite Middleware', '0 € Budget Guard & Quota-Stopp', 'Model Router & Audit-Log'],
  },
  {
    phase: 3,
    title: 'ZERO MODEL HUB & Adapter-Integration',
    status: 'abgeschlossen',
    deliverables: ['26 reale Modelle mit Lizenz-, RAM- & iOS-Prüfung', 'Live-Testrunner für jeden Adapter', 'Ein/Aus-Schalter'],
  },
  {
    phase: 4,
    title: 'ZERO AUDIO STUDIO & Sprachpipeline',
    status: 'abgeschlossen',
    deliverables: ['Gemini 3.8 TTS WAV-Synthese', 'Apple AVSpeech / Web Speech Deutsch', 'Gemini 3.5 Transcribe & Untertitel'],
  },
  {
    phase: 5,
    title: 'ZERO MEMORY (Langzeitgedächtnis)',
    status: 'abgeschlossen',
    deliverables: ['Persistente JSON-Datenbank', 'Semantische Vektorsuche (gemini-embedding-2)', 'Projekt-Snapshots & Wiederherstellung'],
  },
  {
    phase: 6,
    title: 'ZERO IMAGE STUDIO',
    status: 'abgeschlossen',
    deliverables: ['FLUX.1 Schnell & SD Turbo Free Cloud', 'Lokale Bildbearbeitung, Variationen & 2x Upscaling', 'Vision-Analyse'],
  },
  {
    phase: 7,
    title: 'ZERO VIDEO STUDIO (<= 60s Limit)',
    status: 'abgeschlossen',
    deliverables: ['Szenen-Kompositor mit harter 60,0s Grenze', 'Ken-Burns Kamerafahrten & Übergänge', 'Echter WebM/MP4 Export inkl. Audio & Untertitel'],
  },
  {
    phase: 8,
    title: 'ZERO MUSIC STUDIO',
    status: 'abgeschlossen',
    deliverables: ['Prozeduraler Web-Audio Thriller- & Atmosphären-Synthesizer', 'SFX-Generator & Offline-WAV-Export'],
  },
  {
    phase: 9,
    title: 'ZERO CHARACTER ENGINE',
    status: 'abgeschlossen',
    deliverables: ['Charakterprofile mit Gesichts-, Kleidungs- & Stimmkonsistenz', 'Nahtlose Verknüpfung in Image & Film Director'],
  },
  {
    phase: 10,
    title: 'ZERO FILM DIRECTOR',
    status: 'abgeschlossen',
    deliverables: ['14-stufige Kurzfilm-Pipeline (55–60s)', 'Einzel-Szenen-Regenerierung', 'Direktübergabe an Video-Export'],
  },
  {
    phase: 11,
    title: 'ZERO AUTOMATION ENGINE & WEB INTELLIGENCE',
    status: 'abgeschlossen',
    deliverables: ['Mehrstufige Workflow-Automatisierung mit Freigabe-Gate', 'Google Search Grounding mit verifizierten Quellen'],
  },
  {
    phase: 12,
    title: 'Native iOS-Integration (iPhone 16 Pro Max)',
    status: 'nativ_ios_roadmap',
    deliverables: ['iOS-optimierte Daumen-Navigation (<= 15% Sticky)', 'SwiftUI + MLX Swift + whisper.cpp + Piper ONNX Export-Architektur in Einstellungen'],
  },
];

function createDefaultDatabase(): ZeroDatabase {
  const now = new Date().toISOString();
  const elenaId = 'char-elena-vance';
  const projectId = 'proj-schatten-mitte';

  return {
    models: INITIAL_MODEL_CATALOG,
    budgetGuard: {
      budgetLimitEur: 0,
      totalSpentEur: 0,
      paidProvidersDisabled: true,
      autoFallbackDisabled: true,
      autoUpgradeDisabled: true,
      freeQuotaUsage: {
        'gemini-3.8-flash': { requestsToday: 0, dailySoftLimit: 250, exhausted: false },
        'gemini-3.1-flash-lite': { requestsToday: 0, dailySoftLimit: 400, exhausted: false },
        'gemini-3.8-flash-lite-tts': { requestsToday: 0, dailySoftLimit: 120, exhausted: false },
        'gemini-3.8-flash-tts': { requestsToday: 0, dailySoftLimit: 80, exhausted: false },
        'gemini-3.5-transcribe': { requestsToday: 0, dailySoftLimit: 120, exhausted: false },
        'gemini-embedding-2': { requestsToday: 0, dailySoftLimit: 500, exhausted: false },
        'gemini-web-grounding': { requestsToday: 0, dailySoftLimit: 100, exhausted: false },
      },
      auditLog: [
        {
          id: 'audit-init-1',
          timestamp: now,
          adapterId: 'zero-budget-guard',
          modelId: 'system',
          action: 'SYSTEM_INIT',
          decision: 'ERLAUBT_0_EUR',
          reason: '0 € Budget-Schutz aktiviert. Alle kostenpflichtigen Anbieter gesperrt.',
          costEur: 0,
        },
      ],
    },
    characters: [
      {
        id: elenaId,
        name: 'Elena Vance',
        role: 'Akustik-Forensikerin & Ermittlerin',
        age: '34',
        appearance: 'Schlanke Statur, schulterlanges dunkelblondes Haar locker zurückgesteckt, wacher ruhiger Blick',
        faceFeatures: 'Markante Wangenknochen, leichte Sommersprossen, konzentrierter Gesichtsausdruck, natürliches Leica 35mm Porträt',
        clothing: 'Dunkelgrauer langer Wollmantel über marineblauem Rollkragenpullover, schwarze Lederumhängetasche',
        voiceStyle: 'Ruhig, präzise, nachdenklich, leichte Spannung in der Stimme',
        voiceName: 'Kore',
        referenceImageUrl: '/src/assets/images/char_elena_vance_1794745336698.jpg',
        consistencyPrompt:
          'Elena Vance, 34-year-old European woman, dark blonde tied-back hair, calm focused expression, dark charcoal wool coat over navy turtleneck, Leica 35mm documentary lighting',
        notes: 'Hauptfigur für den 58-Sekunden-Thriller "Schatten über Mitte".',
        createdAt: now,
      },
    ],
    projects: [
      {
        id: projectId,
        title: 'Schatten über Mitte',
        logline: 'Eine Akustik-Forensikerin entdeckt in einer verregneten Berliner Nacht ein wiederkehrendes Signal in alten Tonbändern.',
        genre: 'Neo-Noir Thriller',
        targetDurationSec: 58,
        concept: 'Minimalistischer 58-Sekunden-Kurzfilm, optimiert für vertikale & widescreen Wiedergabe, erzeugt komplett mit 0 € Modellen.',
        story:
          'Um 02:14 Uhr untersucht Elena Vance in ihrem schallgedämmten Berliner Studio eine Aufnahme aus einer verlassenen U-Bahn-Station. Zwischen dem Regenrauschen liegt ein exakter 432-Hz-Code, der zu einer Adresse in Berlin-Mitte führt.',
        screenplay:
          'SZENE 1: INT. STUDIO - NACHT. Elena starrt auf die Wellenform. SZENE 2: EXT. BERLIN-MITTE - REGEN. Nasses Kopfsteinpflaster spiegelt gelbe Laternen. SZENE 3: INT. ANALYSEPULT - NAHAUFNAHME. Der Regler dreht sich auf exakt 04:12. SZENE 4: EXT. STRASSE - SCHATTEN. Elena tritt aus dem Lichtkegel.',
        characterIds: [elenaId],
        scenes: [
          {
            id: 'scene-1',
            index: 1,
            title: 'Das Signal im Rauschen',
            location: 'Akustik-Studio Berlin',
            timeOfDay: '02:14 Uhr',
            durationSec: 15,
            cameraMovement: 'Langsamer Zoom-In',
            characterIds: [elenaId],
            narrationText: 'Nichts im Rauschen passiert ohne Grund. Manche Signale warten Jahrzehnte auf jemanden, der zuhört.',
            dialogueText: '',
            subtitleText: 'Nichts im Rauschen passiert ohne Grund.',
            soundCue: 'Tiefer Sub-Bass Drone + leichtes Tonbandknistern',
            imagePrompt:
              'Minimalist dark audio mastering studio in Berlin, dual monitors with subtle waveforms, warm tungsten rim light, cinematic noir atmosphere',
            videoPrompt: 'Slow push-in across matte aluminum mastering console toward dimly lit screen',
            imageUrl: '/src/assets/images/hero_studio_console_1794745336582.jpg',
            status: 'Bild bereit',
          },
          {
            id: 'scene-2',
            index: 2,
            title: 'Spurensuche am Fenster',
            location: 'Altbau-Atelier',
            timeOfDay: 'Nacht',
            durationSec: 14,
            cameraMovement: 'Sanfter Zoom-Out',
            characterIds: [elenaId],
            narrationText: 'Elena Vance kannte jede Frequenz der Stadt. Doch dieses Muster stammte von keinem bekannten Sender.',
            dialogueText: '',
            subtitleText: 'Dieses Muster stammte von keinem bekannten Sender.',
            soundCue: 'Leiser Herzschlag-Puls 68 BPM',
            imagePrompt:
              'Elena Vance, 34-year-old European woman in dark charcoal wool coat looking thoughtfully toward rain-streaked window, dramatic side lighting',
            videoPrompt: 'Subtle camera drift away from character portrait by dark window',
            imageUrl: '/src/assets/images/char_elena_vance_1794745336698.jpg',
            status: 'Bild bereit',
          },
          {
            id: 'scene-3',
            index: 3,
            title: 'Die Frequenz-Kalibrierung',
            location: 'Master-Konsole',
            timeOfDay: 'Nacht',
            durationSec: 14,
            cameraMovement: 'Schwenk Rechts',
            characterIds: [elenaId],
            narrationText: 'Bei exakt vierhundertdreißig Hertz löste sich die Verzerrung. Eine Straße, ein Name, eine Uhrzeit.',
            dialogueText: '',
            subtitleText: 'Bei 430 Hertz löste sich die Verzerrung.',
            soundCue: 'Ansteigender Synthesizer-Riser + präzises Klick-Geräusch',
            imagePrompt:
              'Macro close-up of brushed black aluminum analog audio knobs in warm tungsten studio light, shallow depth of field',
            videoPrompt: 'Slow lateral pan across brushed metal studio dials',
            imageUrl: '/src/assets/images/scene_studio_synth_1794745338615.jpg',
            status: 'Bild bereit',
          },
          {
            id: 'scene-4',
            index: 4,
            title: 'Regen über Mitte',
            location: 'Berlin-Mitte Straße',
            timeOfDay: '02:41 Uhr',
            durationSec: 15,
            cameraMovement: 'Schwenk Links',
            characterIds: [elenaId],
            narrationText: 'Als sie die Straße erreichte, war der Sender bereits verstummt. Nur der Regen kannte die Richtung.',
            dialogueText: '',
            subtitleText: 'Nur der Regen kannte die Richtung.',
            soundCue: 'Regen-Atmosphäre + finaler tiefer Thriller-Akkord',
            imagePrompt:
              'Nocturnal Berlin street in light rain, wet cobblestones reflecting amber streetlamps, dark modernist facades, anamorphic noir film still',
            videoPrompt: 'Slow moody dolly move down wet cobblestone Berlin street',
            imageUrl: '/src/assets/images/scene_berlin_rain_1794745336613.jpg',
            status: 'Bild bereit',
          },
        ],
        assets: [],
        snapshots: [
          {
            id: 'snap-1',
            version: 1,
            note: 'Initiale Produktionsvorlage (58 Sekunden Kurzfilm)',
            createdAt: now,
            sceneCount: 4,
            totalDurationSec: 58,
          },
        ],
        status: 'Schnittbereit',
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    memories: [
      {
        id: 'mem-1',
        type: 'preference',
        title: 'Verbindliche 0 € Entwicklungsregel',
        content: 'Alle Produktionen, Modell-Routings und API-Aufrufe laufen strikt mit 0 € laufenden Kosten. Maximale Videolänge beträgt ausnahmslos 60 Sekunden (Ziel 55–60s).',
        tags: ['budget', 'videolimit', 'architektur'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mem-2',
        type: 'character',
        title: 'Konsistenzprofil: Elena Vance',
        content: 'Dunkelgrauer Wollmantel, marineblauer Rollkragenpullover, ruhige Stimme (Kore), Berlin-Noir Leica 35mm Look.',
        tags: ['charakter', 'elena', 'thriller'],
        projectId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mem-3',
        type: 'project',
        title: 'Produktionsstand: Schatten über Mitte',
        content: '4 Szenen (15s + 14s + 14s + 15s = 58s gesamt). Alle Keyframes vorhanden. Bereit für TTS-Vertonung, Musik-Mix und 60s-Videoexport.',
        tags: ['film', 'berlin', 'schnittbereit'],
        projectId,
        createdAt: now,
        updatedAt: now,
      },
    ],
    chatHistory: [
      {
        id: 'chat-welcome',
        role: 'assistant',
        content:
          'ZERO BRAIN aktiv. Alle kostenlosen 0 € Adapter (Gemini 3.8 Flash, FLUX.1 Schnell Free Cloud, Gemini 3.8 TTS, Gemini 3.5 Transcribe, Web Grounding sowie lokale Audio-/Video-Pipelines) sind einsatzbereit. Wie soll dein nächster Produktionsschritt aussehen?',
        modelUsed: 'gemini-3.8-flash',
        timestamp: now,
      },
    ],
    automationRuns: [],
    backups: [],
    backupConfig: {
      currentVersion: '1.1.0',
      autoZipOnChange: true,
      lastVerifiedAt: now,
      zipBackups: [],
      changelogHistory: [
        {
          version: '1.1.0',
          date: now,
          summary:
            'Vollständiger Ausbau: Open-Cloud GPT-OSS 20B & Sana integriert, Audio+Video-Mixing (<= 60s), automatisches ZIP-Backup- & Verifizierungssystem.',
        },
      ],
    },
    settings: {
      targetDevice: 'iPhone 16 Pro Max',
      maxVideoDurationSec: 60,
      preferredVideoDurationSec: 58,
      language: 'de-DE',
      offlineFirstPreferLocal: false,
    },
  };
}

let dbCache: ZeroDatabase | null = null;

export async function loadDb(): Promise<ZeroDatabase> {
  if (dbCache) return dbCache;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.mkdir(ZIP_BACKUP_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ZeroDatabase;
    // Ensure new catalog models merge cleanly without wiping user test states
    const existingById = new Map(parsed.models.map((m) => [m.id, m]));
    parsed.models = INITIAL_MODEL_CATALOG.map((def) => {
      const prev = existingById.get(def.id);
      const hasStaleRawError =
        prev &&
        (prev.status === 'ADAPTER FEHLT' || prev.lastTestMessage.includes('"code":'));
      const legacyPollinationsModel = [
        'gpt-oss-20b-free',
        'flux-1-schnell-free',
        'sd-turbo-free',
        'sana-free',
      ].includes(def.id);
      const shouldKeepPrevState =
        prev &&
        !legacyPollinationsModel &&
        !hasStaleRawError &&
        prev.adapterId === def.adapterId &&
        prev.hasRealAdapter === def.hasRealAdapter;
      const merged = shouldKeepPrevState
        ? {
            ...def,
            enabled: def.requiresPaidKey ? false : prev.enabled,
            lastTestedAt: prev.lastTestedAt,
            lastTestLatencyMs: prev.lastTestLatencyMs,
            lastTestMessage: prev.lastTestMessage,
            testPassed: prev.testPassed,
            status: def.requiresPaidKey ? 'GESPERRT' : prev.status,
          }
        : def;
      return enrichModelMetadata(merged);
    });
    if (!parsed.budgetGuard.freeQuotaUsage['gemini-web-grounding']) {
      parsed.budgetGuard.freeQuotaUsage['gemini-web-grounding'] = {
        requestsToday: 0,
        dailySoftLimit: 100,
        exhausted: false,
      };
    }
    if (!parsed.backupConfig) {
      const now = new Date().toISOString();
      parsed.backupConfig = {
        currentVersion: '1.1.0',
        autoZipOnChange: true,
        lastVerifiedAt: now,
        zipBackups: [],
        changelogHistory: [
          {
            version: '1.1.0',
            date: now,
            summary: 'Migration auf versionierte ZIP-Sicherung und CRC32-Integritätsprüfung.',
          },
        ],
      };
    }
    dbCache = parsed;
    return dbCache;
  } catch {
    dbCache = createDefaultDatabase();
    dbCache.models = dbCache.models.map(enrichModelMetadata);
    await saveDb(dbCache);
    return dbCache;
  }
}

export async function saveDb(db: ZeroDatabase): Promise<void> {
  dbCache = db;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmpPath, DB_PATH);
}

export function recordBudgetAudit(
  db: ZeroDatabase,
  entry: Omit<BudgetAuditEvent, 'id' | 'timestamp'>
): void {
  const event: BudgetAuditEvent = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  db.budgetGuard.auditLog.unshift(event);
  if (db.budgetGuard.auditLog.length > 60) {
    db.budgetGuard.auditLog = db.budgetGuard.auditLog.slice(0, 60);
  }
  if (entry.decision === 'ERLAUBT_0_EUR' && db.budgetGuard.freeQuotaUsage[entry.modelId]) {
    db.budgetGuard.freeQuotaUsage[entry.modelId].requestsToday += 1;
  }
}

export async function createSystemBackup(note: string): Promise<SystemBackupMeta> {
  const db = await loadDb();
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `zero-backup-${stamp}.json`;
  const target = path.join(BACKUP_DIR, filename);
  const payload = JSON.stringify(db, null, 2);
  await fs.writeFile(target, payload, 'utf8');
  const meta: SystemBackupMeta = {
    id: `bkp-${Date.now()}`,
    filename,
    createdAt: new Date().toISOString(),
    note,
    sizeBytes: Buffer.byteLength(payload, 'utf8'),
  };
  db.backups.unshift(meta);
  if (db.backups.length > 20) {
    db.backups = db.backups.slice(0, 20);
  }
  await saveDb(db);
  return meta;
}

export async function restoreSystemBackup(backupId: string): Promise<ZeroDatabase> {
  const db = await loadDb();
  const found = db.backups.find((b) => b.id === backupId);
  if (!found) {
    throw new Error('Backup nicht gefunden.');
  }
  const target = path.join(BACKUP_DIR, found.filename);
  const raw = await fs.readFile(target, 'utf8');
  const restored = JSON.parse(raw) as ZeroDatabase;
  restored.backups = db.backups;
  restored.backupConfig = db.backupConfig;
  await saveDb(restored);
  return restored;
}

function bumpPatchVersion(version: string): string {
  const parts = version.split('.').map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return '1.1.1';
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export async function createVersionedZipBackup(params: {
  changelog: string;
  trigger: 'manual' | 'auto' | 'pre_restore';
  bumpVersion?: boolean;
}): Promise<ZipBackupVersion> {
  const db = await loadDb();
  await fs.mkdir(ZIP_BACKUP_DIR, { recursive: true });

  const nextVersion =
    params.bumpVersion === false
      ? db.backupConfig.currentVersion
      : bumpPatchVersion(db.backupConfig.currentVersion);

  const now = new Date().toISOString();
  const datePart = now.slice(0, 19).replace(/[:T]/g, '-');
  const filename = `ZERO_AI_STUDIO_v${nextVersion}_${datePart}.zip`;
  const targetPath = path.join(ZIP_BACKUP_DIR, filename);

  // Persist pending version/changelog before zipping so the archive itself contains exact state
  db.backupConfig.currentVersion = nextVersion;
  db.backupConfig.changelogHistory.unshift({
    version: nextVersion,
    date: now,
    summary: params.changelog,
  });
  if (db.backupConfig.changelogHistory.length > 40) {
    db.backupConfig.changelogHistory = db.backupConfig.changelogHistory.slice(0, 40);
  }
  await saveDb(db);

  const zipRes = await buildFullProjectZip();
  const verification = verifyZipBuffer(zipRes.buffer);
  if (!verification.result.valid) {
    throw new Error(
      `ZIP-Integritätsprüfung fehlgeschlagen: ${[
        ...verification.result.errors,
        ...verification.result.missingCoreFiles.map((f) => `Fehlende Datei: ${f}`),
      ].join('; ')}`
    );
  }

  await fs.writeFile(targetPath, zipRes.buffer);

  // Mark latest verified working backup as protected; keep prior protected backups intact
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
    protected: true,
    excludedSecrets: EXCLUDED_SECRETS_DOC,
  };

  db.backupConfig.lastVerifiedAt = now;
  db.backupConfig.zipBackups.unshift(record);
  if (db.backupConfig.zipBackups.length > 25) {
    // Keep all protected backups or latest 25 without silently deleting protected ones
    const protectedItems = db.backupConfig.zipBackups.filter((b) => b.protected);
    const unprotectedItems = db.backupConfig.zipBackups.filter((b) => !b.protected).slice(0, 10);
    db.backupConfig.zipBackups = [...protectedItems, ...unprotectedItems].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }
  await saveDb(db);
  return record;
}

export async function maybeAutoCreateZipBackup(changelog: string): Promise<ZipBackupVersion | null> {
  const db = await loadDb();
  if (!db.backupConfig.autoZipOnChange) return null;
  return createVersionedZipBackup({
    changelog,
    trigger: 'auto',
    bumpVersion: true,
  });
}

export async function getZipBackupFilePath(zipId: string): Promise<{
  record: ZipBackupVersion;
  filePath: string;
}> {
  const db = await loadDb();
  const record = db.backupConfig.zipBackups.find((b) => b.id === zipId);
  if (!record) throw new Error('ZIP-Version nicht gefunden.');
  const filePath = path.join(ZIP_BACKUP_DIR, record.filename);
  await fs.access(filePath);
  return { record, filePath };
}

export async function toggleZipBackupProtection(zipId: string): Promise<ZipBackupVersion> {
  const db = await loadDb();
  const record = db.backupConfig.zipBackups.find((b) => b.id === zipId);
  if (!record) throw new Error('ZIP-Version nicht gefunden.');
  record.protected = !record.protected;
  await saveDb(db);
  return record;
}

export async function deleteUnprotectedZipBackup(zipId: string): Promise<void> {
  const db = await loadDb();
  const idx = db.backupConfig.zipBackups.findIndex((b) => b.id === zipId);
  if (idx === -1) throw new Error('ZIP-Version nicht gefunden.');
  const target = db.backupConfig.zipBackups[idx];
  if (target.protected) {
    throw new Error('Geschütztes Backup darf nicht gelöscht werden. Hebe zuerst den Schutz auf.');
  }
  const filePath = path.join(ZIP_BACKUP_DIR, target.filename);
  await fs.rm(filePath, { force: true });
  db.backupConfig.zipBackups.splice(idx, 1);
  await saveDb(db);
}

export async function restoreFromVerifiedZipBackup(zipId: string): Promise<{
  restoredVersion: string;
  safetyBackup: ZipBackupVersion;
  db: ZeroDatabase;
}> {
  const { record, filePath } = await getZipBackupFilePath(zipId);
  const zipBuf = await fs.readFile(filePath);
  const verification = verifyZipBuffer(zipBuf);

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
    parsedRestoredDb = JSON.parse(dbEntry.toString('utf8')) as ZeroDatabase;
    if (!Array.isArray(parsedRestoredDb.models) || !Array.isArray(parsedRestoredDb.projects)) {
      throw new Error('Ungültige Datenbankstruktur im Archiv.');
    }
  } catch (err) {
    throw new Error(
      `Wiederherstellung abgebrochen — JSON im Backup ungültig: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Mandatory safety backup BEFORE restoring!
  const safetyBackup = await createVersionedZipBackup({
    changelog: `Sicherheitsbackup vor Wiederherstellung von v${record.version}`,
    trigger: 'pre_restore',
    bumpVersion: true,
  });

  const currentDb = await loadDb();
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
  parsedRestoredDb.models = parsedRestoredDb.models.map(enrichModelMetadata);

  await saveDb(parsedRestoredDb);
  return {
    restoredVersion: record.version,
    safetyBackup,
    db: parsedRestoredDb,
  };
}


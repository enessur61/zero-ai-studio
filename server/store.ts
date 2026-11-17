import { isDeepStrictEqual } from 'node:util';
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
import { BackupCleanupError, createVersionedZipBackupService } from './versionedZipBackup.ts';
import { createVerifiedZipRestoreService } from './verifiedZipRestore.ts';
import { acquirePersistentAutoBackupLease, acquirePersistentZipOperationLease, deleteBackupFile, inspectPersistentBackupConsistency, PersistentStateConflictError, readBackupFile, readPersistentState, withPersistentAutoBackupLease, writePersistentState, writePersistentStateWithBackupFile } from './persistence.ts';
import {
  buildFullProjectZip,
  EXCLUDED_SECRETS_DOC,
  MAX_ZIP_ARCHIVE_BYTES,
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
    def.id === 'sd-turbo-free' ||
    def.id === 'sana-free'
  ) {
    freeTierType = 'DERZEIT NICHT VERFÜGBAR';
    prerequisites = 'Sicher deaktiviert: kein verifizierter, dauerhaft kostenloser Provider verfügbar. Kein kostenpflichtiger Fallback.';
  } else if (['cloudflare-glm-4.7-flash', 'flux-1-schnell-free', 'cloudflare-whisper-large-v3-turbo', 'cloudflare-moondream-3.1-9b-a2b'].includes(def.id)) {
    freeTierType = 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)';
    prerequisites = 'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN auf dem ZERO-Server. Cloudflare Workers AI Free stellt 10.000 Neurons pro Tag für alle Modelle gemeinsam bereit; kein kostenpflichtiger Fallback.';
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
    summary: 'Server-Adapter für Gemini-Text, TTS, Transkription, Embeddings und Google Search Grounding sind implementiert; jeder Provider bleibt bis zum erfolgreichen Live-Test unverifiziert.',
    details: 'Die Gemini-Free-Tier-Aufrufe laufen serverseitig mit Budget-Schutz. Modellstatus werden erst nach erfolgreicher Live-Probe aktiviert; nicht verifizierte Cloud-Bild- und Open-Text-Provider sind deaktiviert.',
  },
  {
    area: 'Lokale On-Device Engines (iPhone 16 Pro Max)',
    status: 'neu_implementiert',
    summary: 'Web-Audio-Synthesizer mit WAV-Export, lokaler Canvas-/MediaRecorder-Video-Kompositor (<= 60s), lokale Bildbearbeitung/Upscaling und Apple Web Speech.',
    details: 'Diese Browserfunktionen benötigen keine externen KI-Provider. Canvas-Bildbearbeitung ist keine generative Bild-KI; der Video-Kompositor erzeugt keine KI-Videos. Die tatsächliche iPhone-Laufzeit muss auf dem Gerät getestet werden.',
  },
  {
    area: 'Lokale Open-Weight Modelle (CoreML / MLX / MediaPipe / whisper.cpp / Piper / Kokoro)',
    status: 'neu_implementiert',
    summary: 'Native ZERO-iOS-App-Host und Swift-Adapter-Quellcode vorhanden; Modellgewichte für CoreML/MLX/Audio und echte iPhone-Inferenztests fehlen noch (nicht produktionsbereit).',
    details: 'Quellcode-Gerüste für Qwen 2.5 3B, Llama 3.2 1B/3B, DeepSeek-R1 1.5B, Gemma 3 4B, whisper.cpp, Piper ONNX und Kokoro-82M sind vorhanden. Die 0,07–2,6 GB Modellgewichte sind nicht enthalten; Runtime-Backends/Tokenizer und echte iPhone-Inferenztests fehlen. Ein XcodeGen-Projekt mit WKWebView-Host ist vorhanden und baut im Simulator, aber die App ist noch nicht signiert oder auf einem Gerät installiert. Zusätzlich ist Llama 3.2 1B über WebGPU als experimenteller lokaler Browser-Chat integriert.',
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
    status: 'aktiv',
    deliverables: ['26 katalogisierte Modelle mit Lizenz-, RAM- & iOS-Metadaten', 'Live-Testrunner; Modellfreigabe nur nach erfolgreichem Laufzeittest', 'Nicht verfügbare Provider bleiben deaktiviert'], 
  },
  {
    phase: 4,
    title: 'ZERO AUDIO STUDIO & Sprachpipeline',
    status: 'abgeschlossen',
    deliverables: ['Gemini-TTS-Adapter und lokales WAV-Rendering', 'Apple AVSpeech / Web Speech Deutsch', 'Wortgenaue Zeitstempel aus Gemini-Transkriptionsannotationen und echter SRT-Download; ohne Zeitstempel kein erfundenes SRT'], 
  },
  {
    phase: 5,
    title: 'ZERO MEMORY (Langzeitgedächtnis)',
    status: 'aktiv',
    deliverables: ['Persistente PostgreSQL-Datenbank in Produktion', 'Semantische Vektorsuche (Gemini-Embedding) nach erfolgreichem Provider-Test', 'Backup-/Restore-Integration vorhanden; kontrollierter Produktions-Restore-Test steht aus'], 
  },
  {
    phase: 6,
    title: 'ZERO IMAGE STUDIO',
    status: 'aktiv',
    deliverables: ['Lokale Bildbearbeitung und 2x Upscaling', 'Vision-Analyse, sofern ein unterstütztes Modell live verfügbar ist', 'Generative Bild-KI deaktiviert: kein verifizierter dauerhaft kostenloser Provider'], 
  },
  {
    phase: 7,
    title: 'ZERO VIDEO STUDIO (<= 60s Limit)',
    status: 'abgeschlossen',
    deliverables: ['Lokaler Szenen-Kompositor mit harter 60,0s Grenze', 'Ken-Burns Kamerafahrten & Übergänge', 'WebM/MP4 Export inkl. Audio; kein generatives KI-Video ohne externen GPU-Worker'], 
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
    status: 'aktiv',
    deliverables: ['Workflow-Automatisierung mit Freigabe-Gate; Ende-zu-Ende-Praxistest offen', 'Google Search Grounding nur nach erfolgreichem Provider-Live-Test'], 
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
        'gemini-2.5-flash-lite': { requestsToday: 0, dailySoftLimit: 100, exhausted: false },
        'gemini-3.6-flash': { requestsToday: 0, dailySoftLimit: 150, exhausted: false },
        'gemini-3.5-flash-lite': { requestsToday: 0, dailySoftLimit: 250, exhausted: false },
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
        referenceImageUrl: '/assets/images/char_elena_vance_1794745336698.jpg',
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
            imageUrl: '/assets/images/hero_studio_console_1794745336582.jpg',
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
            imageUrl: '/assets/images/char_elena_vance_1794745336698.jpg',
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
            imageUrl: '/assets/images/scene_studio_synth_1794745338615.jpg',
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
            imageUrl: '/assets/images/scene_berlin_rain_1794745336613.jpg',
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
      autoZipOnChange: false,
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
const dbRevisions = new WeakMap<ZeroDatabase, number>();
const systemBackupRevisions = new WeakMap<SystemBackupMeta, number>();
const zipBackupRevisions = new WeakMap<ZipBackupVersion, number>();
let persistenceSaveQueue: Promise<void> = Promise.resolve();

export async function loadDb(): Promise<ZeroDatabase> {
  // PostgreSQL is the cross-instance source of truth. Only file-backed local
  // development may reuse the process cache between requests.
  if (dbCache && !process.env.DATABASE_URL) return dbCache;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.mkdir(ZIP_BACKUP_DIR, { recursive: true });

  try {
    if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL && process.env.ZERO_ALLOW_EPHEMERAL_DB !== 'true') {
      throw new Error('DATABASE_URL fehlt. ZERO startet in Produktion nicht mit flüchtiger Dateispeicherung.');
    }
    const stored = process.env.DATABASE_URL
      ? await readPersistentState<ZeroDatabase>()
      : null;
    const raw = stored ? JSON.stringify(stored.payload) : process.env.DATABASE_URL
      ? JSON.stringify(createDefaultDatabase())
      : await fs.readFile(DB_PATH, 'utf8');
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
        'sd-turbo-free',
        'sana-free',
      ].includes(def.id);
      const requiresNativeRuntimeVerification = [
        'apple-foundation-model',
        'qwen-2.5-3b-coreml',
        'llama-3.2-1b-coreml',
        'llama-3.2-3b-coreml',
        'gemma-3-4b-it',
        'deepseek-r1-distill-1.5b',
        'piper-tts-de',
        'whisper-cpp-small',
        'kokoro-82m',
      ].includes(def.id);
      const unverifiedDefaultSuccess =
        prev &&
        def.executionMode === 'FREE CLOUD' &&
        prev.status === 'FUNKTIONIERT' &&
        !prev.lastTestedAt;
      const requiresBrowserRuntimeVerification = def.adapterId === 'webllm' || [
        'zero-canvas-img2img',
        'zero-timeline-video-60s',
        'apple-avspeech-webspeech',
        'zero-webaudio-synth',
      ].includes(def.id);
      const shouldKeepPrevState =
        prev &&
        !legacyPollinationsModel &&
        !requiresNativeRuntimeVerification &&
        !requiresBrowserRuntimeVerification &&
        !unverifiedDefaultSuccess &&
        !hasStaleRawError &&
        prev.adapterId === def.adapterId &&
        prev.hasRealAdapter === def.hasRealAdapter;
      // Runtime verification must be repeated on every process/device, but
      // the user's availability toggle is still durable configuration. Keep
      // only that preference for these unverified adapters; never carry over
      // client-reported testPassed/status metadata.
      const preserveAvailabilityToggle = Boolean(
        prev &&
        (requiresNativeRuntimeVerification || requiresBrowserRuntimeVerification) &&
        prev.adapterId === def.adapterId
      );
      const preserveNativeClientActivation = Boolean(
        prev &&
        requiresNativeRuntimeVerification &&
        prev.adapterId === def.adapterId &&
        prev.status === 'BROWSER TEST ERFORDERLICH' &&
        prev.testPassed === false &&
        prev.hasRealAdapter === false
      );
      const requiresUnverifiedLocalRuntime =
        requiresNativeRuntimeVerification || requiresBrowserRuntimeVerification;
      const merged: ModelDefinition = shouldKeepPrevState
        ? {
            ...def,
            enabled: def.requiresPaidKey ? false : prev.enabled,
            lastTestedAt: prev.lastTestedAt,
            lastTestLatencyMs: prev.lastTestLatencyMs,
            lastTestMessage: prev.lastTestMessage,
            testPassed: prev.testPassed,
            status: def.requiresPaidKey ? 'GESPERRT' : prev.status,
          }
        : requiresUnverifiedLocalRuntime
          ? {
              ...def,
              // Preserve only the user's enabled preference for a matching local adapter.
              // Never trust persisted/client-reported verification fields for on-device runtimes.
              enabled: def.requiresPaidKey ? false : (preserveAvailabilityToggle ? prev!.enabled : false),
              hasRealAdapter: false,
              testPassed: false,
              status: requiresNativeRuntimeVerification && !preserveNativeClientActivation ? 'INSTALLATION ERFORDERLICH' : 'BROWSER TEST ERFORDERLICH',
              lastTestedAt: null,
              lastTestLatencyMs: null,
              lastTestMessage: def.lastTestMessage,
            }
          : def;
      return enrichModelMetadata(merged as ModelDefinition);
    });
    // Remove persisted quota counters for Gemini aliases retired from the catalog.
    delete parsed.budgetGuard.freeQuotaUsage['gemini-3.7-flash'];
    delete parsed.budgetGuard.freeQuotaUsage['gemini-3.5-flash'];
    if (!parsed.budgetGuard.freeQuotaUsage['gemini-web-grounding']) {
      parsed.budgetGuard.freeQuotaUsage['gemini-web-grounding'] = {
        requestsToday: 0,
        dailySoftLimit: 100,
        exhausted: false,
      };
    }
    if (!parsed.budgetGuard.freeQuotaUsage['gemini-2.5-flash-lite']) {
      parsed.budgetGuard.freeQuotaUsage['gemini-2.5-flash-lite'] = {
        requestsToday: 0,
        dailySoftLimit: 100,
        exhausted: false,
      };
    }
    for (const [modelId, dailySoftLimit] of Object.entries({
      'gemini-3.6-flash': 150,
      'gemini-3.5-flash-lite': 250,
    })) {
      if (!parsed.budgetGuard.freeQuotaUsage[modelId]) {
        parsed.budgetGuard.freeQuotaUsage[modelId] = {
          requestsToday: 0,
          dailySoftLimit,
          exhausted: false,
        };
      }
    }
    if (!parsed.backupConfig) {
      const now = new Date().toISOString();
      parsed.backupConfig = {
        currentVersion: '1.1.0',
        autoZipOnChange: false,
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
    if (process.env.DATABASE_URL) {
      const persistedShape = JSON.parse(JSON.stringify(parsed)) as ZeroDatabase;
      const needsPersistence = !stored || !isDeepStrictEqual(persistedShape, stored.payload);
      if (needsPersistence) {
        try {
          const nextRevision = await writePersistentState(parsed, stored?.revision ?? 0);
          dbRevisions.set(parsed, nextRevision);
        } catch (error) {
          if (!(error instanceof PersistentStateConflictError)) throw error;
          // Another instance initialized or migrated the row first. Use its latest committed state.
          const latest = await readPersistentState<ZeroDatabase>();
          if (!latest) throw error;
          dbCache = latest.payload;
          dbRevisions.set(latest.payload, latest.revision);
        }
      } else if (stored) {
        dbRevisions.set(parsed, stored.revision);
      }
    }
    return dbCache;
  } catch (error) {
    if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production') throw error;
    dbCache = createDefaultDatabase();
    dbCache.models = dbCache.models.map(enrichModelMetadata);
    await saveDb(dbCache);
    return dbCache;
  }
}

export interface SaveDbOptions {
  expectedRevision?: number;
  backupFile?: { id: string; filename: string; contentType: string; payload: Buffer };
  recordAutoBackupSuccess?: boolean;
}

export function getDbRevision(db: ZeroDatabase): number {
  const revision = dbRevisions.get(db);
  if (revision === undefined) throw new PersistentStateConflictError(-1, null);
  return revision;
}

export function getSystemBackupRevision(backup: SystemBackupMeta): number {
  const revision = systemBackupRevisions.get(backup);
  if (revision === undefined) throw new PersistentStateConflictError(-1, null);
  return revision;
}

export function getZipBackupRevision(backup: ZipBackupVersion): number {
  const revision = zipBackupRevisions.get(backup);
  if (revision === undefined) throw new PersistentStateConflictError(-1, null);
  return revision;
}

export async function saveDb(db: ZeroDatabase, options: SaveDbOptions = {}): Promise<void> {
  if (process.env.DATABASE_URL) {
    // All writers share the PostgreSQL advisory transaction lock and revision check.
    const operation = persistenceSaveQueue.then(async () => {
      const expectedRevision = options.expectedRevision ?? dbRevisions.get(db);
      if (expectedRevision === undefined) {
        throw new PersistentStateConflictError(-1, null);
      }
      try {
        const nextRevision = options.backupFile
          ? await writePersistentStateWithBackupFile(
              db, expectedRevision, options.backupFile, options.recordAutoBackupSuccess ?? false
            )
          : await writePersistentState(db, expectedRevision);
        dbRevisions.set(db, nextRevision);
        dbCache = db;
      } catch (error) {
        // A conflict means the process cache can no longer be trusted.
        if (error instanceof PersistentStateConflictError) dbCache = null;
        throw error;
      }
    });
    persistenceSaveQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

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
  const current = await loadDb();
  const expectedRevision = process.env.DATABASE_URL ? getDbRevision(current) : undefined;
  const nextDb = JSON.parse(JSON.stringify(current)) as ZeroDatabase;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `zero-backup-${stamp}.json`;
  const payload = JSON.stringify(nextDb, null, 2);
  const bytes = Buffer.from(payload, 'utf8');
  const meta: SystemBackupMeta = {
    id: `bkp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    filename,
    createdAt: new Date().toISOString(),
    note,
    sizeBytes: bytes.length,
  };
  nextDb.backups.unshift(meta);
  const removedBackups = nextDb.backups.length > 20 ? nextDb.backups.slice(20) : [];
  if (removedBackups.length) nextDb.backups = nextDb.backups.slice(0, 20);

  if (process.env.DATABASE_URL) {
    await saveDb(nextDb, {
      expectedRevision,
      backupFile: { id: meta.id, filename, contentType: 'application/json', payload: bytes },
    });
    systemBackupRevisions.set(meta, getDbRevision(nextDb));
  } else {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, filename);
    await fs.writeFile(backupPath, payload, 'utf8');
    try {
      await saveDb(nextDb);
    } catch (error) {
      await fs.rm(backupPath, { force: true });
      throw error;
    }
  }

  if (process.env.DATABASE_URL) {
    await Promise.all(removedBackups.map((backup) => deleteBackupFile(backup.id)));
  } else {
    await Promise.all(removedBackups.map((backup) =>
      fs.rm(path.join(BACKUP_DIR, backup.filename), { force: true })
    ));
  }
  return meta;
}

export function assertRestorableDatabase(value: unknown): asserts value is ZeroDatabase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Die Datenbankstruktur ist ungültig.');
  }

  const parsed = value as Partial<ZeroDatabase>;
  const requiredArrays: Array<keyof ZeroDatabase> = [
    'models', 'projects', 'memories', 'characters', 'chatHistory',
    'automationRuns', 'backups',
  ];
  if (requiredArrays.some((key) => !Array.isArray(parsed[key]))) {
    throw new Error('Erforderliche Datenbanklisten fehlen oder sind beschädigt.');
  }
  if (
    !parsed.budgetGuard || typeof parsed.budgetGuard !== 'object' ||
    !Array.isArray(parsed.budgetGuard.auditLog) ||
    !parsed.budgetGuard.freeQuotaUsage || typeof parsed.budgetGuard.freeQuotaUsage !== 'object' ||
    !parsed.backupConfig || typeof parsed.backupConfig !== 'object' ||
    !Array.isArray(parsed.backupConfig.zipBackups) ||
    !Array.isArray(parsed.backupConfig.changelogHistory) ||
    !parsed.settings || typeof parsed.settings !== 'object' ||
    typeof parsed.settings.preferredVideoDurationSec !== 'number' ||
    typeof parsed.settings.offlineFirstPreferLocal !== 'boolean'
  ) {
    throw new Error('Backup-Einstellungen oder Budgetdaten sind unvollständig.');
  }
  if (parsed.models!.some((model) => !model || typeof model.id !== 'string')) {
    throw new Error('Mindestens ein KI-Modell im Backup ist beschädigt.');
  }
  if (parsed.characters!.some((character) => !character || typeof character.id !== 'string')) {
    throw new Error('Mindestens ein Charakter im Backup ist beschädigt.');
  }
  if (parsed.projects!.some((project) =>
    !project || typeof project.id !== 'string' ||
    !Array.isArray(project.scenes) || !Array.isArray(project.assets) ||
    !Array.isArray(project.characterIds)
  )) {
    throw new Error('Mindestens ein Projekt im Backup ist beschädigt.');
  }
}

export async function restoreSystemBackup(backupId: string): Promise<ZeroDatabase> {
  const db = await loadDb();
  const found = db.backups.find((b) => b.id === backupId);
  if (!found) throw new Error('Backup nicht gefunden.');

  const raw = process.env.DATABASE_URL
    ? (await readBackupFile(found.id)).toString('utf8')
    : await fs.readFile(path.join(BACKUP_DIR, found.filename), 'utf8');

  let restored: ZeroDatabase;
  try {
    const parsed: unknown = JSON.parse(raw);
    assertRestorableDatabase(parsed);
    restored = parsed;
  } catch (error) {
    throw new Error(`Wiederherstellung abgebrochen — Backup ungültig: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Persist a safety backup first. The final revision check below fences off any
  // normal write that lands between the safety backup and the restore replacement.
  const safetyBackup = await createSystemBackup(`Sicherheitsbackup vor Wiederherstellung von ${found.filename}`);
  const current = await loadDb();
  const expectedRevision = process.env.DATABASE_URL ? getSystemBackupRevision(safetyBackup) : undefined;
  restored.backups = current.backups;
  restored.backupConfig = current.backupConfig;
  restored.settings = { ...restored.settings, maxVideoDurationSec: 60 };
  restored.models = restored.models.map(enrichModelMetadata);
  await saveDb(restored, { expectedRevision });
  return restored;
}

export const createVersionedZipBackup = createVersionedZipBackupService({
  loadDb,
  getDbRevision,
  saveDb,
  deleteBackupFile,
  buildFullProjectZip,
  verifyZipBuffer,
  excludedSecrets: EXCLUDED_SECRETS_DOC,
  isPersistent: () => Boolean(process.env.DATABASE_URL),
  rootDir: () => process.cwd(),
  zipBackupDir: ZIP_BACKUP_DIR,
  rememberBackupRevision: (record, revision) => zipBackupRevisions.set(record, revision),
});

export async function inspectZipBackupConsistency(): Promise<{
  orphanedBlobIds: string[];
  missingBlobIds: string[];
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error('Backup-Reconciliation ist nur für den PostgreSQL-Persistenzmodus verfügbar.');
  }
  return inspectPersistentBackupConsistency();
}

async function createAutoBackupWithoutMisreportingCommittedCleanupFailure(
  create: () => Promise<ZipBackupVersion | null>
): Promise<ZipBackupVersion | null> {
  try {
    return await create();
  } catch (error) {
    if (error instanceof BackupCleanupError) {
      console.error('[ZERO Backup] ZIP-Backup veröffentlicht; Bereinigung ausstehend.', {
        backupId: error.backup.id,
        orphanedBlobIds: error.orphanedBlobIds,
      });
      return error.backup;
    }
    throw error;
  }
}

export async function maybeAutoCreateZipBackup(changelog: string): Promise<ZipBackupVersion | null> {
  const db = await loadDb();
  if (!db.backupConfig.autoZipOnChange) return null;

  const create = (recordAutoBackupSuccess = false) => createVersionedZipBackup({
    changelog,
    trigger: 'auto',
    bumpVersion: true,
    recordAutoBackupSuccess,
  });

  if (process.env.DATABASE_URL) {
    // Background auto-backups share the same two global ZIP slots as HTTP
    // downloads, exports, restores and manual backup creation.
    const zipLease = await acquirePersistentZipOperationLease();
    if (!zipLease) return null;
    try {
      // The auto-backup wrapper releases (or destroys) its own lease connection
      // on every failure path; this outer lease bounds total ZIP resource use.
      return await createAutoBackupWithoutMisreportingCommittedCleanupFailure(() =>
        withPersistentAutoBackupLease(
          () => acquirePersistentAutoBackupLease(),
          () => create(true)
        )
      );
    } finally {
      await zipLease.release();
    }
  }

  // Local file mode has only one process; retain the local 15-minute throttle.
  const latestAutoBackup = db.backupConfig.zipBackups.find((backup) => backup.trigger === 'auto');
  if (latestAutoBackup && Date.now() - Date.parse(latestAutoBackup.createdAt) < 15 * 60 * 1000) {
    return null;
  }
  return createAutoBackupWithoutMisreportingCommittedCleanupFailure(() => create());
}

export async function getZipBackupFilePath(zipId: string): Promise<{
  record: ZipBackupVersion;
  buffer: Buffer;
}> {
  const db = await loadDb();
  const record = db.backupConfig.zipBackups.find((b) => b.id === zipId);
  if (!record) throw new Error('ZIP-Version nicht gefunden.');
  if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || record.sizeBytes > MAX_ZIP_ARCHIVE_BYTES) {
    throw new Error(`ZIP-Backup überschreitet das Archivlimit von ${MAX_ZIP_ARCHIVE_BYTES} Bytes.`);
  }
  let buffer: Buffer;
  if (process.env.DATABASE_URL) {
    // PostgreSQL checks octet_length before returning the BYTEA payload, avoiding
    // an oversized blob allocation in the application process.
    buffer = await readBackupFile(record.id, MAX_ZIP_ARCHIVE_BYTES);
  } else {
    const filePath = path.join(ZIP_BACKUP_DIR, record.filename);
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_ZIP_ARCHIVE_BYTES) {
      throw new Error(`ZIP-Backup überschreitet das Archivlimit von ${MAX_ZIP_ARCHIVE_BYTES} Bytes.`);
    }
    buffer = await fs.readFile(filePath);
  }
  return { record, buffer };
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
  // Remove metadata first. If blob cleanup subsequently fails, reconciliation
  // reports an orphaned blob; deleting bytes first could leave a live entry broken.
  db.backupConfig.zipBackups.splice(idx, 1);
  await saveDb(db);
  try {
    if (process.env.DATABASE_URL) await deleteBackupFile(target.id);
    else await fs.rm(path.join(ZIP_BACKUP_DIR, target.filename), { force: true });
  } catch (error) {
    throw new BackupCleanupError(target, [target.id], [error]);
  }
}

export const restoreFromVerifiedZipBackup = createVerifiedZipRestoreService({
  getZipBackupFilePath,
  verifyZipBuffer,
  assertRestorableDatabase,
  createSafetyBackup: (record) => createVersionedZipBackup({
    changelog: `Sicherheitsbackup vor Wiederherstellung von v${record.version}`,
    trigger: 'pre_restore',
    bumpVersion: true,
  }),
  loadDb,
  getZipBackupRevision,
  saveDb,
  enrichModelMetadata,
});

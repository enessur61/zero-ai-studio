# ZERO AI STUDIO

**BEYOND LIMITS.**  

> **Verifizierungsstatus (15.11.2026):** Die Oberfläche und die Backend-Routen sind im Quellcode vorhanden, aber nicht alle Provider sind ohne Zugangsdaten nutzbar. Gemini 3.8 Flash ist ein reales Modell laut offizieller Modellliste; der kostenlose API-Tarif ist kontingentbegrenzt und benötigt einen eigenen API-Key. Ein Modellstatus „FUNKTIONIERT“ darf erst nach erfolgreichem Live-Test gesetzt werden. Pollinations verlangt inzwischen einen API-Key für Generierungsanfragen; ein kostenfreier oder unbegrenzter Betrieb darf daher nicht pauschal zugesichert werden.
Eigenständige 0 € KI-Produktionsplattform für Web & iPhone 16 Pro Max (Safari / Native iOS Roadmap) mit **ZERO CORE**, **Model Hub**, **Film Director**, **Image/Video/Audio/Music Studios**, **Character Engine**, **Web Intelligence**, **Automation Engine** und **Langzeitgedächtnis**.

---

## 1. Projektstruktur

```text
/
├── backups/
│   └── initial-snapshot.json        # Phase-1-Sicherung des Ausgangszustands
├── data/
│   ├── backups/                     # Zeitgestempelte System-Backups
│   └── zero-studio-db.json          # Persistente JSON-Datenbank (Modelle, Projekte, Charaktere, Memory, Audit-Log)
├── ios/
│   └── ZeroCoreML/                  # Swift 6 Runtime-Paket für alle 8 lokalen iOS-Modelle (CoreML, MLX, MediaPipe, whisper.cpp, Piper, Kokoro) + WKWebView Bridge
├── server/
│   ├── adapters.ts                  # Reale Modelladapter (Gemini Free Tier, Pollinations, Swift 6 iOS Verify, Batch-Testrunner)
│   ├── coremlAdapter.ts             # Verifizierer für das iPhone 16 Pro Max Swift-6-Paket (9 Dateien, 8 Modelle)
│   ├── geminiClient.ts              # Server-seitiger @google/genai Client (v1beta, Transient-Retry, 0 € Budget-Guard)
│   ├── modelCatalog.ts              # Katalog aller realen Modelle (Lizenz, RAM, iOS-Kompatibilität, Status)
│   ├── store.ts                     # Atomare Persistenz, Ist-Zustand, 12-Phasen-Roadmap, Backup/Restore
│   └── zipExporter.ts               # Reiner Node.js ZIP-Exporter für ZERO_AI_STUDIO_FULL_PROJECT.zip
├── src/
│   ├── assets/images/               # Generierte Studio- & Charakter-Assets
│   ├── components/
│   │   ├── AudioStudioView.tsx      # Gemini 3.8 TTS WAV, Apple Web Speech, Gemini 3.5 Transcribe + SRT
│   │   ├── BrainView.tsx            # ZERO BRAIN Assistent, Web Intelligence & Automation Engine
│   │   ├── FilmDirectorView.tsx     # 14-Stufen Kurzfilm-Regie (<= 60s) & Einzel-Szenen-Regenerierung
│   │   ├── HomeView.tsx             # Übersicht, Metriken, Ist-Zustand & Entwicklungsplan
│   │   ├── ImageStudioView.tsx      # Img2Img, 2x Upscale & Vision-Analyse; Cloud-Generierung pausiert
│   │   ├── MemoryView.tsx           # Langzeitgedächtnis & semantische Vektorsuche (gemini-embedding-2)
│   │   ├── ModelHubView.tsx         # Filterbarer Modellkatalog mit Live-Testrunner
│   │   ├── MusicStudioView.tsx      # KI-Komposition + lokale Web Audio DSP-Synthese + SFX (.wav)
│   │   ├── ProjectsCharactersView.tsx # Projektverwaltung (Snapshots/JSON) & Character Engine
│   │   ├── SettingsView.tsx         # 0 € Budget-Guard, Kontingente, Backups, ZIP-Export & iOS-Architektur
│   │   ├── StatusLabel.tsx          # Einheitliche Statusanzeige (ohne Pill-Clutter)
│   │   └── VideoStudioView.tsx      # Szenen-Schnitt, Ken Burns, Untertitel & WebM/MP4 Export (<= 60s)
│   ├── lib/
│   │   ├── api.ts                   # Typisierter HTTP-Client
│   │   ├── localAudioSynth.ts       # Web Audio API / OfflineAudioContext Synthesizer & WAV-Encoder
│   │   ├── localImageProcessor.ts   # Lokales Canvas Grading & 2x Upscaling
│   │   └── localVideoCompositor.ts  # Lokaler Canvas + MediaRecorder Video-Kompositor (max 60,0s)
│   ├── types/
│   │   └── zero.ts                  # Gemeinsame TypeScript-Datenmodelle
│   ├── App.tsx                      # Hauptnavigation (Desktop Sidebar + iPhone 16 Pro Max Bottom Tab Bar)
│   ├── index.css                    # Tailwind CSS v4 + iOS Safe-Area Helpers
│   └── main.tsx                     # React Entry Point
├── .env.example                     # Sichere Vorlage für Umgebungsvariablen (ohne Geheimnisse)
├── index.html                       # HTML Entry Point (Fonts & iOS Viewport Meta)
├── metadata.json                    # App-Metadaten & Capabilities
├── package.json                     # Abhängigkeiten & Scripts
├── server.ts                        # Express Backend + Vite Dev Middleware + API-Endpunkte
├── tsconfig.json                    # TypeScript-Konfiguration
└── vite.config.ts                   # Vite Build-Konfiguration
```

---

## 2. Installation & Lokaler Start

### Voraussetzungen
- **Node.js >= 22.18** (empfohlen: 22.23+ für native `.ts`-Ausführung mit `node server.ts`)
- **npm**
- Kostenloser **Google Gemini API Key** (Free Tier in Google AI Studio)

### Schritt-für-Schritt

1. Abhängigkeiten installieren:
   ```bash
   npm install
   ```

2. Umgebungsvariablen anlegen (`.env.example` kopieren und API-Key eintragen):
   ```bash
   cp .env.example .env
   ```
   In `.env`:
   ```env
   GEMINI_API_KEY="DEIN_KOSTENLOSER_GEMINI_API_KEY"
   APP_URL="http://localhost:3000"
   ```

3. Entwicklungsserver starten (Port 3000):
   ```bash
   npm run dev
   ```

4. Typprüfung & Produktions-Build erstellen:
   ```bash
   npm run lint
   npm run build
   npm start
   ```

---

## 3. API-Schnittstellen (Express Backend)

| Methode | Endpunkt | Funktion |
| --- | --- | --- |
| `GET` | `/api/health` | Systemstatus, Budget-Limit (`0 €`), aktive Adapter |
| `GET` | `/api/system/audit` | Ist-Zustand, 12-Phasen-Plan, Budget-Guard, Backups |
| `POST` | `/api/system/backup` | Erstellt manuelles Datenbank-Backup in `data/backups/` |
| `POST` | `/api/system/restore` | Stellt gespeichertes JSON-Backup wieder her |
| `GET` | `/api/system/export-zip` | Erzeugt, verifiziert (CRC32) und liefert das vollständige Projekt-ZIP |
| `GET/POST` | `/api/system/zip-backups` | Listet oder erstellt versionierte, CRC32-verifizierte ZIP-Backups in `exports/zips/` |
| `POST` | `/api/system/zip-backups/settings` | Aktiviert/Deaktiviert Auto-ZIP bei Änderungen (`autoZipOnChange`) |
| `GET` | `/api/system/zip-backups/:id/download` | Lädt eine bestimmte historische ZIP-Version herunter |
| `POST` | `/api/system/zip-backups/:id/protect` | Schützt oder entsichert ein ZIP-Backup vor dem Löschen |
| `POST` | `/api/system/zip-backups/:id/restore` | Prüft ZIP-Integrität, legt Vorab-Sicherheitsbackup an und stellt den Stand wieder her |
| `DELETE` | `/api/system/zip-backups/:id` | Löscht ausschließlich ungeschützte ZIP-Versionen |
| `GET` | `/api/models` | Listet alle Modelle inkl. Kostenklasse, Voraussetzungen, RAM, Lizenz & iOS-Kompatibilität |
| `GET` | `/api/models/coreml/llama-3.2` | Prüft CoreML Adapter-Paket für Llama 3.2 1B & 3B |
| `GET` | `/api/models/ios-runtime` | Prüft alle 9 Swift-6-Adapter-Dateien für sämtliche 8 lokalen iOS-Modelle |
| `POST` | `/api/models/test-all` | Prüft alle kompatiblen Adapter im Modellkatalog gebündelt (inkl. IP-Cooldown-Schutz) |
| `POST` | `/api/models/:id/test` | Führt einen echten Live-Funktionstest für das jeweilige Modell aus |
| `POST` | `/api/models/:id/toggle` | Aktiviert/Deaktiviert freie Adapter (blockiert Paid-Modelle) |
| `POST` | `/api/brain/chat` | ZERO BRAIN Assistent (`gemini-3.8-flash`, `gemini-3.1-flash-lite`, `gpt-oss-20b-free`) |
| `POST` | `/api/web/research` | ZERO WEB INTELLIGENCE mit verifizierten Google-Search-Quellen |
| `POST` | `/api/image/generate` | Bildgenerierung über (derzeit deaktiviert; kein verifizierter dauerhaft kostenloser Provider) |
| `POST` | `/api/image/analyze` | Multimodale Vision-Bildanalyse über `gemini-3.8-flash` |
| `POST` | `/api/audio/tts` | Sprachsynthese (`gemini-3.8-flash-lite-tts` / `gemini-3.8-flash-tts`, WAV) |
| `POST` | `/api/audio/transcribe` | Audio-Transkription & SRT (`gemini-3.5-transcribe`) |
| `POST` | `/api/music/compose` | KI-Musikparameter für den lokalen WebAudio DSP-Synthesizer |
| `POST` | `/api/film/direct` | Vollautomatische Kurzfilm-Regie (hart begrenzt auf max. 60 Sekunden) |
| `POST` | `/api/film/regenerate-scene` | Einzelne Szene inkl. neuem Bild regenerieren |
| `GET/POST/PUT/DELETE` | `/api/projects` | Projektverwaltung mit Versions-Snapshots & Asset-Speicherung (`POST /api/projects/:id/assets`) |
| `GET/POST` | `/api/characters` | Charakterprofile für visuelle & stimmliche Konsistenz |
| `GET/POST/DELETE` | `/api/memory` | Langzeitgedächtnis + `POST /api/memory/search` (Vektorsuche) |
| `GET/POST` | `/api/automation/run` | Mehrstufige Workflow-Automatisierung inkl. Freigabe-Gate |

---

## 4. Datenbank & Persistenz

- **Format**: Atomar geschriebene JSON-Persistenz unter `data/zero-studio-db.json` (temporäre Datei + `rename`), keine externen Cloud-Datenbankkosten.
- **Migration / Initialisierung**: Beim ersten Start ohne `data/zero-studio-db.json` erzeugt `server/store.ts` automatisch das vollständige Schema inkl. 28-Modelle-Katalog, 0 € Budget-Guard, Beispiel-Charakter (*Elena Vance*), Beispiel-Kurzfilm (*Schatten über Mitte*, 58s) und Initial-Erinnerungen. Beim Laden vorhandener Datenbanken werden neue Katalogmodelle automatisch zusammengeführt, ohne bestehende Testergebnisse zu überschreiben.

---

## 5. Ehrliche Dokumentation offener / externer Bestandteile

1. **Keine Geheimnisse im Export**: `.env`, `node_modules/` und `dist/` sind aus Sicherheits- und Größengründen nicht im ZIP enthalten. Für den Betrieb werden `npm install` sowie ein eigener `GEMINI_API_KEY` in `.env` benötigt.
2. **Benutzerverwaltung / Login**: In der aktuellen Ausbaustufe arbeitet ZERO AI STUDIO bewusst als lokales Einzelplatz-Studio ohne Multi-User-Authentifizierung, Passwort-Hashes oder Cloud-Account-Zwang (keine versteckten oder vorgetäuschten Zugangsdaten). Für eine spätere Mehrbenutzer-Umgebung müsste z. B. Firebase Auth oder ein lokaler JWT/Passkey-Layer ergänzt werden.
3. **Native iOS-Gewichte (Phase 12)**: Alle 8 lokalen iOS-Modelle (Llama 3.2 1B/3B CoreML, Qwen 2.5 3B MLX, DeepSeek-R1 1.5B MLX, Gemma 3 4B MediaPipe, `whisper.cpp` Metal, Piper ONNX DE, Kokoro-82M) besitzen im Paket `ios/ZeroCoreML/` vollständige Swift-6-Adapter & WKWebView-Bridge und sind als `Ready for Deployment` registriert. Ihre 0,07–2,6 GB großen Binärgewichte werden beim Xcode iOS-Build eingebunden.
4. **0 € Budget-Schutz**: Kostenpflichtige Gemini-Modelle (`gemini-4-argon`, `gemini-4-argon`, `gemini-3.1-flash-image`, `gemini-omni-1.1-flash`, `lyria-3-*`) sind serverseitig in `server/geminiClient.ts` fest gesperrt (`GESPERRT`).

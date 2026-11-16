# ZERO AI STUDIO

**BEYOND LIMITS.**  

> **Verifizierungsstatus (16.11.2026):** Die Oberfläche und die Backend-Routen sind im Quellcode vorhanden, aber nicht alle Provider sind ohne Zugangsdaten nutzbar. Gemini 3.8 Flash ist ein reales Modell laut offizieller Modellliste; der kostenlose API-Tarif ist kontingentbegrenzt und benötigt einen eigenen API-Key. Ein Modellstatus „FUNKTIONIERT“ darf erst nach erfolgreichem Live-Test gesetzt werden. Pollinations verlangt inzwischen einen API-Key für Generierungsanfragen; ein kostenfreier oder unbegrenzter Betrieb darf daher nicht pauschal zugesichert werden.
Eigenständige 0 € KI-Produktionsplattform für Web & iPhone 16 Pro Max (installierbare PWA; native On-Device-KI als separate Roadmap) mit **ZERO CORE**, **Model Hub**, **Film Director**, **Image/Video/Audio/Music Studios**, **Character Engine**, **Web Intelligence**, **Automation Engine** und **Langzeitgedächtnis**.

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
│   ├── ZeroCoreML/                  # Swift-Quellcodepaket + WKWebView-Bridge
│   └── ZEROAIStudio/                # XcodeGen-Projekt für den nativen iPhone-WKWebView-App-Host
├── gpu-worker/                     # Optional authenticated Wan 2.1 CUDA inference worker
│   ├── app.py                      # FastAPI queue, WanPipeline inference & MP4 delivery
│   ├── Dockerfile                  # CUDA runtime container
│   └── README.md                   # GPU host deployment and API contract
├── server/
│   ├── adapters.ts                  # Gemini-Free-Tier-Adapter, deaktivierte nicht verifizierte Cloud-Provider, iOS-Quellcodeprüfung
│   ├── coremlAdapter.ts             # Verifizierer für das iPhone 16 Pro Max Swift-6-Paket (9 Dateien, 8 Modelle)
│   ├── geminiClient.ts              # Server-seitiger @google/genai Client (v1beta, Transient-Retry, 0 € Budget-Guard)
│   ├── modelCatalog.ts              # Katalog aller realen Modelle (Lizenz, RAM, iOS-Kompatibilität, Status)
│   ├── store.ts                     # Atomare Persistenz, Ist-Zustand, 12-Phasen-Roadmap, Backup/Restore
│   └── zipExporter.ts               # Reiner Node.js ZIP-Exporter für ZERO_AI_STUDIO_FULL_PROJECT.zip
├── src/
│   ├── assets/images/               # Generierte Studio- & Charakter-Assets
│   ├── components/
│   │   ├── AudioStudioView.tsx      # Gemini-TTS WAV, Apple Web Speech, Transkription als Text (keine SRT-Zeitstempel)
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

### iPhone-Installation

ZERO AI STUDIO ist als installierbare PWA vorbereitet. Öffne die veröffentlichte HTTPS-Adresse in Safari auf dem iPhone, tippe auf **Teilen → Zum Home-Bildschirm** und bestätige. Die App-Shell kann danach offline angezeigt werden; private API-Daten, Projekte, Chats und Memory werden ausdrücklich nicht im Service Worker zwischengespeichert. KI-Funktionen benötigen weiterhin eine Serververbindung.

### Voraussetzungen
- **Node.js 22 LTS** (der Server wird mit `tsx` gestartet)
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
   ZERO_GEMINI_FREE_TIER_ONLY=true  # Nur nachdem Google-Cloud-Abrechnung deaktiviert wurde
   APP_URL="http://localhost:3000"
   ```
   > **Wichtig für 0 €:** Die kostenlose Gemini-Stufe hat providerseitige Tageslimits. Wenn für das Google-Cloud-Projekt Abrechnung aktiviert ist, können Anfragen nach Erreichen von Freikontingenten kostenpflichtig werden. ZERO kann den Google-Abrechnungsstatus nicht auslesen. Deshalb bleiben alle Gemini-Aufrufe standardmäßig gesperrt, bis du die Abrechnung im Google-Cloud-Projekt deaktiviert und die Einstellung `ZERO_GEMINI_FREE_TIER_ONLY=true` bewusst gesetzt hast. ZERO verwendet keinen kostenpflichtigen Fallback.

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

## Wan 2.1 GPU Worker (optional)

ZERO now includes an optional self-hosted Wan 2.1 T2V-1.3B worker in `gpu-worker/`. The worker accepts authenticated generation jobs and returns short MP4 shots; the ZERO backend proxies job creation, status, and video downloads without exposing the worker token to the browser.

- One worker job produces one 5-second 480p shot; the final ZERO timeline remains hard-capped at 60 seconds.
- Requires a separate NVIDIA CUDA GPU host. The iPhone and Render web service do not run this model.
- Model weights download on first inference; no weights or GPU compute are bundled.
- Configure `ZERO_VIDEO_ENGINE_URL` and the matching `ZERO_VIDEO_ENGINE_TOKEN` on the ZERO server. The worker itself also requires the same token.
- See [gpu-worker/README.md](gpu-worker/README.md) for Docker deployment and API details.
- No paid provider fallback is implemented. Open weights do not make GPU compute or hosting permanently free.

The worker source, authenticated proxy routes, per-scene Wan controls, and final-timeline video-clip playback are prepared in this repository. No GPU worker is deployed and no generation run has been verified yet.

---

## 3. iPhone-PWA installieren

ZERO kann als installierbare Web-App auf dem iPhone genutzt werden. Die PWA verwendet den eigenständigen Anzeige-Modus und registriert einen Service Worker für den App-Shell-Cache.

### Auf dem iPhone installieren

1. ZERO über die **HTTPS-Adresse der veröffentlichten Produktionsseite** in Safari öffnen.
2. In Safari auf **Teilen** tippen.
3. **Zum Home-Bildschirm** auswählen.
4. Den Namen „ZERO AI“ bestätigen und auf **Hinzufügen** tippen.
5. ZERO anschließend über das neue Home-Bildschirm-Symbol starten.

Der Installationshinweis erscheint auf iPhones automatisch, solange ZERO noch nicht als eigenständige Home-Bildschirm-App läuft. Die PWA benötigt eine veröffentlichte HTTPS-Adresse; localhost auf dem Entwicklungsrechner ist keine nutzbare iPhone-Produktionsadresse.

### Offline- und Datenschutzverhalten

- Der Service Worker cached die App-Shell und statische Build-Assets, damit die Oberfläche nach einem vorherigen Online-Aufruf erneut geladen werden kann.
- **API-Aufrufe werden ausdrücklich nicht gecached.** Projekte, Chats, Memory, Sitzungen und andere private Serverdaten landen dadurch nicht im Offline-Cache.
- Anmeldung, Synchronisierung, KI-Provider und serverseitige Studios benötigen weiterhin eine erreichbare ZERO-Serverinstanz und gegebenenfalls gültige Zugangsdaten.
- Ein Offline-Start kann die Oberfläche anzeigen, bedeutet aber nicht, dass serverabhängige Funktionen offline arbeiten.
- Nach einem neuen Deployment wird der Service Worker durch eine neue Shell-Version aktualisiert.

### Produktionsvoraussetzungen

Die PWA muss unter HTTPS ausgeliefert werden. Der Hoster muss den Build-Ordner dist/ inklusive manifest.webmanifest, sw.js und icons/ ausliefern und die Express-API unter derselben Origin bereitstellen oder korrekt weiterleiten. Eine iPhone-Installation und echte Safari-Funktionstests sind nach dem Deployment auf dem Gerät zu prüfen.

---

## 4. API-Schnittstellen (Express Backend)

| Methode | Endpunkt | Funktion |
| --- | --- | --- |
| `GET` | `/api/health` | Minimaler öffentlicher Health-Check (keine privaten Projekt-/Kontodaten) |
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
| `GET` | `/api/models/ios-runtime` | Prüft Quellcode und Modellgewichte; meldet niemals Deployment-Bereitschaft ohne native Runtime-Integration |
| `POST` | `/api/models/test-all` | Prüft alle kompatiblen Adapter im Modellkatalog gebündelt (inkl. IP-Cooldown-Schutz) |
| `POST` | `/api/models/:id/test` | Führt einen echten Live-Funktionstest für das jeweilige Modell aus |
| `POST` | `/api/models/:id/toggle` | Aktiviert/Deaktiviert freie Adapter (blockiert Paid-Modelle) |
| `POST` | `/api/brain/chat` | ZERO BRAIN Assistent (`gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`; Websuche separat über `gemini-2.5-flash-lite`) |
| `POST` | `/api/web/research` | ZERO WEB INTELLIGENCE über Gemini 2.5 Flash-Lite Free Tier + Google Search Grounding |
| `POST` | `/api/image/generate` | Bildgenerierung über (derzeit deaktiviert; kein verifizierter dauerhaft kostenloser Provider) |
| `POST` | `/api/image/analyze` | Multimodale Vision-Bildanalyse über `gemini-3.8-flash` |
| `POST` | `/api/audio/tts` | Sprachsynthese (`gemini-3.8-flash-lite-tts` / `gemini-3.8-flash-tts`, WAV) |
| `POST` | `/api/audio/transcribe` | Audio-Transkription als reiner Text (`gemini-3.5-transcribe`; keine SRT-Zeitstempel) |
| `POST` | `/api/music/compose` | KI-Musikparameter für den lokalen WebAudio DSP-Synthesizer |
| `POST` | `/api/film/direct` | Vollautomatische Kurzfilm-Regie (hart begrenzt auf max. 60 Sekunden) |
| `POST` | `/api/film/regenerate-scene` | Einzelne Szene inkl. neuem Bild regenerieren |
| `GET/POST/PUT/DELETE` | `/api/projects` | Projektverwaltung mit Versions-Snapshots & Asset-Speicherung (`POST /api/projects/:id/assets`) |
| `GET/POST` | `/api/characters` | Charakterprofile für visuelle & stimmliche Konsistenz |
| `GET/POST/DELETE` | `/api/memory` | Langzeitgedächtnis + `POST /api/memory/search` (Vektorsuche) |
| `GET/POST` | `/api/automation/run` | Mehrstufige Workflow-Automatisierung inkl. Freigabe-Gate |

---

## 4. Datenbank & Persistenz

- **Lokale Entwicklung**: Atomar geschriebene JSON-Persistenz unter `data/zero-studio-db.json` (temporäre Datei + `rename`).
- **Produktion / Render**: PostgreSQL über `DATABASE_URL`. Die App speichert den vollständigen ZERO-Zustand als JSONB in `zero_app_state`; JSON-System-Backups und verifizierte ZIP-Archive liegen als `BYTEA` in `zero_backup_files`. Damit hängen Produktionsdaten und Backups nicht vom flüchtigen Render-Dateisystem ab.
- **Initialisierung**: Tabellen werden beim ersten Datenbankzugriff automatisch angelegt. Ist noch kein Zustand vorhanden, wird das Standardprojekt initialisiert und in PostgreSQL gespeichert. Vorhandene Datensätze werden nicht durch die Initialisierung überschrieben.
- **Produktionsschutz**: Ohne `DATABASE_URL` verweigert ZERO in Produktion den Zugriff auf die JSON-Datei. `ZERO_ALLOW_EPHEMERAL_DB=true` ist ausschließlich für den CI-Smoke-Test vorgesehen und darf nicht in Render gesetzt werden.
- **Backup-Limit**: Die Datenbank und die darin gespeicherten ZIP-Dateien teilen sich das Speicherlimit des PostgreSQL-Anbieters. Große Medienproduktionen sollten deshalb nicht dauerhaft als Binärdateien in der Datenbank archiviert werden; dafür wäre später ein separater Object-Storage nötig.

---

## 5. Ehrliche Dokumentation offener / externer Bestandteile

1. **Keine Geheimnisse im Export**: `.env`, `node_modules/`, `dist/` und die lokale Datenbank gehören nicht in Git oder Projekt-Archive. Für Gemini-Free-Tier-Funktionen ist ein eigener `GEMINI_API_KEY` als Server-Secret erforderlich. Zusätzlich bleibt Gemini gesperrt, solange `ZERO_GEMINI_FREE_TIER_ONLY` nicht ausdrücklich auf `true` gesetzt ist. Das darfst du erst tun, nachdem du im Google-Cloud-Projekt bestätigt hast, dass keine Abrechnung aktiviert ist; ZERO kann den externen Billing-Status nicht selbst prüfen.
2. **Anmeldung**: In Produktion sind alle privaten `/api/*`-Routen mit einem Admin-Login geschützt. `npm start` aktiviert diesen Schutz standardmäßig. Der lokale Entwicklungsserver (`npm run dev`) deaktiviert den Login nur für lokale Entwicklung und darf nicht öffentlich bereitgestellt werden.
3. **Native iOS-Modelle (noch nicht produktionsbereit)**: Das XcodeGen-Projekt `ios/ZEROAIStudio/` und der Swift-6-WKWebView-Host sind vorhanden; der Simulator-Build läuft in macOS-CI. Eine signierte Installation und ein echter iPhone-Gerätetest stehen noch aus. Für die acht CoreML/MLX/Whisper/Piper/Kokoro-Modelle fehlen weiterhin die Binärgewichte (ca. 0,07–2,6 GB) und teils die vollständigen Runtime-Backends/Tokenizer. Apple Foundation Models hat einen iOS-26+-Adapter, benötigt aber Apple Intelligence auf dem Gerät. Diese nativen Modelle bleiben bis zum echten Gerätetest auf `INSTALLATION ERFORDERLICH`.

4. **Lokales Browser-Modell (experimentell)**: ZERO BRAIN kann Llama 3.2 1B Instruct über WebLLM/WebGPU direkt im Browser laden. Der Erstdownload beträgt ungefähr 705 MB, der konfigurierte GPU-Speicherbedarf rund 879 MB. Es fallen keine API-Kosten an; der Modell-Download wird im Browser-Cache gehalten und kann vom Betriebssystem gelöscht werden. Das Modell nutzt Metas Llama 3.2 Community License (keine OSI-Open-Source-Lizenz) und ist bis zum echten iPhone-Safari-Test experimentell.
4. **0 € Budget-Schutz**: Kostenpflichtige oder nicht verifizierte Provider bleiben serverseitig gesperrt. Google Search Grounding wird bewusst über `gemini-2.5-flash-lite` ausgeführt, dessen offizieller Free-Tier Search-Grounding-Zugang begrenzt ist; ZERO setzt zusätzlich ein eigenes Tageslimit von 100. Der Suchaufruf wird nicht an Gemini 3.8 Flash angehängt, da dessen Free Tier Google Search Grounding nicht anbietet.
5. **iOS-Adapterstatus**: Die Swift-Dateien enthalten teilweise Protokolle und Adapter-Gerüste, aber noch nicht alle echten Runtime-Backends/Tokenizer und kein vollständiges natives iOS-App-Target. Sie werden deshalb nicht als einsatzbereit oder „Ready for Deployment“ ausgegeben.


## 8. Produktionsschutz und Anmeldung

In Produktion sind alle privaten `/api/*`-Routen (Projekte, Chats, Memory, Backups, Modellverwaltung und Studios) standardmäßig durch eine Anmeldung geschützt. Nur `/api/health` sowie die Auth-Status- und Login-Routen bleiben öffentlich erreichbar.

Vor dem Start in einer Hosting-Umgebung müssen diese vier Variablen als **Server-Secrets** gesetzt werden:

- `GEMINI_API_KEY`: eigener Google Gemini API-Key für die kostenlosen, kontingentbegrenzten Gemini-Funktionen
- `ZERO_GEMINI_FREE_TIER_ONLY`: erst nach eigener Prüfung, dass Google-Cloud-Abrechnung deaktiviert ist, exakt `true` setzen; sonst bleiben Gemini-Aufrufe gesperrt
- `ZERO_ADMIN_PASSWORD`: eigenes starkes Passwort mit mindestens 12 Zeichen
- `ZERO_SESSION_SECRET`: zufälliger, geheimer Wert mit mindestens 32 Zeichen

Alle vier Werte ausschließlich im Secret-/Environment-Bereich des Hosters hinterlegen, niemals in Git committen oder im Frontend eintragen. `ZERO_GEMINI_FREE_TIER_ONLY=true` ist eine bewusste Nutzerbestätigung, kein automatischer Billing-Nachweis. Google weist darauf hin, dass Inhalte im kostenlosen API-Tarif zur Verbesserung seiner Produkte verwendet werden können. Keine vertraulichen oder besonders sensiblen Inhalte an diesen Free-Tier senden. Ohne korrekt gesetztes `ZERO_ADMIN_PASSWORD` und `ZERO_SESSION_SECRET` verweigert der Produktionsserver den Zugriff auf private APIs. Solange `ZERO_GEMINI_FREE_TIER_ONLY` nicht `true` ist, bleiben zusätzlich alle Gemini-Aufrufe gesperrt. Die Anmeldung verwendet ein HttpOnly-, SameSite-Strict-Session-Cookie mit 12 Stunden Laufzeit und begrenzt fehlgeschlagene Login-Versuche.

Für lokale Entwicklung (`NODE_ENV` nicht `production`) bleibt die Anmeldung deaktiviert. `.env.example` enthält leere Secret-Platzhalter und die sichere Gemini-Standardsperre (`ZERO_GEMINI_FREE_TIER_ONLY=false`).


`npm start` erzwingt `NODE_ENV=production` und damit den Login-Schutz. Für die tägliche Nutzung muss der Hoster `GEMINI_API_KEY`, `ZERO_GEMINI_FREE_TIER_ONLY`, `ZERO_ADMIN_PASSWORD` und `ZERO_SESSION_SECRET` bereitstellen. Für lokale Entwicklung ausschließlich `npm run dev` verwenden; dieser Befehl startet den ausdrücklich als Development markierten Server.

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
│   └── ZeroCoreML/                  # Swift-Quellcodepaket + WKWebView-Bridge; Modellgewichte und native App-Integration noch erforderlich
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

## 3. API-Schnittstellen (Express Backend)

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
| `POST` | `/api/brain/chat` | ZERO BRAIN Assistent (`gemini-3.8-flash`, `gemini-3.1-flash-lite`; Websuche separat über `gemini-2.5-flash-lite`) |
| `POST` | `/api/web/research` | ZERO WEB INTELLIGENCE über Gemini 2.5 Flash-Lite Free Tier + Google Search Grounding |
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
- **Migration / Initialisierung**: Beim ersten Start ohne `data/zero-studio-db.json` erzeugt `server/store.ts` automatisch das vollständige Schema inkl. 31-Modelle-Katalog, 0 € Budget-Guard, Beispiel-Charakter (*Elena Vance*), Beispiel-Kurzfilm (*Schatten über Mitte*, 58s) und Initial-Erinnerungen. Beim Laden vorhandener Datenbanken werden neue Katalogmodelle automatisch zusammengeführt, ohne bestehende Testergebnisse zu überschreiben.

---

## 5. Ehrliche Dokumentation offener / externer Bestandteile

1. **Keine Geheimnisse im Export**: `.env`, `node_modules/`, `dist/` und die lokale Datenbank gehören nicht in Git oder Projekt-Archive. Für Gemini-Free-Tier-Funktionen ist ein eigener `GEMINI_API_KEY` als Server-Secret erforderlich. Zusätzlich bleibt Gemini gesperrt, solange `ZERO_GEMINI_FREE_TIER_ONLY` nicht ausdrücklich auf `true` gesetzt ist. Das darfst du erst tun, nachdem du im Google-Cloud-Projekt bestätigt hast, dass keine Abrechnung aktiviert ist; ZERO kann den externen Billing-Status nicht selbst prüfen.
2. **Anmeldung**: In Produktion sind alle privaten `/api/*`-Routen mit einem Admin-Login geschützt. `npm start` aktiviert diesen Schutz standardmäßig. Der lokale Entwicklungsserver (`npm run dev`) deaktiviert den Login nur für lokale Entwicklung und darf nicht öffentlich bereitgestellt werden.
3. **Native iOS-Modelle (Phase 12 – noch nicht einsatzbereit)**: Für acht lokale Modelle (Llama 3.2 1B/3B CoreML, Qwen 2.5 3B, DeepSeek-R1 1.5B, Gemma 3 4B, `whisper.cpp`, Piper ONNX DE, Kokoro-82M) liegt Swift-Adapter-Quellcode samt WKWebView-Bridge vor. Die Binärgewichte (ca. 0,07–2,6 GB) sind noch nicht im Repository enthalten; sie müssen in `ios/ZeroCoreML/Models/` bereitgestellt und in eine native iOS-App integriert werden. Der Swift-Paket-Build läuft in macOS-CI, bestätigt aber weder Modellgewichte noch einen echten iPhone-Gerätetest. Diese Modelle bleiben deshalb auf `INSTALLATION ERFORDERLICH`.
4. **0 € Budget-Schutz**: Kostenpflichtige oder nicht verifizierte Provider bleiben serverseitig gesperrt. Google Search Grounding wird bewusst über `gemini-2.5-flash-lite` ausgeführt, dessen offizieller Free-Tier Search-Grounding-Zugang begrenzt ist; ZERO setzt zusätzlich ein eigenes Tageslimit von 100. Der Suchaufruf wird nicht an Gemini 3.8 Flash angehängt, da dessen Free Tier Google Search Grounding nicht anbietet.
5. **iOS-Adapterstatus**: Die Swift-Dateien enthalten teilweise Protokolle und Adapter-Gerüste, aber noch nicht alle echten Runtime-Backends/Tokenizer und kein vollständiges natives iOS-App-Target. Sie werden deshalb nicht als einsatzbereit oder „Ready for Deployment“ ausgegeben.


## 8. Produktionsschutz und Anmeldung

In Produktion sind alle privaten `/api/*`-Routen (Projekte, Chats, Memory, Backups, Modellverwaltung und Studios) standardmäßig durch eine Anmeldung geschützt. Nur `/api/health` sowie die Auth-Status- und Login-Routen bleiben öffentlich erreichbar.

Vor dem Start in einer Hosting-Umgebung müssen diese vier Variablen als **Server-Secrets** gesetzt werden:

- `GEMINI_API_KEY`: eigener Google Gemini API-Key für die kostenlosen, kontingentbegrenzten Gemini-Funktionen
- `ZERO_GEMINI_FREE_TIER_ONLY`: erst nach eigener Prüfung, dass Google-Cloud-Abrechnung deaktiviert ist, exakt `true` setzen; sonst bleiben Gemini-Aufrufe gesperrt
- `ZERO_ADMIN_PASSWORD`: eigenes starkes Passwort mit mindestens 12 Zeichen
- `ZERO_SESSION_SECRET`: zufälliger, geheimer Wert mit mindestens 32 Zeichen

Alle vier Werte ausschließlich im Secret-/Environment-Bereich des Hosters hinterlegen, niemals in Git committen oder im Frontend eintragen. `ZERO_GEMINI_FREE_TIER_ONLY=true` ist eine bewusste Nutzerbestätigung, kein automatischer Billing-Nachweis. Ohne beide Werte verweigert der Produktionsserver den Zugriff auf private APIs. Die Anmeldung verwendet ein HttpOnly-, SameSite-Strict-Session-Cookie mit 12 Stunden Laufzeit und begrenzt fehlgeschlagene Login-Versuche.

Für lokale Entwicklung (`NODE_ENV` nicht `production`) bleibt die Anmeldung deaktiviert. `.env.example` enthält nur leere Platzhalter.


`npm start` erzwingt `NODE_ENV=production` und damit den Login-Schutz. Für die tägliche Nutzung muss der Hoster `GEMINI_API_KEY`, `ZERO_GEMINI_FREE_TIER_ONLY`, `ZERO_ADMIN_PASSWORD` und `ZERO_SESSION_SECRET` bereitstellen. Für lokale Entwicklung ausschließlich `npm run dev` verwenden; dieser Befehl startet den ausdrücklich als Development markierten Server.

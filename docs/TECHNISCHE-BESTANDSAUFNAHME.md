# ZERO AI STUDIO — Technische Bestandsaufnahme

**Datum:** 16.11.2026
**Umfang:** vollständige statische Analyse des Repositorys `enessur61/zero-ai-studio`
**Auftrag:** Architektur, vorhandene Funktionen, echte KI-Modellintegrationen, Sicherheitslücken, Fehler und fehlende Komponenten erfassen; priorisierte Verbesserungen vorschlagen. **Kein Produktionscode wurde verändert.** Dieser Pull Request fügt ausschließlich diesen Bericht hinzu.

**Randbedingungen der Bewertung:** iPhone-first, dauerhaft kostenlos, Open Source, keine kostenpflichtigen Fallbacks, Videolänge maximal 60 Sekunden.

**Verifizierte Umgebung:** Node.js 24.22.2, npm 12.2.2. `npm run lint` ✅, `npm test` ✅ (8 Testdateien), `npm run build` ✅. Abhängigkeiten wurden lokal installiert.

---

## 0. Kurzfazit (Executive Summary)

ZERO AI STUDIO ist ein ehrgeiziges, ungewöhnlich diszipliniertes Projekt. Die zentrale Zusage — **0 € laufende Kosten ohne kostenpflichtigen Fallback** — ist im Code konsequent als „fail closed"-Architektur umgesetzt und wird durch CI-Tests erzwungen. Die genannten Gemini-Modell-IDs sind **gegenüber der offiziellen Google-Dokumentation korrekt** und die meisten sind tatsächlich im kostenlosen Tarif verfügbar (siehe Abschnitt 4).

Die Hauptprobleme liegen **nicht** in der KI-Logik, sondern in der Software-Hygiene und Robustheit:

| Schweregrad | Kernbefund |
| --- | --- |
| **Kritisch** | 27 verwaiste Root-Dateien duplizieren echte Module. Sie werden nicht gebaut, nicht gelintet, nicht getestet — aber Menschen und Agenten könnten sie für aktiv halten. |
| **Hoch** | Keine globale Express-Fehlerbehandlung + 38 von 54 asynchronen Routen ohne `try/catch` → ein DB-Ausfall in einer dieser Routen erzeugt einen unbehandelten Promise-Rejection statt einer sauberen JSON-Antwort. |
| **Hoch** | Zwei divergierende `types/zero.ts`-Dateien (Server nutzt `src/types/`, Frontend nutzt `types/`). Der Server sendet Status-/Tier-Werte, die im Frontend-Typ nicht existieren. |
| **Mittel** | Ein Produktionshost ist fest im iOS-Quellcode verdrahtet (`zero-ai-studio.onrender.com`); ein Domainwechsel erfordert Swift-Änderungen und ein neues IPA. |
| **Mittel** | Keine HTTP-Sicherheitsheader (CSP, HSTS, X-Content-Type-Options, X-Frame-Options), kein `trust proxy` trotz IP-basierter Login-Sperre. |
| **Mittel** | Bewusst bepreiste und sehr große Abhängigkeiten (`@google/genai`, `@mlc-ai/web-llm`) landen ohne manuelle Chunk-Trennung in einem 5,9 MB Haupt-Bundle. |
| **Niedrig** | README/Verzeichnisstruktur weichen von der Realität ab (Backend liegt im Root, nicht in `src/`; `backups/` existiert nicht als Verzeichnis). |

Die drei echten, ohne Zugangsdaten nutzbaren Kreativ-Engines (lokaler Canvas-Bildprozessor, Web-Audio-DSP-Synthesizer, Canvas/MediaRecorder-Video-Kompositor mit 60-s-Hard-Cap) sind sauber und testbar implementiert. Die native iOS-Kette ist **ehrlich als nicht deploymentbereit** gekennzeichnet — das ist eine Stärke, kein Fehler.

---

## 1. Architektur — Ist-Zustand

### 1.1 Schichtenmodell

```text
Browser (iPhone-first PWA)
├── main.tsx / App.tsx            React 19 + Vite 8 + Tailwind v4
├── components/*.tsx             12 Studio-Views (lazy-loaded)
├── lib/*.ts                     lokale Engines + HTTP-Client
│   ├── localAudioSynth.ts       WebAudio/OfflineAudioContext → WAV
│   ├── localImageProcessor.ts   Canvas-Filter & 2× Upscale
│   ├── localVideoCompositor.ts  Canvas + MediaRecorder, 60-s-Cap
│   ├── webgpuLocalModel.ts      WebLLM/WebGPU-Inferenz im Worker
│   ├── iosCoreMLBridge.ts       WKWebView-jsBridge
│   ├── sceneVideoStore.ts       IndexedDB-Videoclips
│   └── api.ts                   Fetch-Wrapper (Timeout/Fehler)
│   └── localModelTypeSuite.ts   Browser-Render-Probes
└── Service Worker (public/sw.js) App-Shell-Cache, API ausgenommen

Server (Node 22 LTS, tsx, Express 4.22)
├── server.ts (2281 Zeilen)      58 Routen, Auth, Budget-Guard
├── server/geminiClient.ts       @google/genai v1beta, Quota-Guard
├── server/adapters.ts           Live-Modelltests, Provider-Gates
├── server/zeroRouter.ts         Modell-Routing (fail closed)
├── server/modelCatalog.ts       45 Modelldefinitionen
├── server/store.ts              JSON/Postgres-Persistenz, Backups
├── server/coremlAdapter.ts      Swift-Paket-Verifizierer
├── server/persistence.ts        PostgreSQL (JSONB + BYTEA)
├── server/zipExporter.ts        eigener ZIP-Writer + CRC32
└── server/{filmLimits,audioUtils,mediaUtils,srt}.ts

iOS (Swift 6, iOS 18+, XcodeGen)
├── ios/ZEROAIStudio/            WKWebView-App-Host
└── ios/ZeroCoreML/              9 Swift-Dateien, 8 Modell-Adapter
```

### 1.2 Datenfluss der KI-Nutzung

1. Frontend ruft eine `/api/*`-Route über `lib/api.ts` auf (3-Minuten-Timeout, JSON-Fehlerbehandlung).
2. In Produktion prüft die `/api`-Middleware Session-Cookie (HMAC-signiert) — sonst `401`.
3. Route wählt über `zeroRouter.ts` **nur** Modelle, die `enabled && hasRealAdapter && testPassed && status === 'FUNKTIONIERT'` erfüllen und deren Free-Tier-Kontingent nicht erschöpft ist.
4. `assertZeroBudgetModelAllowed()` prüft Paid-Sperrliste, Freigabeliste und Tageskontingent und schreibt einen Audit-Eintrag.
5. `getGeminiClient()` verweigert den Client, solange `ZERO_GEMINI_FREE_TIER_ONLY !== 'true'`.
6. Persistenz via `saveDb()` → PostgreSQL (Prod) oder atomare JSON-Datei (Dev).

Diese Kette ist der stärkste Teil des Projekts. Sie ist defensiv, testbar und wird in `tests/geminiClient.test.ts` und `tests/zeroRouter.test.ts` abgedeckt.

### 1.3 Persistenz

- **Dev:** atomare JSON-Datei (`tmp` + `rename`) unter `data/zero-studio-db.json`.
- **Prod:** PostgreSQL, ein JSONB-Datensatz (`zero_app_state`) plus `BYTEA`-Backup-Archiv (`zero_backup_files`).
- **Katalog-Migration:** `loadDb()` merged neue Katalogdefinitionen in gespeicherten Zustand und erzwingt Sicherheits-Resets für Modelle, die native/browser-seitige Laufzeitverifikation benötigen.
- **Backups:** eigener ZIP-Writer mit CRC32-Verifikation, versioniert, schutzfähig, mit Pflicht-Sicherheitsbackup vor Restore.

---

## 2. Vorhandene Funktionen

### 2.1 Ohne jede Zugangsdaten nutzbar (echte, lokale Engines)

| Funktion | Datei | Nachweis |
| --- | --- | --- |
| Bildbearbeitung + 2× Upscale (Canvas) | `lib/localImageProcessor.ts` | `runLocalModelTypeSuite` erzeugt echtes PNG |
| Musik/SFX-Synthese → WAV (WebAudio) | `lib/localAudioSynth.ts` | WAV-Blob > 44 Byte im Test |
| Video-Timeline-Export (Canvas/MediaRecorder, ≤ 60 s) | `lib/localVideoCompositor.ts` | harter Runtime-Stop bei 60 000 ms + Dauer-Check |
| Apple Web Speech TTS (Browser) | `components/AudioStudioView.tsx` | Web-Speech-API |
| WebGPU-Browser-Chat (Llama 3.2 1B) | `lib/webgpuLocalModel.ts` | echter Inferenz-Probe, Worker-basiert |
| PWA-Installation + Offline-Shell | `public/sw.js`, `manifest.webmanifest` | API-Antworten ausdrücklich nicht gecacht |

### 2.2 Gemini-Free-Tier (eigener API-Key erforderlich)

Text/Chat, Websuche-Grounding, Vision-Analyse, TTS (WAV), Transkription mit Wort-Zeitstempeln + SRT, Embeddings/Vektorsuche, Film-Drehbuch, Musikparameter, Automatisierungsplanung.

### 2.3 Deaktiviert / gesperrt (bewusst, ohne kostenpflichtigen Fallback)

Cloud-Bildgenerierung (Pollinations/FLUX/Sana/SD-Turbo), GPT-OSS Open Cloud, alle Paid-Gemini-Modelle, selbstgehostete Videodiffusion (Wan/LTX/CogVideoX/HunyuanVideo), 24B+-Modelle.

### 2.4 Optional: Wan-2.1-GPU-Worker

Separat deploybarer FastAPI/CUDA-Worker (`gpu-worker/`), der 5-Sekunden-Shots erzeugt. Der Server proxyt authentifiziert; das Token erreicht nie den Browser. Der finale ZERO-Timeline-Cap bleibt bei 60 s. Kein Worker ist deployt.

### 2.5 Native iOS-Kette (ehrlich als nicht bereit gekennzeichnet)

9 Swift-Quelldateien im Paket (`Package.swift` + 8 Adapter/Support, davon 7 Modell-Adapter-Klassen), 8 native iOS-Modelle (CoreML/MLX/MediaPipe/whisper.cpp/Piper/Kokoro/Apple-Foundation). `verifyCoreMLAdapterPackage()` gibt **immer** `readyForDeployment: false` zurück, solange Gewichte, Runtime-Bindings und Gerätetest fehlen. Die WKWebView-Bridge prüft Main-Frame + HTTPS + festen Host.

---

## 3. Datei-Redundanz und toter Code (KRITISCH)

Das Repository enthält **zwei parallele Kopien vieler Module**. Nur die Unterordner-Versionen sind aktiv:

- **Aktiv:** `components/`, `lib/`, `server/`, `src/types/`
- **Verwaist (Root):** `adapters.ts`, `api.ts`, `coremlAdapter.ts`, `geminiClient.ts`, `modelCatalog.ts`, `modelRegistry.ts`, `store.ts`, `zipExporter.ts`, `localAudioSynth.ts`, `localImageProcessor.ts`, `localVideoCompositor.ts`, `iosCoreMLBridge.ts`, `MusicStudioView.tsx`, `ProjectsCharactersView.tsx`, `SettingsView.tsx`, `StatusLabel.tsx`, `VideoStudioView.tsx`, `zero.ts`, `Package.swift` sowie 8 Root-`.swift`-Dateien.

**Belege:**

- Kein einziger Import verweist auf eine Root-Version: `grep -rn "from './adapters'"` usw. → 0 Treffer.
- `App.tsx` importiert ausschließlich `./components/*` und `./lib/api.ts`.
- `server.ts` importiert ausschließlich `./server/*` und `./src/types/zero.ts`.
- Die Root-Versionen **weichen inhaltlich ab** (z. B. `localVideoCompositor.ts`, `api.ts`, `store.ts`, alle 5 `.tsx`-Dateien und 7 von 8 `.swift`-Dateien sind nicht identisch).
- `tsconfig.json` `include` listet nur `App.tsx`, `main.tsx`, `server.ts`, `start-server.ts`, `dev-server.ts`, `vite.config.ts`, `components/**`, `lib/**`, `server/**`, `types/**`. Die Root-Duplikate werden **nicht einmal typgeprüft**.
- `Package.swift` im Root referenziert `path: "Sources/ZeroCoreML"` — dieses Verzeichnis existiert im Root nicht.

**Auswirkung:** Erhöht die kognitive Last erheblich, verursacht widersprüchliche Suchergebnisse, verwirrt Beiträge von Agenten/Menschen und kann bei einem `tsc`-Include-Fehler zu Mehrdeutigkeiten führen. Es ist auch ein Sicherheitsrisiko: Eine veraltete `api.ts` ohne Timeout oder ein veralteter `store.ts` könnte versehentlich importiert werden.

**Empfehlung (P0):** Alle Root-Duplikate löschen (`.ts`, `.tsx`, `.swift`, `Package.swift`). Vorher mit `git ls-files` bestätigen, dass nichts referenziert wird. Danach `npm run ci:verify` erneut laufen lassen.

---

## 4. Echte KI-Modellintegrationen — Verifikation

Ich habe die im Katalog deklarierten Gemini-IDs und Kostenklassen **gegen die offizielle Google-Dokumentation** geprüft (`ai.google.dev/gemini-api/docs/models` und `/docs/pricing`, Stand 16.11.2026).

### 4.1 Modell-IDs: korrekt

Alle im Code verwendeten IDs existieren offiziell: `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`, `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.5-transcribe`, `gemini-embedding-2`. Die gesperrten Paid-IDs (`gemini-4-argon`, `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `lyria-3-*`) existieren ebenfalls und sind korrekt als kostenpflichtig blockiert.

### 4.2 Free-Tier-Zuordnung: korrekt

Laut offizieller Preisseite:

| Modell | Free Tier | Im Code |
| --- | --- | --- |
| Gemini 3.8 Flash | „Free of charge" | ✅ freigegeben |
| Gemini 3.6 Flash | „Free of charge" | ✅ freigegeben |
| Gemini 3.5 Flash-Lite | „Free of charge" | ✅ freigegeben |
| Gemini 3.1 Flash-Lite | „Free of charge" | ✅ freigegeben |
| Gemini 3.8 Flash TTS / Flash-Lite TTS | „Free of charge" | ✅ freigegeben |
| Gemini 3.5 Transcribe | „Free of charge" | ✅ freigegeben |
| Gemini 2.5 Flash-Lite | „Free of charge" | ✅ für Grounding genutzt |
| Gemini Embedding 2 | „Free of charge" (Text/Bild) | ✅ freigegeben |
| Gemini 3.8 Flash **Grounding** | „Not available" im Free Tier | ✅ korrekt vermieden |

Besonders positiv: Der Code erkennt korrekt, dass **Google-Search-Grounding im Free Tier nur über `gemini-2.5-flash-lite`** (bis 500 RPD) verfügbar ist und leitet Websuche daher nicht über Gemini 3.8 Flash. Das ist eine ungewöhnlich präzise, dokumentierte Designentscheidung (siehe Kommentar in `server.ts` Zeilen 807–812 und die CI-Prüfung in `.github/workflows/ci.yml`).

### 4.3 Ehrlichkeitsprüfung

- `hasRealAdapter`, `testPassed` und `status` werden **nicht** vorab auf „FUNKTIONIERT" gesetzt; der Status startet auf `INSTALLATION ERFORDERLICH` und erfordert eine echte Live-Probe.
- Der Server weigert sich, client-lokale Adapter als getestet zu markieren (`BROWSER TEST ERFORDERLICH`).
- CI erzwingt, dass ohne Zugangsdaten kein Gemini-Modell als live gilt.

Das ist die wichtigste Stärke des Projekts: **Die Dokumentation übertreibt nicht.**

---

## 5. Sicherheitslücken

### 5.1 Positiv vorhanden

- HMAC-SHA256-signierte Session-Cookies, `HttpOnly`, `SameSite=Strict`, `Secure` in Prod, 12 h Laufzeit, Server-seitige Session-Registry mit Revocation.
- Timing-sichere Passwort- und Signaturvergleiche (`timingSafeEqual`).
- Login-Rate-Limit (8 Versuche / 15 Min / IP).
- Strikte Validierung von Base64-Data-URLs (MIME-Allowlist, Größenlimit, kanonische Base64-Prüfung).
- ZIP-Export schließt `.env`, `node_modules`, `dist`, `.zip` aus; CI verbietet getrackte Secrets.
- GPU-Worker-Token wird nur serverseitig verwendet; SSRF-Schutz über `redirect: 'error'` und feste Pfade.
- WKWebView-Bridge prüft Main-Frame, HTTPS und festen Host.
- Kein `dangerouslySetInnerHTML`, `eval`, `innerHTML` oder `document.write` im gesamten Frontend.

### 5.2 Befunde

| # | Befund | Schwere | Ort |
| --- | --- | --- | --- |
| S1 | **Keine HTTP-Sicherheitsheader** (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy). Für eine PWA mit Session-Cookies relevant. | Mittel | `server.ts` |
| S2 | **Kein `app.set('trust proxy', …)`**, aber IP-basiertes Login-Limit nutzt `req.ip`. Hinter einem Proxy (Render) sieht der Server ggf. die Proxy-IP → das Limit greift global statt pro Client (DoS-Amplifikation oder Umgehung). | Mittel | `server.ts:127` |
| S3 | **Keine CSRF-Schutzschicht.** `SameSite=Strict` mitigiert stark, aber zustandsändernde `POST`-Routen (z. B. `/api/system/zip-backups/:id/restore`) haben keinen Origin-/Token-Check. | Niedrig–Mittel | `server.ts` |
| S4 | **Keine globale Express-Fehlerbehandlung.** 38 der 54 asynchronen Routen haben kein `try/catch`. Ein Fehler in `loadDb()` in einer dieser Routen erzeugt einen unbehandelten Rejection; ohne `process.on('unhandledRejection')` kann der Prozess in neueren Node-Versionen beendet werden. | Hoch | `server.ts` |
| S5 | **Vertrauensmodell der Aktivierungs-Endpunkte.** `/api/models/webgpu/activate`, `/local/activate`, `/native/activate` akzeptieren eine beliebige nicht-leere `probeResponse` (≤ 1000 Zeichen) und setzen `testPassed = true`. Für einen Single-Admin-Betrieb akzeptabel, aber es ist ein `enabled`-Schalter, der nur durch Client-Ehrlichkeit geschützt ist. | Niedrig (Single-Admin) | `server.ts:492–564` |
| S6 | **`express.json({ limit: '26mb' })` global.** Vergrößert die Angriffsfläche für Speicher-DoS auf allen Routen, obwohl nur TTS/Transkription große Uploads brauchen. | Niedrig | `server.ts:109` |
| S7 | **`.zip`-Dateien im Repository.** `.gitignore` schließt `*.zip` aus, aber die CI scannt getrackte Archive — es sind aktuell keine getrackt (gut). Kein Handlungsbedarf, aber als Invariante dokumentieren. | Info | CI |

---

## 6. Fehler und fehlende Komponenten

### 6.1 Fehler

| # | Fehler | Beleg |
| --- | --- | --- |
| F1 | **Divergierende Typdefinitionen.** `types/zero.ts` (Frontend) und `src/types/zero.ts` (Server) unterscheiden sich: Letztere enthält zusätzlich `'DERZEIT NICHT VERFÜGBAR'` (FreeTierClassification) und `'Bildgenerierung nicht verfügbar'` (FilmScene-Status). Der Server sendet diese Werte, das Frontend-Typ kennt sie nicht. | `diff types/zero.ts src/types/zero.ts` |
| F2 | **Fehlende UI-Abdeckung für neue Status.** `components/StatusLabel.tsx` kennt `BROWSER TEST ERFORDERLICH` (Typ nicht in `types/zero.ts`), behandelt aber keinen der neuen Werte explizit; `ModelHubView.tierColor()` gibt für `'DERZEIT NICHT VERFÜGBAR'` nur die Fallback-Farbe zurück. | `StatusLabel.tsx`, `ModelHubView.tsx:394` |
| F3 | **README beschreibt 12-Phasen-Plan korrekt** (Roadmap vorhanden). Positiver Befund, kein Fehler. | `server/store.ts:135` |
| F4 | **README-Struktur stimmt nicht mit dem Repository überein.** Das README listet `src/components/`, `src/lib/`, `src/App.tsx`, `src/index.css`, `src/main.tsx`, `src/assets/images/` und `backups/`. Real liegen `components/`, `lib/`, `App.tsx`, `index.css`, `main.tsx` im **Root**, `src/` enthält nur `types/`, und `backups/` sowie `src/assets/` existieren nicht. | `README.md` §1 |
| F5 | **Hartkodierter Produktionshost.** `zero-ai-studio.onrender.com` steht an 3 Stellen im iOS-Code. Domainwechsel = Swift-Änderung + neues IPA. | `ios/**/*.swift` |
| F6 | **`package-lock.json` nicht getrackt**, aber `bun.lock` ist getrackt. Zwei Paketmanager, unklarer kanonischer Lockfile. `package.json` hat kein `engines`-Feld trotz dokumentierter Node-22-Anforderung. | Repo-Root |
| F7 | **Referenzierte Assets liegen nicht am erwarteten Pfad.** Code referenziert `/src/assets/images/*.jpg`, die Dateien liegen aber im Root (`char_elena_vance_*.jpg` usw.). `src/assets/` existiert nicht. | `store.ts`, mehrere Views |
| F8 | **5,9 MB Haupt-Bundle.** `dist/assets/lib-*.js` = 5,95 MB (2,1 MB gzip) durch statischen `@google/genai`-Import; zusätzlich ein 6,1 MB `webllmWorker`-Chunk. | Build-Ausgabe |

### 6.2 Fehlende Komponenten

- **Native iOS-Modellgewichte** (0,07–2,6 GB) und Runtime-Bindings (CoreML/MLX/MediaPipe/whisper.cpp/Piper/Kokoro) — dokumentiert.
- **Tokenizers/Backends** für die Swift-Adapter — dokumentiert.
- **Signierter Gerätetest** auf iPhone 16 Pro Max — dokumentiert.
- **Object Storage** für große Medien (PostgreSQL-BYTE/JSONB stößt an Grenzen) — im README erwähnt.
- **Automatisierungs-Ausführung:** `/api/automation/run` erzeugt nur einen Plan; es gibt keine Modul-Executoren. Ehrlich kommentiert.
- **Bildgenerierung:** kein verifizierter kostenloser Provider — Route gibt hart `503` zurück.
- **Video-Generierung ohne GPU-Worker:** nur Timeline-Komposition, keine generative Video-KI.

---

## 7. Priorisierte Verbesserungsvorschläge

### P0 — sofort (Korrektheit & Hygiene)

1. **Toten Code entfernen.** Alle Root-Duplikate (`.ts`, `.tsx`, `.swift`, `Package.swift`) löschen. Danach `npm run ci:verify`. Erwartetes Ergebnis: kleinerer Diff, keine Verhaltensänderung.
2. **Typen vereinheitlichen.** `types/zero.ts` und `src/types/zero.ts` zu einer einzigen Quelle zusammenführen (z. B. `src/types/zero.ts`) und alle Importe umstellen. Frontend-Typ um `'DERZEIT NICHT VERFÜGBAR'` und `'Bildgenerierung nicht verfügbar'` ergänzen.
3. **Globale Express-Fehlerbehandlung** hinzufügen: 4-Argument-Middleware plus `process.on('unhandledRejection')` und `process.on('uncaughtException')`. Alternativ alle Routen in einen `asyncHandler`-Wrapper packen.

### P1 — kurzfristig (Robustheit & Sicherheit)

4. **`trust proxy` konfigurieren** (auf die tatsächliche Anzahl Proxy-Hops) und das Login-Limit korrekt pro Client-IP auswerten.
5. **Sicherheitsheader** via `helmet` oder manuell setzen: CSP (Self + `fonts.googleapis.com`/`fonts.gstatic.com`), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
6. **`express.json`-Limit pro Route** differenzieren: global klein (z. B. 1 MB), große Limits nur für `/api/audio/*`.
7. **Produktionshost konfigurierbar machen:** iOS-App-URL über Build-Setting/`Info.plist` statt hartkodiert; Bridge erlaubt eine konfigurierbare Host-Liste.
8. **Asset-Pfade korrigieren** (`/src/assets/images/…` → tatsächlicher Pfad) oder Verzeichnis anlegen und Bilder verschieben. Sonst sind Startprojekt-Bilder und Charakter-Referenzen im Browser 404.

### P2 — mittelfristig (Qualität & Performance)

9. **Lockfile-Politik klären:** entweder `package-lock.json` tracken (npm ist der dokumentierte Runner) und `bun.lock` entfernen — oder umgekehrt. `engines.node` ergänzen.
10. **Bundle aufteilen:** `@google/genai` und `@mlc-ai/web-llm` in separate manuelle Chunks, damit der Erststart nicht 5,9 MB lädt. WebLLM ist bereits lazy, aber der Hauptchunk ist es nicht.
11. **`types/zero.ts`-Divergenz durch eine Schema-Validierung absichern** (z. B. Zod) für `/api/*`-Payloads — schützt vor stillen Formfehlern zwischen Client und Server.
12. **Tests erweitern:** Es gibt Tests für `filmLimits`, `audioUtils`, `mediaUtils`, `srt`, `zeroRouter`, `geminiClient`, PWA und WebGPU-State — aber **keine** für `zipExporter` (CRC32/Roundtrip), `store` (Backup/Restore/Pruning) oder `persistence` (Postgres-Migration). Diese sind sicherheitskritisch.
13. **README an Realität angleichen** (Verzeichnisstruktur, `backups/`, Asset-Pfade).

### P3 — langfristig (Roadmap)

14. **Native iOS-Modelle fertigstellen:** Gewichte bündeln, Runtime-Bindings verlinken, Gerätetest, dann Status `Ready for Deployment` freischalten.
15. **Object Storage** für Medien, um PostgreSQL-BYTE/JSONB-Grenzen zu vermeiden.
16. **Automatisierungs-Executoren** für die geplanten Schritte (aktuell nur Plan-Erzeugung).
17. **CSRF-Token** für zustandsändernde Routen, falls Mehrmandanten- oder Subdomänenbetrieb geplant ist.

---

## 8. Bewertung der Auftragskriterien

| Kriterium | Bewertung |
| --- | --- |
| **iPhone-first** | ✅ Erfüllt. Bottom-Tab-Bar, Safe-Area, 44-px-Touchziele, PWA-Manifest, Apple-Icons, iOS-Viewport-Meta. |
| **Dauerhaft kostenlos** | ✅ Architektonisch erzwungen. Fail-closed Budget-Guard, Paid-Sperrliste, kein Fallback. Einzige Einschränkung: Gemini-Free-Tier ist kontingentbegrenzt und erfordert eigenen Key. |
| **Open Source** | ⚠️ Teilweise. Code ist offen; das empfohlene WebGPU-Modell (Llama 3.2) nutzt die Meta-Community-Lizenz (keine OSI-Lizenz). Das ist korrekt im README vermerkt. |
| **Keine kostenpflichtigen Fallbacks** | ✅ Erfüllt und CI-getestet. |
| **Video max. 60 Sekunden** | ✅ Doppelt erzwungen: `clampScenesToMax60Seconds()` serverseitig + Runtime-Stop im Kompositor. CI prüft den 60-s-Cap über 16 Szenen. |

---

## 9. Verifikationsprotokoll

Alle Angaben dieses Berichts wurden am 16.11.2026 im Repository reproduziert:

```text
npm install --no-audit --no-fund   → 209 Pakete installiert
npm run lint (tsc --noEmit)        → OK (keine Fehler)
npm test                           → OK (8 Testdateien bestanden)
npm run build (vite build)         → OK (Bundle erzeugt, Chunk-Warnung 5,9 MB)
```

Externe Verifikation der Modell-IDs/Kostenklassen gegen `ai.google.dev/gemini-api/docs/models` und `/docs/pricing`.

**Nicht verändert:** Es wurde kein bestehender Produktionscode geändert. Dieser PR enthält ausschließlich diesen Bericht.

---

## Anhang A — Vollständige Liste der verwaisten Root-Dateien

```text
adapters.ts              api.ts                 coremlAdapter.ts
geminiClient.ts          modelCatalog.ts        modelRegistry.ts
store.ts                 zipExporter.ts         localAudioSynth.ts
localImageProcessor.ts   localVideoCompositor.ts iosCoreMLBridge.ts
MusicStudioView.tsx      ProjectsCharactersView.tsx SettingsView.tsx
StatusLabel.tsx          VideoStudioView.tsx    zero.ts
Package.swift            KokoroMLXAudioAdapter.swift
LlamaCoreMLAdapter.swift LlamaCoreMLConfig.swift MLXSwiftTextAdapter.swift
MediaPipeGemmaAdapter.swift PiperONNXAdapter.swift WhisperMetalAdapter.swift
ZeroWKWebViewBridge.swift
```

## Anhang B — Routenübersicht (58 registrierte Handler)

`/api/auth/*` (3), `/api/health` (1), `/api/system/*` (13), `/api/models/*` (10), `/api/brain/*` (3), `/api/web/research` (1), `/api/image/*` (2), `/api/audio/*` (2), `/api/music/compose` (1), `/api/video/engine/*` (4), `/api/film/*` (2), `/api/projects/*` (6), `/api/characters` (2), `/api/memory/*` (4), `/api/automation/*` (3).

## Anhang C — Modellkatalog (45 Einträge)

**FREE CLOUD (14):** 4 Gemini-Text (`gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`), 2 Gemini-TTS, 1 Gemini-Transkription, 1 Gemini-Embedding, 1 Gemini-Grounding, 1 Paid-Gesperrtes (`gemini-4-argon`), 4 deaktivierte ohne verifizierten kostenlosen Provider (`gpt-oss-20b-free`, `flux-1-schnell-free`, `sd-turbo-free`, `sana-free`).

**LOCAL ON-DEVICE (24):** 11 WebLLM/WebGPU-Textmodelle, 3 lokale Browser-Kreativ-Engines (`zero-canvas-img2img`, `zero-timeline-video-60s`, `zero-webaudio-synth`), Apple Web Speech, Apple Foundation Model, 8 native iOS-Modelle über 7 Swift-Adapter (CoreML/MLX/MediaPipe/whisper.cpp/Piper/Kokoro — nicht deploymentbereit).

**SELF-HOSTED (7):** `mistral-small-3-24b`, `sdxl-coreml-ios`, `wan-2.1-14b`, `ltx-video`, `cogvideox-5b`, `hunyuan-video`, `musicgen-small` — alle als „NICHT KOMPATIBEL" bzw. GPU-abhängig klassifiziert.

**Kategorien:** Text & Reasoning 24, Sprache & Audio 7, Bildgenerierung 5, Videogenerierung 5, Musik & SFX 2, Embeddings & Suche 2.

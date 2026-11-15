# ZERO AI STUDIO v1.1.8 — 15.11.2026

## Änderungen
- Mobile Hauptnavigation auf sechs Bereiche umgestellt: Übersicht, Erstellen, Projekte, Modelle, Bibliothek und Setup.
- iPhone-Navigation mit rotem Aktivindikator, Safe-Area-Abstand und größerer Touch-Zone versehen.
- Projektverwaltung um Suche und Statusfilter erweitert.
- Projektkarten um Vorschaubereich, Statuskennzeichnung und Asset-/Szenen-Metadaten ergänzt.
- Nicht verifizierte Gemini-4-Hydrogen-Modell-ID durch die offizielle Gemini-3.8-Flash-Modell-ID ersetzt.
- Vorab als funktionierend markierte Gemini-Modelle auf „Live-Test erforderlich“ zurückgesetzt.
- README um aktuelle Provider- und Free-Tier-Einschränkungen ergänzt.

## Prüfung
- ZIP-Ausgangsarchiv war intakt.
- TypeScript/TSX-Parserprüfung: keine Syntaxfehler in 56 geprüften Dateien.
- Vollständiger TypeScript-Check und Produktions-Build konnten nicht ausgeführt werden, da die Projektabhängigkeiten in dieser Umgebung nicht installiert werden konnten (npm install lief in ein Zeitlimit; `vite/client` fehlt).

## Bekannte offene Punkte
- Gemini API-Key muss vom Betreiber konfiguriert werden; kostenloses Kontingent ist begrenzt.
- Pollinations-Generierung erfordert inzwischen API-Key; kostenlose Verfügbarkeit und Kontingente sind nicht garantiert.
- Native iOS-CoreML/MLX-Modelle benötigen weiterhin einen echten Xcode-Build und Modellgewichte; die Web-Bridge-Prüfung allein beweist keine lokale Inferenz.

# ZERO AI STUDIO auf einem iPhone installieren (kostenloser Testweg)

Der iOS-App-Host wird in GitHub Actions als **unsignierte IPA** gebaut. iOS installiert eine unsignierte IPA nicht direkt. Für einen persönlichen Test kannst du sie auf deinem Windows-PC mit AltStore Classic und deiner eigenen Apple-ID signieren.

## Was du brauchst

- Windows 10 oder neuer
- dein iPhone und ein USB-Kabel
- deine eigene Apple-ID
- AltStore Classic und AltServer (kostenlos)
- die aktuelle Datei `ZEROAIStudio-unsigned.ipa` aus dem GitHub-Actions-Artefakt

**Wichtig:** Ein kostenlos signiertes iPhone-App-Build läuft nach 7 Tagen ab. Du musst es dann mit AltServer/AltStore erneut signieren. Ein kostenloses Apple-Konto erlaubt höchstens drei gleichzeitig sideloaded Apps. Das ist eine Apple-Beschränkung, keine ZERO-Gebühr.

## 1. IPA aus GitHub Actions laden

1. Öffne das GitHub-Repository und gehe zu **Actions**.
2. Öffne den neuesten erfolgreichen Lauf von **ZERO Native iOS App Build**.
3. Lade das Artefakt **ZEROAIStudio-unsigned-IPA** herunter.
4. Entpacke das Artefakt. Darin liegt `ZEROAIStudio-unsigned.ipa`.

GitHub hält das IPA-Artefakt 90 Tage vor. Danach kannst du den Workflow unter Actions mit **Run workflow** erneut starten, um eine neue IPA zu erzeugen.

## 2. AltStore auf Windows installieren

1. Folge der offiziellen [AltStore-Windows-Anleitung](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows).
2. Installiere iTunes und iCloud direkt von Apple, nicht aus dem Microsoft Store, falls AltStore dies für deine Windows-Konfiguration verlangt.
3. Installiere AltServer, starte es als Administrator und erlaube den Zugriff im privaten Windows-Netzwerk.
4. Verbinde dein iPhone per USB, entsperre es und bestätige **Diesem Computer vertrauen**.
5. Aktiviere in iTunes die WLAN-Synchronisierung.
6. Wähle in AltServer **Install AltStore** und dein iPhone.
7. Gib deine Apple-ID nur direkt in AltServer ein. Teile dein Passwort niemals in Chat, GitHub oder mit ZERO.

## 3. ZERO IPA installieren

1. Öffne AltStore auf dem iPhone.
2. Gehe zu **My Apps** und tippe auf **+**.
3. Wähle `ZEROAIStudio-unsigned.ipa`.
4. Warte, bis AltStore die App mit deiner Apple-ID signiert und installiert hat.
5. Falls iOS es verlangt, aktiviere **Einstellungen → Datenschutz & Sicherheit → Entwicklermodus** und starte das iPhone neu.
6. Vertraue anschließend dem Entwicklerprofil unter **Einstellungen → Allgemein → VPN & Geräteverwaltung**.

## 4. Kostenlos aktuell halten

- AltStore Classic kann Apps im Hintergrund erneuern, wenn AltServer auf deinem Windows-PC läuft und iPhone und PC im selben WLAN sind.
- Andernfalls musst du die App vor Ablauf der 7 Tage manuell erneut signieren.
- Wenn die Signatur abläuft, öffnet sich ZERO erst wieder nach dem Erneuern.
- Für diesen persönlichen Test ist kein kostenpflichtiges Apple-Developer-Abo erforderlich.

## Funktionsgrenzen

- Der native App-Host lädt die Web-App von Render; eine Internetverbindung ist zum Starten der Oberfläche erforderlich.
- Apple Foundation Models benötigt iOS 26+, aktivierte Apple Intelligence und ein verfügbares deutsches On-Device-Modell.
- Der native Host und Swift-Adapter sind im Simulator gebaut. Die tatsächliche Installation und Modellinferenz auf deinem iPhone müssen noch getestet werden.
- WebGPU Llama kann unabhängig davon auch in unterstütztem Safari laufen; es ist kein Grund, die native App zu installieren.
- Dies ist ein persönlicher Entwicklungs-/Testweg, keine App-Store-Veröffentlichung.

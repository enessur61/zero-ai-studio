import { useState } from 'react';
import {
  ArchiveRestore,
  CheckCircle2,
  FileArchive,
  HardDriveDownload,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unlock,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type {
  BackupConfigState,
  BudgetGuardState,
  SystemBackupMeta,
  ZipBackupVersion,
} from '../types/zero.ts';

interface SettingsViewProps {
  budgetGuard: BudgetGuardState;
  initialBackups: SystemBackupMeta[];
  initialBackupConfig: BackupConfigState;
  initialExcludedSecrets: string[];
  onRestored: () => void;
}

export function SettingsView({
  budgetGuard,
  initialBackups,
  initialBackupConfig,
  initialExcludedSecrets,
  onRestored,
}: SettingsViewProps) {
  const [backups, setBackups] = useState<SystemBackupMeta[]>(initialBackups);
  const [note, setNote] = useState('Sicherheitsbackup vor iOS-Export');
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Versioned ZIP Backup & Export Center state
  const [backupConfig, setBackupConfig] = useState<BackupConfigState>(initialBackupConfig);
  const [zipChangelog, setZipChangelog] = useState(
    'Vollständiges Projekt-Backup (Frontend, Backend, Modelle, Assets & DB)'
  );
  const [creatingZip, setCreatingZip] = useState(false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [restoringZipId, setRestoringZipId] = useState<string | null>(null);
  const [protectingZipId, setProtectingZipId] = useState<string | null>(null);
  const [deletingZipId, setDeletingZipId] = useState<string | null>(null);
  const [exportManifest, setExportManifest] = useState<{
    fileCount: number;
    sizeBytes: number;
    verified: boolean;
    files: string[];
  } | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [testingGemini, setTestingGemini] = useState(false);
  const [geminiDiagnostic, setGeminiDiagnostic] = useState<{
    ok: boolean;
    apiKeyConfigured: boolean;
    freeTierGuardEnabled: boolean;
    googleConnection: string;
    modelResponse: string;
    modelId: string;
    responseVerified?: boolean;
    paidFallback: boolean;
    message: string;
  } | null>(null);

  const totalZipStorageBytes = backupConfig.zipBackups.reduce((sum, b) => sum + b.sizeBytes, 0);

  async function handleGeminiConnectionTest() {
    if (testingGemini) return;
    setTestingGemini(true);
    setGeminiDiagnostic(null);
    setErrorMsg(null);
    try {
      const result = await apiRequest<{
        ok: boolean;
        apiKeyConfigured: boolean;
        freeTierGuardEnabled: boolean;
        googleConnection: string;
        modelResponse: string;
        modelId: string;
        responseVerified?: boolean;
        paidFallback: boolean;
        message: string;
      }>('/api/system/gemini-connection-test', { method: 'POST' });
      setGeminiDiagnostic(result);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gemini-Verbindungstest fehlgeschlagen');
    } finally {
      setTestingGemini(false);
    }
  }

  async function handleInspectManifest() {
    setLoadingManifest(true);
    setErrorMsg(null);
    try {
      const data = await apiRequest<{
        fileCount: number;
        sizeBytes: number;
        verified: boolean;
        files: string[];
      }>('/api/system/export-manifest');
      setExportManifest(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Dateiprüfung fehlgeschlagen');
    } finally {
      setLoadingManifest(false);
    }
  }

  async function handleCreateVersionedZip() {
    if (creatingZip) return;
    setCreatingZip(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const data = await apiRequest<{
        backup: ZipBackupVersion;
        backupConfig: BackupConfigState;
      }>('/api/system/zip-backups', {
        method: 'POST',
        body: JSON.stringify({ changelog: zipChangelog }),
      });
      setBackupConfig(data.backupConfig);
      setStatusMsg(
        `Versioniertes ZIP-Backup v${data.backup.version} (${data.backup.fileCount} Dateien, CRC32 verifiziert & geschützt) erstellt.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'ZIP-Backup fehlgeschlagen');
    } finally {
      setCreatingZip(false);
    }
  }

  async function handleToggleAutoZip() {
    if (togglingAuto) return;
    setTogglingAuto(true);
    setErrorMsg(null);
    try {
      const next = !backupConfig.autoZipOnChange;
      const data = await apiRequest<{ backupConfig: BackupConfigState }>(
        '/api/system/zip-backups/settings',
        {
          method: 'POST',
          body: JSON.stringify({ autoZipOnChange: next }),
        }
      );
      setBackupConfig(data.backupConfig);
      setStatusMsg(
        next
          ? 'Automatische ZIP-Versionierung bei Projektänderungen aktiviert.'
          : 'Automatische ZIP-Versionierung pausiert.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Einstellung konnte nicht gespeichert werden');
    } finally {
      setTogglingAuto(false);
    }
  }

  async function handleToggleProtectZip(id: string) {
    setProtectingZipId(id);
    setErrorMsg(null);
    try {
      const data = await apiRequest<{ backup: ZipBackupVersion }>(
        `/api/system/zip-backups/${id}/protect`,
        { method: 'POST' }
      );
      setBackupConfig((prev) => ({
        ...prev,
        zipBackups: prev.zipBackups.map((b) => (b.id === id ? data.backup : b)),
      }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Schutz-Status konnte nicht geändert werden');
    } finally {
      setProtectingZipId(null);
    }
  }

  async function handleDeleteZip(id: string) {
    setDeletingZipId(id);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const data = await apiRequest<{ backupConfig: BackupConfigState }>(
        `/api/system/zip-backups/${id}`,
        { method: 'DELETE' }
      );
      setBackupConfig(data.backupConfig);
      setStatusMsg('Ungeschützte ZIP-Version entfernt.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Löschen blockiert');
    } finally {
      setDeletingZipId(null);
    }
  }

  async function handleRestoreZip(b: ZipBackupVersion) {
    if (restoringZipId) return;
    setRestoringZipId(b.id);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const data = await apiRequest<{
        restoredVersion: string;
        safetyBackup: ZipBackupVersion;
        backupConfig: BackupConfigState;
      }>(`/api/system/zip-backups/${b.id}/restore`, { method: 'POST' });
      setBackupConfig(data.backupConfig);
      setStatusMsg(
        `Version v${data.restoredVersion} erfolgreich wiederhergestellt. Vorab-Sicherheitsbackup v${data.safetyBackup.version} automatisch gesichert.`
      );
      onRestored();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'ZIP-Wiederherstellung fehlgeschlagen');
    } finally {
      setRestoringZipId(null);
    }
  }

  async function handleBackup() {
    setCreating(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const data = await apiRequest<{ backup: SystemBackupMeta }>('/api/system/backup', {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      setBackups((prev) => [data.backup, ...prev]);
      setStatusMsg(`JSON-Backup "${data.backup.filename}" erfolgreich gespeichert.`);
    } finally {
      setCreating(false);
    }
  }

  async function handleRestore(id: string) {
    setRestoringId(id);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      await apiRequest('/api/system/restore', {
        method: 'POST',
        body: JSON.stringify({ backupId: id }),
      });
      setStatusMsg('JSON-Backup erfolgreich wiederhergestellt.');
      onRestored();
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">SETTINGS, BACKUP & EXPORT</h1>
        <p className="text-xs text-slate-400 mt-1">
          Versioniertes ZIP-Backup-Center · Verbindliche 0 € Schranken · iPhone 16 Pro Max Architektur
        </p>
      </div>

      {statusMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
          {statusMsg}
        </div>
      )}
      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {errorMsg}
        </div>
      )}

      {/* SETTINGS -> GEMINI CONNECTION DIAGNOSTIC */}
      <section className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-mono text-sky-400">SYSTEM · LIVE CONNECTION CHECK</p>
            <h2 className="text-lg font-semibold text-white mt-1">Google Gemini-Verbindung</h2>
            <p className="text-xs text-slate-400 mt-1">
              Echter Server-Test mit gemini-3.8-flash. Der API-Schlüssel bleibt geheim; kostenpflichtige Fallbacks sind ausgeschlossen.
            </p>
          </div>
          <button
            type="button"
            onClick={handleGeminiConnectionTest}
            disabled={testingGemini}
            className="min-h-[44px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-xs font-medium inline-flex items-center justify-center gap-2 shrink-0"
          >
            {testingGemini ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {testingGemini ? 'Verbindung wird geprüft…' : 'Gemini-Verbindung testen'}
          </button>
        </div>
        {geminiDiagnostic && (
          <div className="rounded-xl bg-[#090B10] border border-white/[0.08] p-4 space-y-3">
            <div className="flex items-center gap-2">
              {geminiDiagnostic.ok
                ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                : <ShieldAlert className="w-5 h-5 text-rose-400" />}
              <span className={geminiDiagnostic.ok ? 'text-emerald-300 font-semibold text-sm' : 'text-rose-300 font-semibold text-sm'}>
                {geminiDiagnostic.ok ? 'Gemini-Verbindung erfolgreich' : 'Gemini-Verbindung nicht bestätigt'}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between gap-3"><span className="text-slate-400">API-Schlüssel vorhanden</span><span className="text-white">{geminiDiagnostic.apiKeyConfigured ? 'Ja' : 'Nein'}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">0-€-Schutz aktiv</span><span className="text-white">{geminiDiagnostic.freeTierGuardEnabled ? 'Ja' : 'Nein'}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Google-Verbindung</span><span className="text-white">{geminiDiagnostic.googleConnection}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Modellantwort</span><span className="text-white">{geminiDiagnostic.modelResponse}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Modell</span><span className="text-white font-mono">{geminiDiagnostic.modelId}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Kostenpflichtiger Fallback</span><span className="text-emerald-300">{geminiDiagnostic.paidFallback ? 'Nicht ausgeschlossen' : 'Ausgeschlossen'}</span></div>
            </div>
            <p className="text-xs text-slate-300">{geminiDiagnostic.message}</p>
          </div>
        )}
      </section>

      {/* SETTINGS -> PROJECT BACKUP & EXPORT */}
      <section className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <p className="text-xs font-mono text-sky-400">
              SETTINGS · PROJECT BACKUP & EXPORT
            </p>
            <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2 mt-1">
              <FileArchive className="w-5 h-5 text-sky-400" />
              Versionierte ZIP-Sicherung & Vollständiger Export
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Aktuelle Projektversion:{' '}
              <span className="font-mono text-white">v{backupConfig.currentVersion}</span> ·
              Archivierter Speicher:{' '}
              <span className="font-mono text-white">
                {(totalZipStorageBytes / (1024 * 1024)).toFixed(2)} MB
              </span>{' '}
              · Letzte Verifizierung:{' '}
              <span className="font-mono text-emerald-400">
                {backupConfig.lastVerifiedAt
                  ? new Date(backupConfig.lastVerifiedAt).toLocaleString('de-DE')
                  : 'Bereit'}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleToggleAutoZip}
              disabled={togglingAuto}
              className={`min-h-[42px] px-3.5 rounded-xl border text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap ${
                backupConfig.autoZipOnChange
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                  : 'bg-[#090B10] border-white/[0.1] text-slate-300'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Auto-ZIP: {backupConfig.autoZipOnChange ? 'Aktiv' : 'Aus'}
            </button>

            <button
              type="button"
              onClick={handleInspectManifest}
              disabled={loadingManifest}
              className="min-h-[42px] px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white inline-flex items-center gap-2 whitespace-nowrap"
            >
              {loadingManifest && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Dateiliste prüfen
            </button>

            <a
              href="/api/system/export-zip"
              download={`ZERO_AI_STUDIO_v${backupConfig.currentVersion}.zip`}
              className="min-h-[42px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-xs font-medium text-white inline-flex items-center gap-2 whitespace-nowrap"
            >
              <HardDriveDownload className="w-4 h-4" />
              Aktuelles ZIP herunterladen (v{backupConfig.currentVersion})
            </a>
          </div>
        </div>

        {/* Create new versioned ZIP backup */}
        <div className="p-4 rounded-xl bg-[#090B10] border border-white/[0.08] flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={zipChangelog}
            onChange={(e) => setZipChangelog(e.target.value)}
            placeholder="Changelog / Änderungsnotiz für diese ZIP-Version..."
            className="flex-1 min-h-[44px] bg-[#11151E] border border-white/[0.1] rounded-xl px-3.5 text-xs text-white focus:outline-none focus:border-[#2563EB]"
          />
          <button
            type="button"
            onClick={handleCreateVersionedZip}
            disabled={creatingZip}
            className="min-h-[44px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-xs font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
          >
            {creatingZip ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FileArchive className="w-4 h-4" />
            )}
            Neue ZIP-Version erstellen & prüfen
          </button>
        </div>

        {exportManifest && (
          <div className="p-3.5 rounded-xl bg-[#090B10] border border-white/[0.07] space-y-2">
            <p className="text-xs text-slate-300 font-mono">
              {exportManifest.fileCount} Dateien ·{' '}
              {(exportManifest.sizeBytes / (1024 * 1024)).toFixed(2)} MB · CRC32:{' '}
              {exportManifest.verified ? 'VERIFIZIERT' : 'FEHLER'}
            </p>
            <div className="max-h-36 overflow-y-auto text-[11px] font-mono text-slate-400 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
              {exportManifest.files.map((f) => (
                <div key={f} className="truncate">
                  {f}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Excluded Secrets Notice */}
        <div className="p-3.5 rounded-xl bg-[#090B10] border border-white/[0.06] text-xs text-slate-400 space-y-1">
          <p className="text-slate-200 font-medium inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Geheimnis-Schutz & Wiederherstellungs-Sicherheit
          </p>
          <p>
            Vor jeder Wiederherstellung prüft ZERO CORE das ZIP (PKZIP/CRC32 + Pflichtdateien) und legt automatisch ein geschütztes Sicherheitsbackup an. Aus Sicherheitsgründen ausgeschlossen:{' '}
            <span className="font-mono text-slate-300">
              {initialExcludedSecrets.join(' · ')}
            </span>
          </p>
        </div>

        {/* Versioned ZIP Backups History */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">
              Historische ZIP-Versionen ({backupConfig.zipBackups.length})
            </h3>
            <span className="text-[11px] text-slate-500">
              Geschützte Backups werden niemals überschrieben oder gelöscht
            </span>
          </div>

          {backupConfig.zipBackups.length === 0 ? (
            <p className="text-xs text-slate-500 py-3">
              Noch keine versionierte ZIP-Datei im Verlauf gespeichert — klicke oben auf „Neue ZIP-Version erstellen & prüfen“.
            </p>
          ) : (
            <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
              {backupConfig.zipBackups.map((z) => (
                <div
                  key={z.id}
                  className="p-3.5 rounded-xl bg-[#090B10] border border-white/[0.08] flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-slate-400">
                      <span className="font-mono font-semibold text-white">v{z.version}</span>
                      <span>·</span>
                      <span className="font-mono">
                        {new Date(z.createdAt).toLocaleString('de-DE')}
                      </span>
                      <span>·</span>
                      <span>
                        {z.trigger === 'manual'
                          ? 'Manuell'
                          : z.trigger === 'pre_restore'
                            ? 'Vor-Restore Sicherheit'
                            : 'Auto-ZIP'}
                      </span>
                      <span>·</span>
                      <span className="font-mono">
                        {z.fileCount} Dateien · {(z.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                      </span>
                      <span>·</span>
                      <span className={z.verified ? 'text-emerald-400' : 'text-rose-400'}>
                        {z.verified ? 'CRC32 Verifiziert' : 'Ungeprüft'}
                      </span>
                      {z.protected && (
                        <>
                          <span>·</span>
                          <span className="text-sky-400">Geschützt</span>
                        </>
                      )}
                    </div>
                    <p className="text-slate-200 truncate">{z.changelog}</p>
                    <p className="text-[11px] font-mono text-slate-500 truncate">{z.filename}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <a
                      href={`/api/system/zip-backups/${z.id}/download`}
                      download={z.filename}
                      className="min-h-[38px] px-3 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-medium inline-flex items-center gap-1.5"
                    >
                      <HardDriveDownload className="w-3.5 h-3.5" />
                      Download
                    </a>

                    <button
                      type="button"
                      onClick={() => handleRestoreZip(z)}
                      disabled={restoringZipId === z.id}
                      className="min-h-[38px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-slate-200 inline-flex items-center gap-1.5"
                    >
                      {restoringZipId === z.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ArchiveRestore className="w-3.5 h-3.5" />
                      )}
                      Wiederherstellen
                    </button>

                    <button
                      type="button"
                      onClick={() => handleToggleProtectZip(z.id)}
                      disabled={protectingZipId === z.id}
                      className="min-h-[38px] px-2.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 inline-flex items-center gap-1"
                      title={z.protected ? 'Schutz aufheben' : 'Backup schützen'}
                    >
                      {z.protected ? (
                        <Lock className="w-3.5 h-3.5 text-sky-400" />
                      ) : (
                        <Unlock className="w-3.5 h-3.5 text-slate-400" />
                      )}
                      {z.protected ? 'Geschützt' : 'Schützen'}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteZip(z.id)}
                      disabled={z.protected || deletingZipId === z.id}
                      className="min-h-[38px] px-2.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-35 text-rose-300 inline-flex items-center gap-1"
                      title={
                        z.protected
                          ? 'Geschützte Versionen können nicht gelöscht werden'
                          : 'Ungeschützte ZIP-Version löschen'
                      }
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Budget Guard + JSON Backups */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white inline-flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              0 € Kosten- und Sicherheitssystem
            </h2>
            <span className="font-mono text-sm text-emerald-400">
              {budgetGuard.totalSpentEur.toFixed(2).replace('.', ',')} € / 0,00 €
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-[#090B10] border border-white/[0.07]">
              <span className="text-slate-400 block">Kostenpflichtige Anbieter</span>
              <span className="text-emerald-400 font-medium mt-0.5 block">
                {budgetGuard.paidProvidersDisabled ? 'Dauerhaft deaktiviert' : 'Aktiv'}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#090B10] border border-white/[0.07]">
              <span className="text-slate-400 block">Bezahlte Fallbacks</span>
              <span className="text-emerald-400 font-medium mt-0.5 block">
                {budgetGuard.autoFallbackDisabled ? 'Strikt blockiert' : 'Erlaubt'}
              </span>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-white/[0.06]">
            <h3 className="text-xs font-semibold text-slate-300">Free-Tier Kontingent-Überwachung</h3>
            {Object.entries(budgetGuard.freeQuotaUsage).map(([modelId, q]) => (
              <div key={modelId} className="flex items-center justify-between text-xs">
                <span className="text-slate-300 font-mono truncate">{modelId}</span>
                <span className="font-mono tabular-nums text-slate-400">
                  {q.requestsToday} / {q.dailySoftLimit} {q.exhausted ? '(GESTOPPT)' : '(OK)'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* JSON Snapshot Backup & Restore */}
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4">
          <h2 className="text-base font-semibold text-white">Datenbank-Snapshots (JSON)</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="flex-1 min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
            />
            <button
              onClick={handleBackup}
              disabled={creating}
              className="min-h-[42px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {creating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <HardDriveDownload className="w-3.5 h-3.5" />
              )}
              Snapshot erstellen
            </button>
          </div>

          <div className="space-y-2 max-h-[210px] overflow-y-auto">
            {backups.length === 0 ? (
              <p className="text-xs text-slate-500 py-4">
                Noch kein JSON-Snapshot in dieser Sitzung angelegt (Initial-Snapshot liegt unter backups/initial-snapshot.json).
              </p>
            ) : (
              backups.map((b) => (
                <div
                  key={b.id}
                  className="p-3 rounded-xl bg-[#090B10] border border-white/[0.07] flex items-center justify-between gap-3 text-xs"
                >
                  <div>
                    <p className="font-medium text-white">{b.note}</p>
                    <p className="text-slate-500 font-mono">
                      {b.filename} · {(b.sizeBytes / 1024).toFixed(1)} KB
                    </p>
                  </div>
                  <button
                    onClick={() => handleRestore(b.id)}
                    disabled={restoringId === b.id}
                    className="min-h-[36px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 inline-flex items-center gap-1.5 shrink-0"
                  >
                    <ArchiveRestore className="w-3.5 h-3.5" />
                    Laden
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Audit Log & iOS SwiftUI Bridge */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3">
          <h2 className="text-base font-semibold text-white">Sicherheits- & Budget-Protokoll</h2>
          <div className="space-y-2 max-h-[260px] overflow-y-auto">
            {budgetGuard.auditLog.slice(0, 12).map((ev) => (
              <div
                key={ev.id}
                className="py-2 border-b border-white/[0.06] last:border-b-0 text-xs flex items-start justify-between gap-3"
              >
                <div>
                  <p className="font-medium text-slate-200">
                    {ev.action} · <span className="font-mono text-slate-400">{ev.modelId}</span>
                  </p>
                  <p className="text-slate-400 mt-0.5">{ev.reason}</p>
                </div>
                <span
                  className={`font-mono shrink-0 ${
                    ev.decision === 'ERLAUBT_0_EUR' ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {ev.costEur.toFixed(2)} €
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3">
          <h2 className="text-base font-semibold text-white inline-flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-sky-400" />
            Native iPhone 16 Pro Max Zielarchitektur (Phase 12)
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            ZERO ist für die iPhone-Bedienung optimiert. Unter <span className="font-mono text-white">ios/ZeroCoreML/</span> liegen native Swift-Adapter und eine WKWebView-Bridge als Quellcode. Das ist noch kein installierbares iOS-App-Bundle und wird deshalb nicht als einsatzbereit markiert.
          </p>
          <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-5">
            <li>WebGPU Llama 3.2 1B: experimenteller lokaler Browser-Chat in Safari 26+; ca. 705 MB Erstdownload und ca. 879 MB GPU-Speicher, ohne API-Kosten.</li>
            <li>Apple Foundation Models: iOS-26+-Adapter und nativer ZERO-WKWebView-App-Host vorhanden; Apple Intelligence, signierte Installation und echter iPhone-Gerätetest sind noch erforderlich.</li>
            <li>Weitere CoreML-/MLX-Textmodelle sowie Whisper, Piper und Kokoro: Swift-Adapter-Quellcode vorhanden; Modellgewichte und vollständige native Runtime fehlen noch.</li>
            <li>Video: lokaler Browser-Timeline-Editor mit Full-HD-Export und harter 60-Sekunden-Grenze; keine neuronale KI-Videogenerierung.</li>
          </ul>
          <div className="pt-2 border-t border-white/[0.06] text-[11px] text-slate-400 inline-flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>
              Ehrlicher Status: Der Swift-Paket-Build prüft nur, ob der Quellcode kompiliert. Das native XcodeGen-App-Target ist vorhanden und der Simulator-Build besteht; eine signierte Installation und echte iPhone-Gerätetests fehlen noch. Die Web-Version kann CoreML-/MLX-Modelle nicht direkt starten; das WebGPU-Llama-Modell läuft davon unabhängig lokal im Browser.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

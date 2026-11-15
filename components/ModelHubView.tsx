import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Play, Power, RefreshCw, Rocket, Search } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { isNativeIOSCoreMLAvailable } from '../lib/iosCoreMLBridge.ts';
import {
  type IOSRuntimeSuiteInfo,
  ModelRegistry,
  type RegistryVerificationResult,
} from '../lib/modelRegistry.ts';
import type {
  ExecutionMode,
  FreeTierClassification,
  ModelCategory,
  ModelDefinition,
} from '../types/zero.ts';
import { StatusLabel } from './StatusLabel.tsx';
import {
  checkWebGPULocalModelSupport,
  generateWebGPULocalChat,
  isWebGPULocalModelLoaded,
  loadWebGPULocalModel,
  WEBGPU_LOCAL_MODEL_DOWNLOAD_MB,
  WEBGPU_LOCAL_MODEL_ID,
  WEBGPU_LOCAL_MODEL_VRAM_MB,
} from '../lib/webgpuLocalModel.ts';
import { IPhoneRuntimePanel } from './IPhoneRuntimePanel.tsx';

interface ModelHubViewProps {
  models: ModelDefinition[];
  onModelUpdated: (updated: ModelDefinition) => void;
  onModelsReplaced?: (models: ModelDefinition[]) => void;
}

const FREE_TIER_LABELS: Array<'ALLE' | FreeTierClassification> = [
  'ALLE',
  'DAUERHAFT KOSTENLOS (LOKAL)',
  'DAUERHAFT KOSTENLOS (OPEN CLOUD)',
  'EINGESCHRÄNKT KOSTENLOS (FREE TIER)',
  'HARDWARE / SERVER ERFORDERLICH',
  'GESPERRT (KOSTENPFLICHTIG)',
];

export function ModelHubView({
  models,
  onModelUpdated,
  onModelsReplaced,
}: ModelHubViewProps) {
  const [search, setSearch] = useState('');
  const [execFilter, setExecFilter] = useState<'ALLE' | ExecutionMode>('ALLE');
  const [catFilter, setCatFilter] = useState<'ALLE' | ModelCategory>('ALLE');
  const [tierFilter, setTierFilter] = useState<'ALLE' | FreeTierClassification>('ALLE');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [registeringCoreML, setRegisteringCoreML] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [iosRuntime, setIosRuntime] = useState<IOSRuntimeSuiteInfo | null>(null);
  const [registryReport, setRegistryReport] = useState<RegistryVerificationResult | null>(null);
  const [webGpuSupported, setWebGpuSupported] = useState<boolean | null>(null);
  const [webGpuMessage, setWebGpuMessage] = useState('Noch nicht geprüft.');
  const [webGpuLoading, setWebGpuLoading] = useState(false);
  const [webGpuProgress, setWebGpuProgress] = useState(0);
  const [webGpuProgressText, setWebGpuProgressText] = useState('');
  const [webGpuLoaded, setWebGpuLoaded] = useState(isWebGPULocalModelLoaded());
  const webGpuProbeRef = useRef(false);
  const nativeBridgeActive = isNativeIOSCoreMLAvailable();

  async function verifyAndActivateLoadedWebGpuModel() {
    if (!isWebGPULocalModelLoaded() || webGpuProbeRef.current) return;
    webGpuProbeRef.current = true;
    try {
      const probe = await generateWebGPULocalChat([
        { role: 'user', content: 'Antworte exakt mit dem Wort BEREIT.' },
      ]);
      if (!probe.trim()) throw new Error('Das Modell hat auf den lokalen Inferenztest nicht geantwortet.');
      const data = await apiRequest<{ model: ModelDefinition }>('/api/models/webgpu/activate', {
        method: 'POST',
        body: JSON.stringify({ probeResponse: probe.slice(0, 1000) }),
      });
      onModelUpdated(data.model);
      setWebGpuLoaded(true);
      setWebGpuMessage('WebGPU-Modell geladen und echter lokaler Inferenztest erfolgreich. ZERO hat es automatisch aktiviert und gespeichert.');
    } catch (err) {
      setWebGpuMessage(err instanceof Error ? err.message : 'Lokaler Inferenztest fehlgeschlagen.');
      webGpuProbeRef.current = false;
    }
  }

  useEffect(() => {
    if (webGpuLoaded) void verifyAndActivateLoadedWebGpuModel();
    // The browser runtime is a shared singleton; verify it once when the Hub opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registryRef = useRef<ModelRegistry>(new ModelRegistry(models));

  useEffect(() => {
    registryRef.current.syncFromList(models);
  }, [models]);

  const verifyAndRegisterLlama = useCallback(
    async (announceFeedback: boolean) => {
      setRegisteringCoreML(true);
      try {
        const result = await registryRef.current.verifyAndRegisterLlama32();
        setIosRuntime(result.iosRuntime);
        setRegistryReport(result);

        if (onModelsReplaced) {
          onModelsReplaced(result.allModels);
        } else {
          result.registeredModels.forEach((m) => onModelUpdated(m));
        }

        if (announceFeedback) {
          const readyNames = result.registeredModels
            .map((m) => `${m.id} (${m.status})`)
            .join(', ');
          setFeedback(
            `ModelRegistry Prüfung abgeschlossen (${result.latencyMs} ms): ${readyNames}.`
          );
        }
      } catch (err) {
        if (announceFeedback) {
          setFeedback(
            err instanceof Error
              ? err.message
              : 'ModelRegistry Adapter-Prüfung fehlgeschlagen'
          );
        }
      } finally {
        setRegisteringCoreML(false);
      }
    },
    [onModelUpdated, onModelsReplaced]
  );

  useEffect(() => {
    void verifyAndRegisterLlama(false);
    // Run dynamic adapter verification & Llama 3.2 registration on Hub mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categories = useMemo(() => {
    const set = new Set<ModelCategory>(models.map((m) => m.category));
    return ['ALLE', ...Array.from(set)] as Array<'ALLE' | ModelCategory>;
  }, [models]);

  const filtered = useMemo(() => {
    return models.filter((m) => {
      if (execFilter !== 'ALLE' && m.executionMode !== execFilter) return false;
      if (catFilter !== 'ALLE' && m.category !== catFilter) return false;
      if (tierFilter !== 'ALLE' && m.freeTierType !== tierFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          m.name.toLowerCase().includes(q) ||
          m.family.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          m.license.toLowerCase().includes(q) ||
          m.capabilities.some((c) => c.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [models, execFilter, catFilter, tierFilter, search]);

  async function handleLoadWebGpuModel() {
    if (webGpuLoading || webGpuLoaded) return;
    setWebGpuLoading(true);
    setWebGpuProgress(0);
    setFeedback(null);
    try {
      const support = await checkWebGPULocalModelSupport();
      setWebGpuSupported(support.supported);
      setWebGpuMessage(support.message);
      if (!support.supported) throw new Error(support.message);
      await loadWebGPULocalModel((progress) => {
        setWebGpuProgress(progress.progress);
        setWebGpuProgressText(progress.text);
      });
      setWebGpuLoaded(true);
      await verifyAndActivateLoadedWebGpuModel();
      setFeedback(
        webGpuProbeRef.current
          ? 'Llama 3.2 1B wurde lokal geladen und der Inferenztest gestartet.'
          : 'Llama 3.2 1B wurde lokal geladen. ZERO prüft jetzt die lokale Inferenz.'
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'WebGPU-Modell konnte nicht geladen werden.');
    } finally {
      setWebGpuLoading(false);
    }
  }

  async function handleTest(model: ModelDefinition) {
    setTestingId(model.id);
    setFeedback(null);
    try {
      const updated = await registryRef.current.verifyAndRegisterModel(model.id);
      onModelUpdated(updated);
      setFeedback(`${updated.name}: ${updated.lastTestMessage}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Test fehlgeschlagen');
    } finally {
      setTestingId(null);
    }
  }

  async function handleTestAll() {
    if (testingAll) return;
    setTestingAll(true);
    setFeedback(null);
    try {
      const data = await registryRef.current.verifyAndRegisterAll();
      if (onModelsReplaced) {
        onModelsReplaced(data.models);
      } else {
        data.models.forEach((m) => onModelUpdated(m));
      }
      const okCount = data.models.filter(
        (m) =>
          m.status === 'FUNKTIONIERT' ||
          m.status === 'LOKAL INSTALLIERT'
      ).length;
      setFeedback(
        `Komplettprüfung abgeschlossen: ${okCount}/${data.testedCount} Modelle erfolgreich getestet (0,00 €).`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Komplettprüfung fehlgeschlagen');
    } finally {
      setTestingAll(false);
    }
  }

  async function handleToggle(model: ModelDefinition) {
    setTogglingId(model.id);
    setFeedback(null);
    try {
      const data = await apiRequest<{ model: ModelDefinition }>(`/api/models/${model.id}/toggle`, {
        method: 'POST',
      });
      onModelUpdated(data.model);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Umschalten blockiert');
    } finally {
      setTogglingId(null);
    }
  }

  function tierColor(tier?: FreeTierClassification): string {
    if (tier === 'DAUERHAFT KOSTENLOS (LOKAL)') return 'text-emerald-400';
    if (tier === 'DAUERHAFT KOSTENLOS (OPEN CLOUD)') return 'text-sky-400';
    if (tier === 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)') return 'text-amber-300';
    if (tier === 'GESPERRT (KOSTENPFLICHTIG)') return 'text-rose-400';
    return 'text-slate-400';
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">ZERO MODEL HUB</h1>
          <p className="text-xs text-slate-400 mt-1">
            Klare Trennung nach lokalen Werkzeugen, Gemini-Free-Tier (API-Key/Kontingent), nicht verfügbaren Providern, Hardware-Pflicht und gesperrten Bezahlanbietern.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleTestAll()}
          disabled={testingAll}
          className="min-h-[42px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-xs font-medium text-white inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
        >
          {testingAll ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          Alle Modelle prüfen
        </button>
      </div>

      {/* Browser-local WebGPU model, independent from the native iOS/CoreML package. */}
      <section className="bg-[#11151E] border border-sky-500/25 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-mono text-sky-300">ZERO LOCAL RUNTIME · WEBGPU</p>
            <h2 className="text-base font-semibold text-white">Llama 3.2 1B · direkt auf diesem iPhone</h2>
            <p className="text-xs text-slate-400">Modell-ID: {WEBGPU_LOCAL_MODEL_ID}</p>
            <p className="text-xs text-slate-300">Einmaliger Download: ca. {WEBGPU_LOCAL_MODEL_DOWNLOAD_MB} MB · geschätzter GPU-Speicher: {WEBGPU_LOCAL_MODEL_VRAM_MB} MB · kostenlos und lokal.</p>
          </div>
          <span className={`text-xs font-medium ${webGpuLoaded ? 'text-emerald-300' : webGpuSupported === false ? 'text-rose-300' : 'text-slate-300'}`}>
            {webGpuLoaded ? 'Lokal geladen' : webGpuLoading ? 'Wird geladen…' : webGpuSupported === false ? 'Nicht unterstützt' : 'Noch nicht geladen'}
          </span>
        </div>
        <p className="text-xs text-slate-300">{webGpuMessage}</p>
        {webGpuLoading && (
          <div className="space-y-1.5">
            <div className="h-2 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-sky-400 transition-all" style={{ width: `${Math.round(webGpuProgress * 100)}%` }} /></div>
            <p className="text-[11px] text-slate-400">{Math.round(webGpuProgress * 100)}% · {webGpuProgressText}</p>
          </div>
        )}
        <button type="button" onClick={() => void handleLoadWebGpuModel()} disabled={webGpuLoading || webGpuLoaded} className="min-h-[44px] px-4 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sm font-medium text-sky-200 disabled:opacity-50">
          {webGpuLoading ? 'Modell wird heruntergeladen…' : webGpuLoaded ? 'Modell ist geladen' : 'Kostenloses lokales Modell herunterladen & laden'}
        </button>
        <p className="text-[11px] text-amber-200/80">Hinweis: Der Download benötigt eine stabile WLAN-Verbindung und ausreichend freien Gerätespeicher. Safari kann große GPU-Modelle je nach iOS-Speicherverwaltung abbrechen; ein erfolgreicher Download allein gilt noch nicht als Inferenztest.</p>
      </section>

      {/* Filters */}
      <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="relative md:col-span-5">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Modelle durchsuchen (GPT-OSS, Qwen, FLUX, Sana, Whisper...)"
              className="w-full min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl pl-10 pr-4 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value as 'ALLE' | ModelCategory)}
            className="md:col-span-3 min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-slate-200 focus:outline-none focus:border-[#2563EB]"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c === 'ALLE' ? 'Alle Kategorien' : c}
              </option>
            ))}
          </select>

          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value as 'ALLE' | FreeTierClassification)}
            className="md:col-span-4 min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-slate-200 focus:outline-none focus:border-[#2563EB]"
          >
            {FREE_TIER_LABELS.map((t) => (
              <option key={t} value={t}>
                {t === 'ALLE' ? 'Alle Kosten-Klassen' : t}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(['ALLE', 'FREE CLOUD', 'LOCAL ON-DEVICE', 'SELF-HOSTED'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setExecFilter(mode)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                execFilter === mode
                  ? 'bg-[#2563EB] text-white'
                  : 'bg-[#090B10] text-slate-400 hover:text-white border border-white/[0.08]'
              }`}
            >
              {mode === 'ALLE' ? `Alle (${models.length})` : mode}
            </button>
          ))}
        </div>
      </div>

      <IPhoneRuntimePanel />

      {feedback && (
        <div className="p-3.5 rounded-xl bg-[#161B26] border border-white/[0.1] text-xs text-slate-200">
          {feedback}
        </div>
      )}

      {iosRuntime && (
        <div className="bg-[#11151E] border border-teal-500/25 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-mono text-teal-300 inline-flex items-center gap-1.5">
                <Rocket className="w-3.5 h-3.5" />
                ModelRegistry · ZERO Swift 6 Runtime ({iosRuntime.models.length} Modelladapter)
              </p>
              <h2 className="text-sm font-semibold text-white mt-0.5">
                Swift-Paket „{iosRuntime.packageRoot}“ —{' '}
                {iosRuntime.allFilesPresent
                  ? `Quellpaket vollständig geprüft (${iosRuntime.totalFilesChecked} Dateien) · Modellinferenz nicht bestätigt`
                  : 'Quellpaket unvollständig · Dateien fehlen'}
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono text-slate-300">
                WKWebView Bridge: {nativeBridgeActive ? 'Handler vorhanden' : 'Nicht verbunden (Web/PWA)'}
              </span>
              <button
                type="button"
                onClick={() => void verifyAndRegisterLlama(true)}
                disabled={registeringCoreML}
                className="min-h-[36px] px-3 rounded-lg bg-teal-500/15 hover:bg-teal-500/25 border border-teal-500/30 text-xs font-medium text-teal-300 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                {registeringCoreML ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Llama 3.2 prüfen & registrieren
              </button>
            </div>
          </div>

          <p className="text-xs text-slate-300">{iosRuntime.notes}</p>

          {registryReport && (
            <div className="text-[11px] font-mono text-emerald-300">
              Registry-Sync ({registryReport.latencyMs} ms):{' '}
              {registryReport.registeredModels
                .map((m) => `${m.id} = ${m.status}`)
                .join(' · ')}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-[11px] font-mono">
            {iosRuntime.files.map((f) => (
              <div
                key={f.path}
                className="p-2.5 rounded-xl bg-[#090B10] border border-white/[0.07] flex items-center justify-between gap-2"
              >
                <span className="truncate text-slate-300">{f.path.replace('ios/ZeroCoreML/', '')}</span>
                <span className={f.exists ? 'text-emerald-400 shrink-0 inline-flex items-center gap-1' : 'text-rose-400 shrink-0'}>
                  {f.exists && <CheckCircle2 className="w-3 h-3" />}
                  {(f.sizeBytes / 1024).toFixed(1)} KB
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Model List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {filtered.map((m) => (
          <div
            key={m.id}
            className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 flex flex-col justify-between gap-4"
          >
            <div className="space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-400">
                    {m.category} · {m.executionMode} · {m.version}
                  </p>
                  <h3 className="mt-1 text-base font-semibold text-white">{m.name}</h3>
                </div>
                <StatusLabel status={m.status} />
              </div>

              {m.freeTierType && (
                <p className={`text-xs font-medium ${tierColor(m.freeTierType)}`}>
                  {m.freeTierType}
                </p>
              )}

              <p className="text-xs text-slate-300 leading-relaxed">{m.iosNotes}</p>

              {/* Clean Zero-Pill Metadata Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-white/[0.06] text-xs">
                <div>
                  <span className="text-slate-500 block">Lizenz</span>
                  <span className="text-slate-200 truncate block">{m.license}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Größe / RAM</span>
                  <span className="text-slate-200 font-mono tabular-nums">
                    {m.sizeGB > 0
                      ? `${m.sizeGB} GB / ${m.ramRequirementGB} GB`
                      : m.executionMode === 'LOCAL ON-DEVICE'
                        ? 'Systemverwaltet'
                        : 'Cloud / Web'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">iOS-Kompatibilität</span>
                  <span className={m.iosCompatible ? 'text-emerald-400' : 'text-slate-400'}>
                    {m.iosCompatible ? 'Kompatibel' : 'GPU-Server nötig'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Kosten</span>
                  <span className="text-slate-200 font-mono tabular-nums">
                    {m.requiresPaidKey ? 'Gesperrt (Paid)' : '0,00 €'}
                  </span>
                </div>
              </div>

              <div className="space-y-1 pt-2 border-t border-white/[0.06] text-xs">
                <p className="text-slate-400">
                  <span className="text-slate-500">Fähigkeiten: </span>
                  {m.capabilities.join(' · ')}
                </p>
                {m.prerequisites && (
                  <p className="text-slate-400">
                    <span className="text-slate-500">Voraussetzung: </span>
                    {m.prerequisites}
                  </p>
                )}
                <p className="text-slate-400">
                  <span className="text-slate-500">Limits: </span>
                  {m.limitations}
                </p>
                <p className="text-slate-400">
                  <span className="text-slate-500">Testprotokoll: </span>
                  {m.lastTestMessage}
                  {m.lastTestLatencyMs !== null && (
                    <span className="font-mono text-slate-300 ml-2">
                      ({m.lastTestLatencyMs} ms)
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-3 border-t border-white/[0.06]">
              <button
                onClick={() => handleTest(m)}
                disabled={testingId === m.id}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {testingId === m.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Modell live testen
              </button>

              <button
                onClick={() => handleToggle(m)}
                disabled={togglingId === m.id || m.requiresPaidKey || !m.hasRealAdapter}
                className={`min-h-[42px] px-4 py-2 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                  m.enabled
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                    : 'bg-[#090B10] border border-white/[0.1] text-slate-300'
                }`}
              >
                <Power className="w-3.5 h-3.5" />
                {m.enabled ? 'Aktiviert' : 'Deaktiviert'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

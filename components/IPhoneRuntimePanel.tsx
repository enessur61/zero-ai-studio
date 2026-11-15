import { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw, Smartphone, Zap } from 'lucide-react';
import { isNativeIOSCoreMLAvailable, runNativeIOSDiagnostics } from '../lib/iosCoreMLBridge.ts';

type RuntimeCheck = {
  checked: boolean;
  isIOS: boolean;
  isSafari: boolean;
  isStandalone: boolean;
  webGPU: 'checking' | 'available' | 'unavailable' | 'error';
  webAssembly: boolean;
  hardwareThreads: number | null;
  nativeBridge: boolean;
  foundationModel: 'checking' | 'available' | 'unavailable' | 'not-native' | 'error';
  foundationModelMessage: string;
};

const initialState: RuntimeCheck = {
  checked: false,
  isIOS: false,
  isSafari: false,
  isStandalone: false,
  webGPU: 'checking',
  webAssembly: false,
  hardwareThreads: null,
  nativeBridge: false,
  foundationModel: 'not-native',
  foundationModelMessage: 'Apple Foundation Models benötigen die native ZERO-iOS-App.',
};

export function IPhoneRuntimePanel() {
  const [runtime, setRuntime] = useState<RuntimeCheck>(initialState);
  const [refreshing, setRefreshing] = useState(false);

  const inspectRuntime = useCallback(async () => {
    setRefreshing(true);
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown | null> };
      standalone?: boolean;
    };
    const ua = nav.userAgent;
    const isIOS =
      /iPhone|iPad|iPod/i.test(ua) ||
      (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1);
    const isSafari =
      /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
    let webGPU: RuntimeCheck['webGPU'] = 'unavailable';

    if (nav.gpu?.requestAdapter) {
      webGPU = 'checking';
      try {
        const adapter = await nav.gpu.requestAdapter();
        webGPU = adapter ? 'available' : 'unavailable';
      } catch {
        webGPU = 'error';
      }
    }

    const nativeBridge = isNativeIOSCoreMLAvailable();
    let foundationModel: RuntimeCheck['foundationModel'] = nativeBridge
      ? 'checking'
      : 'not-native';
    let foundationModelMessage = nativeBridge
      ? 'Prüfe Apple Intelligence und deutsche Modellverfügbarkeit …'
      : 'Nur in einer nativen ZERO-iOS-App verfügbar; Safari/PWA kann Foundation Models nicht direkt aufrufen.';

    if (nativeBridge) {
      try {
        const diagnostics = await runNativeIOSDiagnostics('apple-foundation-model');
        foundationModel =
          diagnostics.available && diagnostics.germanSupported ? 'available' : 'unavailable';
        foundationModelMessage =
          diagnostics.message || diagnostics.error || diagnostics.status || 'Keine Detaildiagnose verfügbar.';
      } catch (error) {
        foundationModel = 'error';
        foundationModelMessage =
          error instanceof Error ? error.message : 'Apple Foundation Models konnten nicht geprüft werden.';
      }
    }

    setRuntime({
      checked: true,
      isIOS,
      isSafari,
      isStandalone:
        Boolean(nav.standalone) ||
        window.matchMedia('(display-mode: standalone)').matches,
      webGPU,
      webGPUMessage,
      webGPUMaxStorageBufferMB,
      webAssembly: typeof WebAssembly === 'object',
      hardwareThreads: Number.isFinite(nav.hardwareConcurrency)
        ? nav.hardwareConcurrency
        : null,
      nativeBridge,
      foundationModel,
      foundationModelMessage,
    });
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void inspectRuntime();
  }, [inspectRuntime]);

  const rows = [
    {
      label: 'iPhone / iPad erkannt',
      value: runtime.isIOS ? 'Ja' : 'Nein / nicht erkennbar',
      good: runtime.isIOS,
    },
    {
      label: 'Native ZERO-iOS-Bridge',
      value: runtime.nativeBridge ? 'Verbunden' : 'Noch nicht verbunden',
      good: runtime.nativeBridge,
    },
    {
      label: 'Apple Foundation Model (Deutsch)',
      value:
        runtime.foundationModel === 'checking'
          ? 'Wird geprüft …'
          : runtime.foundationModel === 'available'
            ? 'Bereit · lokal'
            : runtime.foundationModel === 'unavailable'
              ? 'Nicht bereit'
              : runtime.foundationModel === 'error'
                ? 'Prüfung fehlgeschlagen'
                : 'Native App erforderlich',
      good: runtime.foundationModel === 'available',
    },
    {
      label: 'WebGPU-Grafikzugriff',
      value:
        runtime.webGPU === 'checking'
          ? 'Wird geprüft …'
          : runtime.webGPU === 'available'
            ? 'Verfügbar'
            : runtime.webGPU === 'error'
              ? 'Prüfung fehlgeschlagen'
              : 'Nicht verfügbar',
      good: runtime.webGPU === 'available',
    },
    {
      label: 'WebAssembly',
      value: runtime.webAssembly ? 'Verfügbar' : 'Nicht verfügbar',
      good: runtime.webAssembly,
    },
    {
      label: 'Browser',
      value: runtime.isSafari ? 'Safari' : 'Anderer Browser / WebView',
      good: runtime.isSafari,
    },
    {
      label: 'Zum Home-Bildschirm hinzugefügt',
      value: runtime.isStandalone ? 'Ja' : 'Nein',
      good: runtime.isStandalone,
    },
  ];

  return (
    <section className="rounded-2xl border border-sky-400/20 bg-[#11151E] p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 text-xs font-mono text-sky-300">
            <Smartphone className="h-3.5 w-3.5" />
            ZERO · IPHONE RUNTIME CHECK
          </p>
          <h2 className="mt-1 text-sm font-semibold text-white">
            Geräte- und Browserdiagnose
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            Prüft die tatsächlich verfügbaren Schnittstellen auf diesem Gerät.
            Eine verfügbare GPU-Schnittstelle bedeutet noch nicht, dass ein KI-Modell installiert ist.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void inspectRuntime()}
          disabled={refreshing}
          aria-label="iPhone-Fähigkeiten erneut prüfen"
          className="min-h-10 min-w-10 rounded-xl border border-white/10 bg-white/[0.04] text-slate-200 inline-flex items-center justify-center disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#090B10] px-3 py-2.5"
          >
            <span className="text-xs text-slate-400">{row.label}</span>
            <span className={`text-xs font-medium text-right ${row.good ? 'text-emerald-300' : 'text-amber-300'}`}>
              {row.value}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-xl bg-sky-400/[0.06] p-3">
        {runtime.webGPU === 'available' ? (
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
        ) : (
          <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
        )}
        <p className="text-[11px] leading-relaxed text-slate-300">
          {runtime.nativeBridge
            ? 'Die native Schnittstelle antwortet. ZERO kann jetzt die installierten lokalen Modelladapter separat prüfen.'
            : runtime.webGPU === 'available'
              ? 'Der Browser stellt WebGPU bereit. Für lokale KI-Ausführung müssen passende WebGPU-Modelle und ein kompatibler Inferenz-Runner noch eingebunden werden.'
              : 'Diese Web-Version kann native CoreML-/MLX-Modelle nicht direkt starten. Dafür ist eine native iOS-App mit verbundener ZERO-Bridge erforderlich.'}
          {runtime.hardwareThreads
            ? ` Erkannte logische CPU-Threads: ${runtime.hardwareThreads}.`
            : ''}
          {' '}WebGPU: {runtime.webGPUMessage} Apple-Modell: {runtime.foundationModelMessage}
        </p>
      </div>
    </section>
  );
}

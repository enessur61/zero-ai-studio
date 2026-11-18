import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Film, Loader2, Music, Play, Share2, Sparkles } from 'lucide-react';
import { renderTimelineVideoMax60s, type VideoRenderResult } from '../lib/localVideoCompositor.ts';
import type { FilmScene, StudioProject } from '../types/zero.ts';
import { loadSceneVideoClip, saveSceneVideoClip } from '../lib/sceneVideoStore.ts';

interface VideoStudioViewProps {
  projects: StudioProject[];
  activeProjectId?: string;
  soundtrack?: { url: string; title: string } | null;
}

export function VideoStudioView({ projects, activeProjectId, soundtrack }: VideoStudioViewProps) {
  const [selectedProjectId, setSelectedProjectId] = useState(
    activeProjectId || projects[0]?.id || ''
  );
  const currentProject = projects.find((p) => p.id === selectedProjectId) ?? projects[0];

  const [scenes, setScenes] = useState<FilmScene[]>(currentProject?.scenes ?? []);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('9:16');
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [includeVoiceovers, setIncludeVoiceovers] = useState(true);
  const [selectedAudioUrl, setSelectedAudioUrl] = useState<string>(soundtrack?.url ?? '');
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, label: '' });
  const [result, setResult] = useState<VideoRenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wanWorker, setWanWorker] = useState<{ online: boolean; status: string; message: string; gpuName: string | null; gpuVramTotalMb: number | null; gpuVramFreeMb: number | null; readiness: Array<{ id: string; label: string; ready: boolean; detail: string }> }>({ online: false, status: 'CHECKING', message: 'Prüfe Wan-GPU-Verbindung...', gpuName: null, gpuVramTotalMb: null, gpuVramFreeMb: null, readiness: [] });
  const [wanBusy, setWanBusy] = useState(false);
  const [wanJobId, setWanJobId] = useState<string | null>(null);
  const [wanJobState, setWanJobState] = useState<'idle' | 'queued' | 'running' | 'downloading' | 'stopped' | 'failed' | 'succeeded'>('idle');
  const wanAbortRef = useRef<AbortController | null>(null);
  const [wanProgress, setWanProgress] = useState('');
  const [wanClipUrl, setWanClipUrl] = useState<string | null>(null);
  const [wanClipScene, setWanClipScene] = useState('');


  useEffect(() => {
    let active = true;
    if (!currentProject) {
      setScenes([]);
      return () => { active = false; };
    }
    setScenes(currentProject.scenes);
    Promise.all(currentProject.scenes.map(async (scene) => {
      try {
        const blob = await loadSceneVideoClip(currentProject.id, scene.id);
        return blob ? { sceneId: scene.id, url: URL.createObjectURL(blob) } : null;
      } catch {
        return null;
      }
    })).then((restored) => {
      if (!active) {
        restored.forEach((item) => { if (item) URL.revokeObjectURL(item.url); });
        return;
      }
      const urls = new Map(restored.filter((item): item is { sceneId: string; url: string } => Boolean(item))
        .map((item) => [item.sceneId, item.url]));
      if (urls.size) {
        setScenes((previous) => previous.map((scene) => {
          const url = urls.get(scene.id);
          return url ? { ...scene, videoUrl: url, status: 'Szenenbereit' } : scene;
        }));
      }
    });
    return () => { active = false; };
  }, [selectedProjectId, currentProject]);

  useEffect(() => {
    if (soundtrack?.url) {
      setSelectedAudioUrl(soundtrack.url);
    }
  }, [soundtrack]);

  useEffect(() => {
    let active = true;
    fetch('/api/video/engine/status', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Wan-Status nicht verfügbar.');
        if (active) setWanWorker({
          online: payload.online === true,
          status: String(payload.status || 'UNKNOWN'),
          message: String(payload.message || 'Kein Status verfügbar.'),
          gpuName: typeof payload.gpuName === 'string' ? payload.gpuName : null,
          gpuVramTotalMb: typeof payload.gpuVramTotalMb === 'number' ? payload.gpuVramTotalMb : null,
          gpuVramFreeMb: typeof payload.gpuVramFreeMb === 'number' ? payload.gpuVramFreeMb : null,
          readiness: Array.isArray(payload.readiness) ? payload.readiness.filter((item: unknown) => item && typeof item === 'object' && typeof (item as { label?: unknown }).label === 'string').map((item: { id?: string; label: string; ready?: boolean; detail?: string }) => ({ id: String(item.id || item.label), label: item.label, ready: item.ready === true, detail: String(item.detail || '') })) : [],
        });
      })
      .catch((err) => {
        if (active) setWanWorker({ online: false, status: 'STATUS_ERROR', message: err instanceof Error ? err.message : 'Wan-Status konnte nicht geladen werden.', gpuName: null, gpuVramTotalMb: null, gpuVramFreeMb: null, readiness: [] });
      });
    return () => { active = false; };
  }, []);

  async function handleWanSceneGeneration(scene: FilmScene) {
    if (wanBusy || !wanWorker.online) return;
    const controller = new AbortController();
    wanAbortRef.current = controller;
    setWanBusy(true);
    setWanJobId(null);
    setWanJobState('queued');
    setWanProgress('Sende Szene an den Wan-GPU-Worker...');
    setError(null);
    setWanClipUrl(null);
    try {
      const prompt = (scene.videoPrompt || [scene.title, scene.location, scene.timeOfDay, scene.subtitleText].filter(Boolean).join('. ')).trim();
      if (prompt.length < 8) throw new Error('Für diese Szene fehlt ein ausreichender Video-Prompt.');
      const created = await fetch('/api/video/engine/jobs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.slice(0, 1800), aspectRatio }),
        signal: controller.signal,
      });
      const createdPayload = await created.json();
      if (!created.ok || typeof createdPayload.job?.id !== 'string') {
        throw new Error(createdPayload.error || 'Wan-Auftrag konnte nicht gestartet werden.');
      }
      const jobId = createdPayload.job.id as string;
      setWanJobId(jobId);
      setWanJobState('queued');
      setWanProgress('Wan 2.1 rendert den 5-Sekunden-Clip. Das kann mehrere Minuten dauern...');
      let completed = false;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            controller.signal.removeEventListener('abort', abort);
            resolve();
          };
          const timer = window.setTimeout(finish, 3000);
          const abort = () => {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', abort);
            reject(new DOMException('Überwachung beendet', 'AbortError'));
          };
          controller.signal.addEventListener('abort', abort, { once: true });
        });
        const statusResponse = await fetch(`/api/video/engine/jobs/${jobId}`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
        const statusPayload = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(statusPayload.error || 'Wan-Jobstatus konnte nicht geladen werden.');
        const job = statusPayload.job;
        if (job.status === 'failed') { setWanJobState('failed'); throw new Error(String(job.error || 'Wan-Generierung fehlgeschlagen.')); }
        setWanJobState(job.status === 'queued' ? 'queued' : 'running');
        if (job.status === 'succeeded') {
          setWanJobState('downloading');
          setWanProgress('MP4 wird auf ZERO übertragen...');
          const videoResponse = await fetch(`/api/video/engine/jobs/${jobId}/video`, { credentials: 'include', signal: controller.signal });
          if (!videoResponse.ok) throw new Error('Das fertige Wan-MP4 konnte nicht geladen werden.');
          const blob = await videoResponse.blob();
          if (!blob.type.includes('video') || blob.size < 1024) throw new Error('Der Wan-Worker lieferte keine gültige Videodatei.');
          const clipUrl = URL.createObjectURL(blob);
          setWanClipUrl(clipUrl);
          let persistedLocally = false;
          let persistedOnServer = false;
          let storagePersistent: boolean | null = null;
          let storageError = '';
          if (currentProject?.id) {
            try {
              const storageStatus = await saveSceneVideoClip(currentProject.id, scene.id, blob);
              persistedLocally = storageStatus.localSaved;
              persistedOnServer = storageStatus.serverPersisted === true;
              storagePersistent = storageStatus.persistent;
            } catch (saveError) {
              storageError = saveError instanceof Error ? saveError.message : 'Unbekannter Speicherfehler';
            }
          }
          setWanClipScene(scene.title);
          setScenes((previous) => previous.map((item) =>
            item.id === scene.id ? { ...item, videoUrl: clipUrl, status: 'Szenenbereit' } : item
          ));
          setWanProgress(persistedOnServer
            ? persistedLocally && storagePersistent === true
              ? 'Echter Wan-2.1-Clip fertig · lokal und dauerhaft im ZERO-Projekt gespeichert · geräteübergreifend verfügbar.'
              : 'Echter Wan-2.1-Clip fertig · dauerhaft im ZERO-Projekt gespeichert. Lokaler Browser-Cache ist nicht verfügbar oder nicht gegen Bereinigung geschützt.'
            : persistedLocally
              ? `Clip nur lokal gespeichert; Serversynchronisierung fehlgeschlagen. Bitte vor Gerätewechsel oder Neuladen exportieren. ${storageError}`
              : `Clip erzeugt, aber nicht dauerhaft gespeichert. Bitte sofort exportieren. ${storageError}`);
          setWanJobState('succeeded');
          completed = true;
          break;
        }
        setWanProgress(job.status === 'queued' ? 'Wan-Auftrag wartet auf die GPU...' : 'Wan 2.1 generiert den Clip...');
      }
      if (!completed) throw new Error('Wan-Generierung dauert ungewöhnlich lange. Der Auftrag kann im Worker weiterlaufen; bitte später den Status erneut prüfen.');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setWanJobState('stopped');
        setWanProgress('ZERO verfolgt diesen Auftrag nicht weiter. Der GPU-Worker kann ihn trotzdem weiter ausführen; eine serverseitige Abbruchfunktion ist derzeit nicht vorhanden.');
      } else {
        setWanJobState('failed');
        setError(err instanceof Error ? err.message : 'Wan-Clip konnte nicht generiert werden.');
        setWanProgress('');
      }
    } finally {
      if (wanAbortRef.current === controller) wanAbortRef.current = null;
      setWanBusy(false);
    }
  }


  const projectAudioAssets = (currentProject?.assets ?? []).filter(
    (a) => a.type === 'music' || a.type === 'audio'
  );
  const hasVoiceoverCount = scenes.filter((s) => Boolean(s.audioDataUrl)).length;

  const totalDuration = scenes.reduce((sum, s) => sum + s.durationSec, 0);
  const exceedsLimit = totalDuration > 60;

  async function handleImportSceneImages(files: FileList | null) {
    if (!files?.length || !scenes.length) return;
    const selected = Array.from(files).filter((file) => file.type.startsWith('image/')).slice(0, 10);
    if (!selected.length) {
      setError('Bitte wähle gültige Bilddateien aus.');
      return;
    }
    try {
      const optimized = await Promise.all(selected.map(async (file) => {
        if (file.size > 20 * 1024 * 1024) {
          throw new Error(`„${file.name}“ ist größer als 20 MB.`);
        }
        const source = await new Promise<HTMLImageElement>((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`„${file.name}“ konnte nicht geöffnet werden.`)); };
          img.src = url;
        });
        const scale = Math.min(1, 1920 / Math.max(source.width, source.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Bildverarbeitung ist auf diesem Gerät nicht verfügbar.');
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.84);
      }));
      setScenes((previous) => previous.map((scene, index) => ({
        ...scene,
        imageUrl: optimized[index % optimized.length],
        status: 'Bild bereit',
      })));
      setResult(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bilder konnten nicht importiert werden.');
    }
  }

  function updateSceneDuration(id: string, val: number) {
    const safeVal = Math.max(3, Math.min(30, val));
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, durationSec: safeVal } : s)));
  }

  function updateCamera(id: string, movement: FilmScene['cameraMovement']) {
    setScenes((prev) =>
      prev.map((s) => (s.id === id ? { ...s, cameraMovement: movement } : s))
    );
  }

  function clampTo58Seconds() {
    if (!scenes.length) return;
    const target = 58;
    const current = scenes.reduce((sum, s) => sum + s.durationSec, 0);
    if (current <= 60) return;
    const ratio = target / current;
    let sum = 0;
    setScenes((prev) =>
      prev.map((s, idx) => {
        if (idx === prev.length - 1) {
          return { ...s, durationSec: Math.max(4, target - sum) };
        }
        const d = Math.max(4, Math.floor(s.durationSec * ratio));
        sum += d;
        return { ...s, durationSec: d };
      })
    );
  }

  async function handleShareVideo() {
    if (!result) return;
    try {
      const response = await fetch(result.videoUrl);
      if (!response.ok) throw new Error('Der fertige Film konnte nicht geöffnet werden.');
      const blob = await response.blob();
      const extension = result.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const safeTitle = (currentProject?.title || 'zero-film').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 48);
      const file = new File([blob], `${safeTitle}.${extension}`, { type: result.mimeType });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: currentProject?.title || 'ZERO AI STUDIO Video',
          text: 'Erstellt mit ZERO AI STUDIO',
        });
        return;
      }
      const link = document.createElement('a');
      link.href = result.videoUrl;
      link.download = file.name;
      link.click();
      setError('Der Teilen-Dialog wird von diesem Browser nicht unterstützt. Der Download wurde gestartet; auf dem iPhone findest du die Datei normalerweise unter „Dateien“.');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Video konnte nicht geteilt werden.');
    }
  }

  async function handleExportVideo() {
    if (exceedsLimit || rendering || !scenes.length) return;
    setRendering(true);
    setError(null);
    setProgress({ pct: 2, label: 'Initialisiere Video-Pipeline...' });
    try {
      const rendered = await renderTimelineVideoMax60s({
        scenes,
        aspectRatio,
        burnSubtitles,
        audioUrl: selectedAudioUrl || undefined,
        includeSceneVoiceovers: includeVoiceovers,
        onProgress: (pct, label) => setProgress({ pct, label }),
      });
      setResult(rendered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Videoexport fehlgeschlagen');
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">ZERO VIDEO STUDIO</h1>
          <p className="text-xs text-slate-400 mt-1">
            Szenen-Schnitt, 1080p-Full-HD-Master, 24 fps, Untertitel & Audio-Mix · Harte Grenze: max. 60 Sekunden
          </p>
        </div>

        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          className="min-h-[44px] bg-[#11151E] border border-white/[0.1] rounded-xl px-3.5 text-sm text-white focus:outline-none focus:border-[#2563EB]"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Projekt: {p.title}
            </option>
          ))}
        </select>
      </div>

      {/* 60s Duration Guard Bar */}
      <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-white">
            Schnitt-Laufzeit (Zielbereich 55–60 Sekunden)
          </span>
          <span
            className={`text-sm font-mono tabular-nums font-semibold ${
              exceedsLimit ? 'text-rose-400' : totalDuration >= 55 ? 'text-emerald-400' : 'text-sky-400'
            }`}
          >
            {totalDuration.toFixed(1)} s / 60,0 s max
          </span>
        </div>

        <div className="h-2.5 w-full rounded-full bg-[#090B10] overflow-hidden border border-white/[0.06]">
          <div
            className={`h-full transition-all ${
              exceedsLimit ? 'bg-rose-500' : totalDuration >= 55 ? 'bg-emerald-500' : 'bg-[#2563EB]'
            }`}
            style={{ width: `${Math.min(100, (totalDuration / 60) * 100)}%` }}
          />
        </div>

        {exceedsLimit && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-rose-300">
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              Export blockiert: Gesamtlänge überschreitet das 60-Sekunden-Limit.
            </span>
            <button
              onClick={clampTo58Seconds}
              className="min-h-[38px] px-3 rounded-lg bg-rose-500 text-white font-medium"
            >
              Automatisch auf 58s kürzen
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Scene Timeline */}
        <div className="lg:col-span-7 space-y-3">
          <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-2">
            <label className="text-sm font-medium text-white block">Eigene Szenenbilder vom iPhone hinzufügen</label>
            <p className="text-xs text-slate-400">Wähle bis zu 10 Fotos oder Grafiken aus deiner Mediathek. ZERO verteilt sie automatisch auf die Szenen und nutzt sie für den Videoexport.</p>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                void handleImportSceneImages(event.target.files);
                event.currentTarget.value = '';
              }}
              className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#2563EB] file:px-3 file:py-2 file:text-white"
            />
          </div>
          <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-white">ZERO NEURAL VIDEO · Wan 2.1</span>
              <span className={`text-[10px] font-semibold rounded-full px-2 py-1 ${wanWorker.online ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {wanWorker.online ? 'GPU ONLINE' : 'GPU NICHT VERBUNDEN'}
              </span>
            </div>
            <p className="text-xs text-slate-400">{wanWorker.message}</p>
            {(wanWorker.gpuName || wanWorker.gpuVramTotalMb !== null) && (
              <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2.5 space-y-1">
                {wanWorker.gpuName && <p className="text-xs text-white">{wanWorker.gpuName}</p>}
                {wanWorker.gpuVramTotalMb !== null && <p className="text-[11px] text-slate-400">GPU-Speicher: {(wanWorker.gpuVramTotalMb / 1024).toFixed(1)} GB gesamt{wanWorker.gpuVramFreeMb !== null ? ` · ${(wanWorker.gpuVramFreeMb / 1024).toFixed(1)} GB frei` : ''}</p>}
              </div>
            )}
            {wanWorker.readiness.length > 0 && (
              <details className="rounded-lg border border-white/[0.08] bg-black/20 p-2.5">
                <summary className="cursor-pointer text-xs text-slate-300">Technische Bereitschaft ({wanWorker.readiness.filter((item) => item.ready).length}/{wanWorker.readiness.length})</summary>
                <ul className="mt-2 space-y-2">
                  {wanWorker.readiness.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 text-[11px]">
                      <span className={item.ready ? 'text-emerald-400' : 'text-amber-300'}>{item.ready ? '✓' : '•'}</span>
                      <span className="min-w-0"><span className="text-slate-200">{item.label}</span><span className="block text-slate-500">{item.detail}</span></span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-[11px] text-slate-500">Ein echter KI-Clip pro Auftrag · 5 Sekunden · 480p. Hinzugefügte Clips werden beim finalen Timeline-Export eingebettet. Kein kostenpflichtiger Fallback; die GPU muss separat bereitgestellt werden.</p>
            {wanBusy && <div className="space-y-2">
              <div className="text-xs text-sky-300 inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{wanProgress}</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-1/3 animate-pulse rounded-full bg-sky-400" /></div>
              {wanJobId && <p className="text-[10px] text-slate-500 break-all">Auftrags-ID: {wanJobId}</p>}
              <button type="button" onClick={() => wanAbortRef.current?.abort()} className="min-h-[40px] w-full rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 text-xs font-medium text-amber-200">Überwachung beenden</button>
            </div>}
            {!wanBusy && wanJobState === 'stopped' && <p className="text-xs text-amber-300">{wanProgress}</p>}
            {!wanBusy && wanJobState === 'failed' && <p className="text-xs text-rose-300">Auftrag fehlgeschlagen. Du kannst die Szene erneut starten.</p>}
            {!wanBusy && wanJobState === 'succeeded' && <p className="text-xs text-emerald-300">Auftrag abgeschlossen.</p>}
            {!wanBusy && wanProgress && <p className="text-xs text-emerald-300">{wanProgress}</p>}
            {wanClipUrl && (
              <div className="space-y-2">
                <p className="text-xs text-white">Fertiger KI-Clip: {wanClipScene}</p>
                <video src={wanClipUrl} controls playsInline className="w-full rounded-xl bg-black" />
                <a href={wanClipUrl} download="zero-wan-shot.mp4" className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-white/[0.08] px-3 text-xs text-white"><Download className="w-4 h-4" />Wan-MP4 herunterladen</a>
              </div>
            )}
          </div>
          {scenes.map((scene) => (
            <div
              key={scene.id}
              className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 flex flex-col sm:flex-row gap-4"
            >
              <div className="w-full sm:w-36 aspect-video rounded-xl overflow-hidden bg-[#090B10] border border-white/[0.07] shrink-0">
                {scene.imageUrl ? (
                  <img
                    src={scene.imageUrl}
                    alt={scene.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-slate-600">
                    Kein Frame
                  </div>
                )}
              </div>

              <div className="flex-1 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-slate-400">
                      Szene {scene.index} · {scene.location}
                    </p>
                    <h3 className="text-sm font-semibold text-white">{scene.title}</h3>
                  </div>
                  <span className="text-xs font-mono text-slate-300 tabular-nums">
                    {scene.durationSec}s
                  </span>
                </div>

                <p className="text-xs text-slate-300 line-clamp-2">{scene.subtitleText}</p>
                {scene.videoUrl && <p className="text-[10px] font-semibold text-emerald-300">NEURAL CLIP BEREIT · wird im finalen Export verwendet</p>}
                <button
                  type="button"
                  onClick={() => void handleWanSceneGeneration(scene)}
                  disabled={!wanWorker.online || wanBusy}
                  className="min-h-[38px] rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 text-[11px] font-medium text-violet-200 disabled:opacity-40 inline-flex items-center gap-2"
                >
                  {wanBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  {wanBusy ? 'Wan rendert...' : 'Echten 5s-Wan-Clip generieren'}
                </button>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <select
                    value={scene.cameraMovement}
                    onChange={(e) =>
                      updateCamera(scene.id, e.target.value as FilmScene['cameraMovement'])
                    }
                    className="min-h-[38px] bg-[#090B10] border border-white/[0.1] rounded-lg px-2.5 text-xs text-slate-200"
                  >
                    <option value="Langsamer Zoom-In">Langsamer Zoom-In</option>
                    <option value="Sanfter Zoom-Out">Sanfter Zoom-Out</option>
                    <option value="Schwenk Links">Schwenk Links</option>
                    <option value="Schwenk Rechts">Schwenk Rechts</option>
                    <option value="Vertikaler Tilt">Vertikaler Tilt</option>
                    <option value="Statisch">Statisch</option>
                  </select>

                  <div className="flex items-center gap-2 bg-[#090B10] border border-white/[0.1] rounded-lg px-2.5">
                    <span className="text-[11px] text-slate-400">Dauer:</span>
                    <input
                      type="number"
                      min={3}
                      max={30}
                      value={scene.durationSec}
                      onChange={(e) => updateSceneDuration(scene.id, Number(e.target.value))}
                      className="w-full bg-transparent text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Export & Player */}
        <div className="lg:col-span-5 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4 h-fit">
          <h2 className="text-base font-semibold text-white">Video-Export & Qualitätsprüfung</h2>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setAspectRatio('16:9')}
              className={`min-h-[42px] rounded-xl text-xs font-medium border transition-colors ${
                aspectRatio === '16:9'
                  ? 'bg-[#2563EB] border-[#2563EB] text-white'
                  : 'bg-[#090B10] border-white/[0.1] text-slate-300'
              }`}
            >
              16:9 Widescreen
            </button>
            <button
              onClick={() => setAspectRatio('9:16')}
              className={`min-h-[42px] rounded-xl text-xs font-medium border transition-colors ${
                aspectRatio === '9:16'
                  ? 'bg-[#2563EB] border-[#2563EB] text-white'
                  : 'bg-[#090B10] border-white/[0.1] text-slate-300'
              }`}
            >
              9:16 iPhone 16 Pro Max
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-slate-400 inline-flex items-center gap-1.5">
              <Music className="w-3.5 h-3.5" />
              Soundtrack-Audiospur (Music Studio / Projekt)
            </label>
            <select
              value={selectedAudioUrl}
              onChange={(e) => setSelectedAudioUrl(e.target.value)}
              className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-slate-200"
            >
              <option value="">Ohne Musik-Spur</option>
              {soundtrack && (
                <option value={soundtrack.url}>Music Studio: {soundtrack.title}</option>
              )}
              {projectAudioAssets.map((a) => (
                <option key={a.id} value={a.url}>
                  Projekt-Asset: {a.title}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-300 min-h-[36px] cursor-pointer">
            <input
              type="checkbox"
              checked={includeVoiceovers}
              onChange={(e) => setIncludeVoiceovers(e.target.checked)}
              className="rounded bg-[#090B10] border-white/20"
            />
            Szenen-Voiceover einmischen ({hasVoiceoverCount} / {scenes.length} Szenen vertont)
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-300 min-h-[36px] cursor-pointer">
            <input
              type="checkbox"
              checked={burnSubtitles}
              onChange={(e) => setBurnSubtitles(e.target.checked)}
              className="rounded bg-[#090B10] border-white/20"
            />
            Deutsche Untertitel direkt in das Video einbrennen
          </label>

          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          {rendering && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>{progress.label}</span>
                <span className="font-mono">{progress.pct}%</span>
              </div>
              <div className="h-2 rounded-full bg-[#090B10] overflow-hidden">
                <div
                  className="h-full bg-[#2563EB] transition-all"
                  style={{ width: `${progress.pct}%` }}
                />
              </div>
            </div>
          )}

          <button
            onClick={handleExportVideo}
            disabled={rendering || exceedsLimit || !scenes.length}
            className="w-full min-h-[46px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors"
          >
            {rendering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {rendering
              ? `Rendere (${totalDuration}s)...`
              : `Video rendern (${totalDuration}s · 0 €)`}
          </button>

          {result && (
            <div className="space-y-3 pt-3 border-t border-white/[0.08]">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="inline-flex items-center gap-1.5 text-emerald-400">
                  <Film className="w-3.5 h-3.5" />
                  Export fertig ({result.durationSec}s)
                </span>
                <span className="font-mono">
                  {(result.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                </span>
              </div>
              <video
                src={result.videoUrl}
                controls
                playsInline
                className="w-full rounded-xl bg-black border border-white/[0.08]"
              />
              <button
                type="button"
                onClick={() => void handleShareVideo()}
                className="w-full min-h-[46px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] border border-[#2563EB] text-xs font-semibold text-white inline-flex items-center justify-center gap-2"
              >
                <Share2 className="w-4 h-4" />
                Auf dem iPhone teilen oder sichern
              </button>
              <a
                href={result.videoUrl}
                download={`zero-film-${currentProject?.title || 'export'}.${
                  result.mimeType.includes('mp4') ? 'mp4' : 'webm'
                }`}
                className="w-full min-h-[44px] rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white inline-flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Videodatei herunterladen
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

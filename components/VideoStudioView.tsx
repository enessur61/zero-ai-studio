import { useEffect, useRef, useState } from 'react';
import { watchProjectVideoRecovery, type ProjectVideoRecoveryState } from '../lib/projectVideoRecovery.ts';
import { AlertTriangle, Download, Film, Loader2, Music, Play, Share2, Sparkles, Trash2 } from 'lucide-react';
import { renderTimelineVideoMax60s, type VideoRenderResult } from '../lib/localVideoCompositor.ts';
import type { FilmScene, StudioProject } from '../types/zero.ts';
import { deleteSceneVideoClip, loadSceneVideoClip, saveSceneVideoClip } from '../lib/sceneVideoStore.ts';
import { apiRequest } from '../lib/api.ts';

interface WanJobHistoryItem {
  id: string;
  status: string;
  scene_id?: string;
  created_at?: string;
  finished_at?: string;
  error?: string;
}

interface ProjectVideoHistoryItem {
  id: string;
  projectId: string;
  sceneId: string;
  jobId: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

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
  const [wanWorker, setWanWorker] = useState({ online: false, status: 'CHECKING', message: 'Prüfe Wan-GPU-Verbindung...' });
  const [wanBusy, setWanBusy] = useState(false);
  const [wanProgress, setWanProgress] = useState('');
  const [wanClipUrl, setWanClipUrl] = useState<string | null>(null);
  const archivedVideoRef = useRef<HTMLVideoElement | null>(null);
  const shouldResumeArchivedVideoRef = useRef(false);
  const recoveringArchivedVideoRef = useRef(false);
  const restoreArchivedVideoListenerRef = useRef<(() => void) | null>(null);
  const [videoRecoveryStatus, setVideoRecoveryStatus] = useState<ProjectVideoRecoveryState>('ready');
  const [wanClipScene, setWanClipScene] = useState('');
  const [videoHistory, setVideoHistory] = useState<ProjectVideoHistoryItem[]>([]);
  const [wanJobHistory, setWanJobHistory] = useState<WanJobHistoryItem[]>([]);
  const [videoHistoryError, setVideoHistoryError] = useState('');
  const [deletingClipId, setDeletingClipId] = useState<string | null>(null);

  // Safari may suspend media requests while the tab/app is backgrounded. Re-check
  // the authenticated byte-range endpoint on return/network recovery; never cache
  // the clip in a Blob or buffer it in JavaScript memory.
  useEffect(() => {
    if (!wanClipUrl?.startsWith('/api/projects/')) {
      setVideoRecoveryStatus('ready');
      return;
    }
    const video = archivedVideoRef.current;
    const onPlay = () => { shouldResumeArchivedVideoRef.current = true; };
    const onPause = () => {
      // iOS may pause media as the app is backgrounded; preserve playback intent
      // until the page is visible again. A user pause while visible is respected.
      if (!recoveringArchivedVideoRef.current && document.visibilityState !== 'hidden') {
        shouldResumeArchivedVideoRef.current = false;
      }
    };
    video?.addEventListener('play', onPlay);
    video?.addEventListener('pause', onPause);
    const stopRecovery = watchProjectVideoRecovery({
      url: wanClipUrl,
      mediaTarget: video ?? undefined,
      onState: setVideoRecoveryStatus,
      onResume: () => {
        if (!video) return;
        const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const shouldResumePlayback = shouldResumeArchivedVideoRef.current && !video.ended;
        recoveringArchivedVideoRef.current = true;
        if (restoreArchivedVideoListenerRef.current) {
          video.removeEventListener('loadedmetadata', restoreArchivedVideoListenerRef.current);
        }
        const restorePosition = () => {
          restoreArchivedVideoListenerRef.current = null;
          video.currentTime = position;
          if (shouldResumePlayback) {
            void video.play().catch(() => undefined).finally(() => {
              recoveringArchivedVideoRef.current = false;
            });
          } else {
            recoveringArchivedVideoRef.current = false;
          }
        };
        restoreArchivedVideoListenerRef.current = restorePosition;
        video.addEventListener('loadedmetadata', restorePosition, { once: true });
        video.load();
      },
    });
    return () => {
      stopRecovery();
      if (video && restoreArchivedVideoListenerRef.current) {
        video.removeEventListener('loadedmetadata', restoreArchivedVideoListenerRef.current);
        restoreArchivedVideoListenerRef.current = null;
      }
      video?.removeEventListener('play', onPlay);
      video?.removeEventListener('pause', onPause);
    };
  }, [wanClipUrl]);


  async function refreshVideoHistory(projectId: string) {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/videos`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) throw new Error('ZERO Clip-Historie konnte nicht geladen werden.');
    const payload = await response.json() as { assets?: ProjectVideoHistoryItem[] };
    setVideoHistory(Array.isArray(payload.assets) ? payload.assets : []);
  }

  async function refreshWanJobHistory(projectId: string) {
    const response = await fetch(`/api/video/engine/jobs?projectId=${encodeURIComponent(projectId)}`, {
      credentials: 'include', cache: 'no-store',
    });
    if (!response.ok) throw new Error('Wan-Auftragshistorie konnte nicht geladen werden.');
    const payload = await response.json() as { jobs?: WanJobHistoryItem[] };
    setWanJobHistory(Array.isArray(payload.jobs) ? payload.jobs : []);
  }

  async function restoreArchivedVideo(asset: ProjectVideoHistoryItem) {
    if (!currentProject?.id) return;
    // Keep the archived clip server-backed: Safari/iOS can request byte ranges
    // directly and does not need a second full-size Blob in browser memory.
    const clipUrl = `/api/projects/${encodeURIComponent(currentProject.id)}/videos/${encodeURIComponent(asset.id)}`;
    setWanClipUrl(clipUrl);
    const scene = currentProject.scenes.find((item) => item.id === asset.sceneId);
    setWanClipScene(scene?.title ?? 'Gespeicherter Clip');
    setScenes((previous) => previous.map((item) =>
      item.id === asset.sceneId ? { ...item, videoUrl: clipUrl, status: 'Szenenbereit' } : item
    ));
    setWanProgress('Clip aus der dauerhaften ZERO-Projektablage wiederhergestellt.');
  }

  async function deleteArchivedVideo(asset: ProjectVideoHistoryItem) {
    if (!currentProject?.id || deletingClipId) return;
    setDeletingClipId(asset.id);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(currentProject.id)}/videos/${encodeURIComponent(asset.id)}`,
        { method: 'DELETE', credentials: 'same-origin' }
      );
      if (!response.ok) throw new Error('Clip konnte nicht gelöscht werden.');
      const remaining = videoHistory.filter((item) => item.id !== asset.id);
      setVideoHistory(remaining);
      const nextForScene = remaining.filter((item) => item.sceneId === asset.sceneId);
      if (nextForScene.length) {
        await restoreArchivedVideo(nextForScene[0]);
      } else {
        await deleteSceneVideoClip(currentProject.id, asset.sceneId).catch(() => undefined);
        const scene = currentProject.scenes.find((item) => item.id === asset.sceneId);
        if (scene && wanClipScene === scene.title) {
          if (wanClipUrl) URL.revokeObjectURL(wanClipUrl);
          setWanClipUrl(null);
          setWanClipScene('');
        }
        setScenes((previous) => previous.map((item) =>
          item.id === asset.sceneId ? { ...item, videoUrl: undefined, status: item.imageUrl ? 'Bild bereit' : 'Entwurf' } : item
        ));
      }
      setVideoHistoryError('');
    } finally {
      setDeletingClipId(null);
    }
  }


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
    let active = true;
    const projectId = currentProject?.id;
    setVideoHistory([]);
    setWanJobHistory([]);
    setVideoHistoryError('');
    if (!projectId) return () => { active = false; };
    fetch(`/api/projects/${encodeURIComponent(projectId)}/videos`, {
      credentials: 'same-origin', cache: 'no-store',
    }).then(async (response) => {
      if (!response.ok) throw new Error('ZERO Clip-Historie konnte nicht geladen werden.');
      const payload = await response.json() as { assets?: ProjectVideoHistoryItem[] };
      if (active) setVideoHistory(Array.isArray(payload.assets) ? payload.assets : []);
    }).catch((historyError) => {
      if (active) setVideoHistoryError(historyError instanceof Error ? historyError.message : 'Clip-Historie nicht verfügbar.');
    });
    return () => { active = false; };
  }, [currentProject?.id]);

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
        });
      })
      .catch((err) => {
        if (active) setWanWorker({ online: false, status: 'STATUS_ERROR', message: err instanceof Error ? err.message : 'Wan-Status konnte nicht geladen werden.' });
      });
    return () => { active = false; };
  }, []);

  async function restoreWanJobVideo(jobId: string, scene: FilmScene, isActive: () => boolean = () => true) {
    const videoResponse = await fetch(`/api/video/engine/jobs/${jobId}/video`, { credentials: 'include', cache: 'no-store' });
    if (!videoResponse.ok) throw new Error('Das fertige Wan-MP4 konnte nicht geladen werden.');
    const blob = await videoResponse.blob();
    if (!blob.type.includes('video') || blob.size < 1024 || blob.size > 100 * 1024 * 1024) {
      throw new Error('Der Wan-Worker lieferte keine gültige Videodatei.');
    }
    if (!isActive()) return;
    const clipUrl = URL.createObjectURL(blob);
    setWanClipUrl(clipUrl);
    setWanClipScene(scene.title);
    setScenes((previous) => previous.map((item) =>
      item.id === scene.id ? { ...item, videoUrl: clipUrl, status: 'Szenenbereit' } : item
    ));
    try {
      const storageStatus = currentProject?.id
        ? await saveSceneVideoClip(currentProject.id, scene.id, blob, jobId)
        : null;
      if (!isActive()) return;
      if (storageStatus?.serverPersisted && currentProject?.id) {
        await refreshVideoHistory(currentProject.id).catch(() => undefined);
      }
      setWanProgress(storageStatus?.serverPersisted
        ? 'Wan-Clip wiederhergestellt · dauerhaft im ZERO-Projekt gespeichert und geräteübergreifend verfügbar.'
        : 'Wan-Clip aus dem persistenten Worker-Speicher wiederhergestellt. Der Clip bleibt über die gespeicherte Job-ID abrufbar.');
    } catch {
      if (isActive()) setWanProgress('Wan-Clip aus dem persistenten Worker-Speicher wiederhergestellt. Die zusätzliche ZERO-Projektsynchronisierung war nicht möglich.');
    }
  }

  async function waitForWanJob(jobId: string, scene: FilmScene, isActive: () => boolean = () => true) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 10000));
      if (!isActive()) return false;
      const statusResponse = await fetch(`/api/video/engine/jobs/${jobId}`, { credentials: 'include', cache: 'no-store' });
      const statusPayload = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(statusPayload.error || 'Wan-Jobstatus konnte nicht geladen werden.');
      const job = statusPayload.job;
      if (job.status === 'failed') throw new Error(String(job.error || 'Wan-Generierung fehlgeschlagen.'));
      if (job.status === 'succeeded') {
        setWanProgress('MP4 wird aus dem persistenten Wan-Speicher wiederhergestellt...');
        await restoreWanJobVideo(jobId, scene, isActive);
        return true;
      }
      setWanProgress(job.status === 'queued'
        ? 'Gespeicherter Wan-Auftrag wartet auf die GPU...'
        : 'Gespeicherter Wan-Auftrag läuft weiter...');
    }
    throw new Error('Wan-Generierung dauert ungewöhnlich lange. Der Auftrag bleibt gespeichert und kann später erneut aufgenommen werden.');
  }

  // On a fresh iPhone page load, discover jobs for this project from the
  // authenticated worker registry and resume polling without creating new work.
  useEffect(() => {
    let active = true;
    const projectId = currentProject?.id;
    if (!projectId) return () => { active = false; };
    (async () => {
      try {
        const response = await fetch(`/api/video/engine/jobs?projectId=${encodeURIComponent(projectId)}`, {
          credentials: 'include', cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = await response.json() as { jobs?: Array<{
          id: string; status: string; scene_id?: string; created_at?: string; finished_at?: string; error?: string;
        }> };
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        setWanJobHistory(jobs);
        const sceneById = new Map(currentProject?.scenes.map((scene) => [scene.id, scene]) ?? []);
        const resumable = jobs.filter((job) => sceneById.has(job.scene_id ?? '') &&
          ['queued', 'running'].includes(job.status));
        const completed = jobs.filter((job) => sceneById.has(job.scene_id ?? '') &&
          job.status === 'succeeded');
        // The worker returns newest-updated jobs first; restore only the latest
        // completed clip per scene so an older render cannot overwrite it.
        const latestCompletedByScene = new Map<string, typeof completed[number]>();
        for (const job of completed) {
          const sceneId = job.scene_id ?? '';
          if (!latestCompletedByScene.has(sceneId)) latestCompletedByScene.set(sceneId, job);
        }
        if (resumable.length) {
          setWanBusy(true);
          setWanProgress('Gespeicherte Wan-Aufträge werden nach dem erneuten Öffnen fortgesetzt...');
          for (const job of resumable) {
            if (!active) return;
            const scene = sceneById.get(job.scene_id ?? '');
            if (!scene) continue;
            await waitForWanJob(job.id, scene, () => active);
          }
          if (active) setWanBusy(false);
        }
        for (const job of latestCompletedByScene.values()) {
          if (!active) return;
          const scene = sceneById.get(job.scene_id ?? '');
          if (!scene || scene.videoUrl) continue;
          await restoreWanJobVideo(job.id, scene, () => active);
        }
      } catch (restoreError) {
        if (active) setWanProgress(restoreError instanceof Error
          ? `Gespeicherte Wan-Aufträge konnten nicht vollständig wiederhergestellt werden: ${restoreError.message}`
          : 'Gespeicherte Wan-Aufträge konnten nicht vollständig wiederhergestellt werden.');
      } finally {
        if (active) setWanBusy(false);
      }
    })();
    return () => { active = false; };
  }, [currentProject?.id]);

  async function handleWanSceneGeneration(scene: FilmScene) {
    if (wanBusy || !wanWorker.online || !currentProject?.id) return;
    setWanBusy(true);
    setWanProgress('Sende Szene idempotent an den Wan-GPU-Worker...');
    setError(null);
    setWanClipUrl(null);
    try {
      const prompt = (scene.videoPrompt || [scene.title, scene.location, scene.timeOfDay, scene.subtitleText].filter(Boolean).join('. ')).trim();
      if (prompt.length < 8) throw new Error('Für diese Szene fehlt ein ausreichender Video-Prompt.');
      const requestBody = JSON.stringify({
        prompt: prompt.slice(0, 1800),
        aspectRatio,
        projectId: currentProject.id,
        sceneId: scene.id,
      });
      const createdPayload = await apiRequest<{
        job: { id: string; status: string };
      }>('/api/video/engine/jobs', { method: 'POST', body: requestBody });
      if (typeof createdPayload.job?.id !== 'string') throw new Error('Wan-Auftrag konnte nicht gestartet werden.');
      setWanProgress('Wan 2.1 rendert den 5-Sekunden-Clip. Der Auftrag bleibt bei Verbindungsabbruch gespeichert...');
      const completed = await waitForWanJob(createdPayload.job.id, scene);
      if (!completed) throw new Error('Wan-Auftrag wird im Hintergrund fortgesetzt und kann später wieder aufgenommen werden.');
      await refreshWanJobHistory(currentProject.id).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wan-Clip konnte nicht generiert werden.');
      setWanProgress('');
    } finally {
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
            <p className="text-[11px] text-slate-500">Ein echter KI-Clip pro Auftrag · 5 Sekunden · 480p. Hinzugefügte Clips werden beim finalen Timeline-Export eingebettet. Kein kostenpflichtiger Fallback; die GPU muss separat bereitgestellt werden.</p>
            {wanBusy && <div className="text-xs text-sky-300 inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{wanProgress}</div>}
            {!wanBusy && wanProgress && <p className="text-xs text-emerald-300">{wanProgress}</p>}
            {wanClipUrl && (
              <div className="space-y-2">
                <p className="text-xs text-white">Fertiger KI-Clip: {wanClipScene}</p>
                <video ref={archivedVideoRef} src={wanClipUrl} controls playsInline preload="metadata" className="w-full rounded-xl bg-black" />
                {videoRecoveryStatus === 'offline' && <p role="status" className="text-xs text-amber-300">Verbindung unterbrochen. ZERO setzt die Prüfung fort, sobald Safari wieder online ist.</p>}
                {videoRecoveryStatus === 'session-expired' && <p role="status" className="text-xs text-amber-300">Sitzung abgelaufen. Bitte erneut anmelden; danach wird die Wiedergabe beim Zurückkehren erneut geprüft. Downloads bitte anschließend erneut antippen.</p>}
                {videoRecoveryStatus === 'missing' && <p role="status" className="text-xs text-rose-300">Dieser Clip ist nicht mehr verfügbar oder wurde gelöscht.</p>}
                {videoRecoveryStatus === 'error' && <p role="status" className="text-xs text-amber-300">Clip-Verbindung konnte nicht geprüft werden. Tippe auf Wiedergabe, um es erneut zu versuchen.</p>}
                <a href={wanClipUrl} download="zero-wan-shot.mp4" className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-white/[0.08] px-3 text-xs text-white"><Download className="w-4 h-4" />Wan-MP4 herunterladen</a>
                <p className="text-[10px] text-slate-500">Safari-Download unterbrochen? Erneut antippen. ZERO liefert bytegenaue HTTP-Range-Bereiche mit ETag-Prüfung; die Fortsetzung steuert Safari. Nach erneuter Anmeldung den Download erneut starten.</p>
              </div>
            )}
          </div>
          <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-white">ZERO Clip-Historie</h3>
                <p className="text-[11px] text-slate-400">Dauerhaft in PostgreSQL gespeichert · keine automatische Löschung · max. 100 MB pro Clip / 500 MB pro Projekt</p>
              </div>
              <span className="text-xs font-mono text-slate-300">{videoHistory.length}/50</span>
            </div>
            {videoHistoryError && <p className="text-xs text-amber-300">{videoHistoryError}</p>}
            {!videoHistory.length && !videoHistoryError && (
              <p className="text-xs text-slate-500">Noch keine Clips in der ZERO-Projektablage.</p>
            )}
            {videoHistory.map((asset) => {
              const scene = currentProject?.scenes.find((item) => item.id === asset.sceneId);
              return (
                <div key={asset.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl bg-[#090B10] border border-white/[0.06] p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-white truncate">{scene?.title || asset.sceneId}</p>
                    <p className="text-[10px] text-slate-400">
                      {(asset.sizeBytes / (1024 * 1024)).toFixed(1)} MB · {new Date(asset.createdAt).toLocaleString('de-DE')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button type="button" onClick={() => void restoreArchivedVideo(asset).catch((restoreError) => setVideoHistoryError(restoreError instanceof Error ? restoreError.message : 'Clip konnte nicht wiederhergestellt werden.'))}
                      className="min-h-[36px] px-3 rounded-lg bg-violet-500/15 text-violet-200 text-[11px]">Wiederherstellen</button>
                    <a href={`/api/projects/${encodeURIComponent(currentProject?.id ?? '')}/videos/${encodeURIComponent(asset.id)}?download=1`}
                      className="min-h-[36px] px-3 rounded-lg bg-white/[0.08] text-white text-[11px] inline-flex items-center gap-1.5"><Download className="w-3.5 h-3.5" />Download</a>
                    <button type="button" disabled={deletingClipId === asset.id} onClick={() => void deleteArchivedVideo(asset).catch((deleteError) => setVideoHistoryError(deleteError instanceof Error ? deleteError.message : 'Clip konnte nicht gelöscht werden.'))}
                      className="min-h-[36px] px-2 rounded-lg bg-rose-500/10 text-rose-300 disabled:opacity-50" aria-label="Clip löschen"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-white">Wan-Auftragshistorie</h3>
                <p className="text-[11px] text-slate-400">Gespeicherte GPU-Aufträge · abgeschlossene Jobs lassen sich erneut in die ZERO-Projektablage übernehmen</p>
              </div>
              <span className="text-xs font-mono text-slate-300">{wanJobHistory.length}</span>
            </div>
            {!wanJobHistory.length && <p className="text-xs text-slate-500">Keine Wan-Aufträge für dieses Projekt gespeichert.</p>}
            {wanJobHistory.map((job) => {
              const scene = currentProject?.scenes.find((item) => item.id === job.scene_id);
              const statusLabel = job.status === 'queued' ? 'Wartet' : job.status === 'running' ? 'Läuft' : job.status === 'succeeded' ? 'Abgeschlossen' : 'Fehlgeschlagen';
              return (
                <div key={job.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl bg-[#090B10] border border-white/[0.06] p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-white truncate">{scene?.title || job.scene_id || 'Wan-Auftrag'}</p>
                    <p className="text-[10px] text-slate-400">{statusLabel} · {job.created_at ? new Date(job.created_at).toLocaleString('de-DE') : 'Zeitpunkt unbekannt'} · {job.id}</p>
                    {job.status === 'failed' && job.error && <p className="text-[10px] text-rose-300">{job.error}</p>}
                  </div>
                  {job.status === 'succeeded' && scene && (
                    <button type="button" disabled={wanBusy} onClick={() => {
                      setWanBusy(true);
                      void restoreWanJobVideo(job.id, scene)
                        .catch((restoreError) => setVideoHistoryError(restoreError instanceof Error ? restoreError.message : 'Wan-Clip konnte nicht archiviert werden.'))
                        .finally(() => setWanBusy(false));
                    }} className="min-h-[36px] px-3 rounded-lg bg-violet-500/15 text-violet-200 text-[11px] disabled:opacity-50">
                      Clip wiederherstellen
                    </button>
                  )}
                </div>
              );
            })}
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

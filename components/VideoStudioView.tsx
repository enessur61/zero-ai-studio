import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Film, Loader2, Music, Play, Share2, Sparkles } from 'lucide-react';
import { renderTimelineVideoMax60s, type VideoRenderResult } from '../lib/localVideoCompositor.ts';
import type { FilmScene, StudioProject } from '../types/zero.ts';
import { projectMediaService } from '../lib/services/projectMediaService.ts';
import { projectService } from '../lib/services/projectService.ts';
import { wanJobService } from '../lib/services/wanJobService.ts';
import type { WanJob } from '../lib/services/types.ts';
import { matchWanJobScene } from '../server/wanJobList.ts';
import { VideoObjectUrlRegistry } from '../lib/videoObjectUrlRegistry.ts';

interface VideoStudioViewProps {
  projects: StudioProject[];
  activeProjectId?: string;
  soundtrack?: { url: string; title: string } | null;
  onProjectUpdated?: (project: StudioProject) => void;
}

export function VideoStudioView({ projects, activeProjectId, soundtrack, onProjectUpdated }: VideoStudioViewProps) {
  const [selectedProjectId, setSelectedProjectId] = useState(
    activeProjectId || projects[0]?.id || ''
  );
  const currentProject = projects.find((p) => p.id === selectedProjectId) ?? projects[0];

  const [scenes, setScenes] = useState<FilmScene[]>(currentProject?.scenes ?? []);
  const [scenesOwnerProjectId, setScenesOwnerProjectId] = useState(currentProject?.id ?? '');
  const scenesRef = useRef<FilmScene[]>(currentProject?.scenes ?? []);
  const projectVersionsRef = useRef(new Map(projects.map((project) => [project.id, project.version])));
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeProjectIdRef = useRef(currentProject?.id);
  activeProjectIdRef.current = currentProject?.id;
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
  const [wanJobs, setWanJobs] = useState<WanJob[]>([]);
  const [wanJobsLoading, setWanJobsLoading] = useState(true);
  const [wanJobsError, setWanJobsError] = useState('');
  const [wanJobId, setWanJobId] = useState<string | null>(null);
  const [wanJobState, setWanJobState] = useState<'idle' | 'queued' | 'running' | 'downloading' | 'cancel_requested' | 'cancelled' | 'stopped' | 'failed' | 'succeeded'>('idle');
  const wanAbortRef = useRef<AbortController | null>(null);
  const [wanProgress, setWanProgress] = useState('');
  const [wanClipUrl, setWanClipUrl] = useState<string | null>(null);
  const [wanClipScene, setWanClipScene] = useState('');
  const wanClipUrlRef = useRef<string | null>(null);
  const resultRef = useRef<VideoRenderResult | null>(null);
  const objectUrlRegistryRef = useRef<VideoObjectUrlRegistry | null>(null);
  if (!objectUrlRegistryRef.current) objectUrlRegistryRef.current = new VideoObjectUrlRegistry();
  const objectUrlRegistry = objectUrlRegistryRef.current;

  function updateScenes(next: FilmScene[] | ((previous: FilmScene[]) => FilmScene[])) {
    const resolved = typeof next === 'function' ? next(scenesRef.current) : next;
    scenesRef.current = resolved;
    setScenes(resolved);
    setScenesOwnerProjectId(activeProjectIdRef.current ?? '');
  }

  function replaceWanClipPreview(nextUrl: string | null, projectId?: string, kind: 'restored' | 'generated' = 'generated') {
    const previous = wanClipUrlRef.current;
    if (nextUrl && nextUrl !== previous) {
      objectUrlRegistry.retainPreview(nextUrl, 'wan-clip-preview', projectId ?? currentProject?.id ?? '__preview__', kind);
    }
    wanClipUrlRef.current = nextUrl;
    setWanClipUrl(nextUrl);
    if (previous && previous !== nextUrl) objectUrlRegistry.releasePreview(previous, 'wan-clip-preview');
  }

  function attachSceneVideo(projectId: string, sceneId: string, url: string) {
    const previousUrl = scenesRef.current.find((scene) => scene.id === sceneId)?.videoUrl;
    if (activeProjectIdRef.current === projectId) {
      updateScenes((previous) => previous.map((scene) =>
        scene.id === sceneId ? { ...scene, videoUrl: url, status: 'Szenenbereit' } : scene
      ));
    } else {
      objectUrlRegistry.releaseSceneReference(url, projectId, sceneId);
    }
    if (previousUrl && previousUrl !== url) objectUrlRegistry.releaseSceneReference(previousUrl, projectId, sceneId);
  }

  function releaseExportPreview() {
    const previous = resultRef.current?.videoUrl;
    if (previous) objectUrlRegistry.releasePreview(previous, 'export-preview');
    resultRef.current = null;
  }

  // Persist user-authored timeline edits with optimistic project-version checks.
  // Temporary Blob URLs are excluded; ProjectMediaService owns the actual clip bytes.
  useEffect(() => {
    if (!currentProject || scenesOwnerProjectId !== currentProject.id) return;
    const projectId = currentProject.id;
    const persistedScenes = scenes.map(({ videoUrl: _temporaryVideoUrl, ...scene }) => scene);
    const serverScenes = currentProject.scenes.map(({ videoUrl: _temporaryVideoUrl, ...scene }) => scene);
    if (JSON.stringify(persistedScenes) === JSON.stringify(serverScenes)) return;
    if (!projectVersionsRef.current.has(projectId)) projectVersionsRef.current.set(projectId, currentProject.version);
    const timer = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        const expectedVersion = projectVersionsRef.current.get(projectId) ?? currentProject.version;
        try {
          const updated = await projectService.update(projectId, { scenes: persistedScenes }, expectedVersion);
          projectVersionsRef.current.set(projectId, updated.version);
          onProjectUpdated?.(updated);
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : 'VideoStudio-Änderungen konnten nicht dauerhaft gespeichert werden.');
        }
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [scenes, scenesOwnerProjectId, currentProject?.id, currentProject?.version, onProjectUpdated]);

  useEffect(() => {
    let active = true;
    if (!currentProject) {
      updateScenes([]);
      return () => { active = false; };
    }
    const projectId = currentProject.id;
    updateScenes(currentProject.scenes);
    Promise.all(currentProject.scenes.map(async (scene) => {
      try {
        const blob = await projectMediaService.loadSceneVideo(projectId, scene.id);
        if (!blob) return null;
        const url = objectUrlRegistry.create(blob, { projectId, sceneId: scene.id, kind: 'restored' });
        return { sceneId: scene.id, url };
      } catch { return null; }
    })).then((restored) => {
      if (!active) {
        restored.forEach((item) => {
          if (item) objectUrlRegistry.releaseSceneReference(item.url, projectId, item.sceneId);
        });
        return;
      }
      const urls = new Map(restored.filter((item): item is { sceneId: string; url: string } => Boolean(item))
        .map((item) => [item.sceneId, item.url]));
      if (urls.size) {
        updateScenes((previous) => previous.map((scene) => {
          const url = urls.get(scene.id);
          return url ? { ...scene, videoUrl: url, status: 'Szenenbereit' } : scene;
        }));
      }
    });
    return () => {
      active = false;
      const leavingProject = activeProjectIdRef.current !== projectId;
      const restoredUrls = new Set(objectUrlRegistry.getProjectUrls(projectId, 'restored'));
      if (leavingProject && restoredUrls.size) {
        updateScenes((previous) => previous.map((scene) =>
          scene.videoUrl && restoredUrls.has(scene.videoUrl) ? { ...scene, videoUrl: undefined } : scene
        ));
      }
      if (leavingProject && wanClipUrlRef.current &&
          objectUrlRegistry.getProjectUrls(projectId).includes(wanClipUrlRef.current)) {
        replaceWanClipPreview(null);
      }
      if (leavingProject) objectUrlRegistry.releaseProjectRestored(projectId);
    };
  }, [selectedProjectId, currentProject?.id]);

  useEffect(() => () => {
    objectUrlRegistry.releaseAll();
    wanClipUrlRef.current = null;
    resultRef.current = null;
  }, []);

  useEffect(() => {
    if (soundtrack?.url) {
      setSelectedAudioUrl(soundtrack.url);
    }
  }, [soundtrack]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refreshJobs = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const jobs = await wanJobService.list(50, controller.signal);
        if (active) {
          setWanJobs(jobs);
          setWanJobsError('');
        }
      } catch (loadError) {
        if (active && !(loadError instanceof Error && loadError.name === 'AbortError')) {
          setWanJobsError(loadError instanceof Error ? loadError.message : 'Wan-Auftragsliste konnte nicht geladen werden.');
        }
      } finally {
        inFlight = false;
        controller = null;
        if (active) setWanJobsLoading(false);
      }
    };
    void refreshJobs();
    const interval = window.setInterval(() => { void refreshJobs(); }, 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshJobs();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (wanBusy || !wanJobId) return;
    const selected = wanJobs.find((job) => job.id === wanJobId);
    if (selected) setWanJobState(selected.status);
  }, [wanJobs, wanJobId, wanBusy]);

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

  async function handleCancelWanJob(jobIdOverride?: string) {
    const targetJobId = jobIdOverride || wanJobId;
    if (!targetJobId) return;
    const selectedJob = wanJobs.find((job) => job.id === targetJobId);
    if (selectedJob?.status === 'cancel_requested' || selectedJob?.status === 'cancelled' || selectedJob?.status === 'succeeded' || selectedJob?.status === 'failed') return;
    setWanJobId(targetJobId);
    setWanProgress('Sende echte Abbruchanforderung an den Worker...');
    try {
      const cancelledJob = await wanJobService.cancel(targetJobId);
      if (cancelledJob.id !== targetJobId) throw new Error('Der Worker hat einen fremden Auftrag zurückgegeben.');
      setWanJobs((previous) => previous.map((job) => job.id === targetJobId ? { ...job, ...cancelledJob } : job));
      if (cancelledJob.status === 'cancelled') {
        setWanJobState('cancelled');
        setWanProgress('Der Worker hat den Auftrag abgebrochen. Es wird kein Clip bereitgestellt.');
      } else if (cancelledJob.status === 'cancel_requested') {
        setWanJobState('cancel_requested');
        setWanProgress('Abbruch angefordert. Der aktuelle GPU-Inferenzschritt läuft noch und wird sicher beendet; erst danach bestätigt ZERO den Abbruch.');
      } else {
        setWanJobState(cancelledJob.status === 'succeeded' ? 'succeeded' : 'failed');
        setWanProgress(cancelledJob.status === 'succeeded' ? 'Der Clip war bereits fertig; ein Abbruch war nicht mehr möglich.' : 'Der Auftrag war bereits beendet.');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Abbruchstatus konnte nicht bestätigt werden.');
      setWanProgress('Keine Abbruchbestätigung erhalten. ZERO prüft den Workerstatus weiter.');
    }
  }

  async function handleResumeWanJob(jobId: string) {
    setWanJobId(jobId);
    const job = wanJobs.find((item) => item.id === jobId);
    if (job) {
      setWanJobState(job.status);
      setWanProgress(job.status === 'cancel_requested'
        ? 'Abbruch angefordert – ZERO fragt den Workerstatus weiter automatisch ab.'
        : job.status === 'queued' || job.status === 'running'
          ? 'Statusüberwachung aus der persistenten Worker-Auftragsliste wieder aufgenommen.'
          : job.status === 'cancelled'
            ? 'Auftrag wurde abgebrochen.'
            : job.status === 'succeeded'
              ? 'Auftrag ist fertig. Du kannst den gespeicherten Clip wiederherstellen.'
              : job.error || 'Auftrag fehlgeschlagen.');
    }
    try {
      const resumedJob = await wanJobService.get(jobId);
      if (resumedJob.id !== jobId) throw new Error('Wan hat einen fremden Auftrag zurückgegeben.');
      const status = resumedJob.status;
      if (['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed'].includes(status)) {
        setWanJobState(status);
        setWanJobs((previous) => previous.map((item) => item.id === jobId ? { ...item, status } : item));
      }
    } catch (resumeError) {
      setWanJobsError(resumeError instanceof Error ? resumeError.message : 'Jobstatus konnte nicht aktualisiert werden.');
    }
  }

  async function handleRestoreWanClip(job: typeof wanJobs[number]) {
    if (job.status !== 'succeeded') return;
    try {
      setWanJobId(job.id);
      setWanProgress('Gespeichertes Wan-MP4 wird wiederhergestellt...');
      const blob = await wanJobService.download(job.id);
      const targetScene = matchWanJobScene(job, currentProject?.id, scenesRef.current) ?? undefined;
      const projectId = currentProject?.id ?? job.projectId ?? '__unassigned__';
      const clipUrl = objectUrlRegistry.create(blob, { projectId, sceneId: targetScene?.id, kind: 'restored' });
      replaceWanClipPreview(clipUrl, projectId, 'restored');
      setWanJobState('succeeded');
      if (targetScene && currentProject) {
        attachSceneVideo(currentProject.id, targetScene.id, clipUrl);
        setWanClipScene(targetScene.title);
        try {
          const storage = await projectMediaService.saveSceneVideo(currentProject.id, targetScene.id, blob);
          setWanProgress(storage.serverPersisted
            ? 'Gespeicherter Wan-Clip wiederhergestellt und dem aktuellen ZERO-Projekt zugeordnet.'
            : 'Clip wiederhergestellt und in der Szene angezeigt, aber nicht dauerhaft synchronisiert. Bitte vor Gerätewechsel exportieren.');
        } catch {
          setWanProgress('Clip wiederhergestellt und in der Szene angezeigt. Die dauerhafte Serversynchronisierung ist fehlgeschlagen; bitte vor Gerätewechsel exportieren.');
        }
      } else {
        setWanClipScene('Wiederhergestellter Wan-Clip');
        setWanProgress('MP4 wiederhergestellt. Es wurde keinem anderen Projekt oder keiner anderen Szene zugeordnet.');
      }
    } catch (restoreError) {
      setWanJobsError(restoreError instanceof Error ? restoreError.message : 'Wan-Clip konnte nicht wiederhergestellt werden.');
    }
  }

  async function handleWanSceneGeneration(scene: FilmScene) {
    if (wanBusy || !wanWorker.online) return;
    const controller = new AbortController();
    wanAbortRef.current = controller;
    setWanBusy(true);
    setWanJobId(null);
    setWanJobState('queued');
    setWanProgress('Sende Szene an den Wan-GPU-Worker...');
    setError(null);
    replaceWanClipPreview(null);
    try {
      const prompt = (scene.videoPrompt || [scene.title, scene.location, scene.timeOfDay, scene.subtitleText].filter(Boolean).join('. ')).trim();
      if (prompt.length < 8) throw new Error('Für diese Szene fehlt ein ausreichender Video-Prompt.');
      if (!currentProject?.id) throw new Error('Bitte zuerst ein ZERO-Projekt auswählen, damit der Wan-Auftrag eindeutig zugeordnet wird.');
      const createdJob = await wanJobService.create({
        projectId: currentProject.id,
        sceneId: scene.id,
        prompt: prompt.slice(0, 1800),
        aspectRatio,
      }, controller.signal);
      const jobId = createdJob.id;
      setWanJobId(jobId);
      setWanJobState('queued');
      setWanProgress('Wan 2.1 rendert den 5-Sekunden-Clip. Das kann mehrere Minuten dauern...');
      let completed = false;
      let cancellationPending = false;
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
        const job = await wanJobService.get(jobId, controller.signal);
        if (job.status === 'failed') { setWanJobState('failed'); throw new Error(String(job.error || 'Wan-Generierung fehlgeschlagen.')); }
        if (job.status === 'cancelled') {
          setWanJobState('cancelled');
          setWanProgress('Der Worker hat den Auftrag abgebrochen. Es wird kein Clip bereitgestellt.');
          completed = true;
          break;
        }
        if (job.status === 'cancel_requested') {
          cancellationPending = true;
          setWanJobState('cancel_requested');
          setWanProgress('Abbruch angefordert. Der Worker beendet den laufenden GPU-Schritt; ZERO wartet auf die endgültige Bestätigung.');
        } else {
          setWanJobState(job.status === 'queued' ? 'queued' : 'running');
        }
        if (job.status === 'succeeded') {
          setWanJobState('downloading');
          setWanProgress('MP4 wird auf ZERO übertragen...');
          const blob = await wanJobService.download(jobId, controller.signal);
          const projectId = currentProject.id;
          const clipUrl = objectUrlRegistry.create(blob, { projectId, sceneId: scene.id, kind: 'generated' });
          replaceWanClipPreview(clipUrl, projectId, 'generated');
          let persistedLocally = false;
          let persistedOnServer = false;
          let storagePersistent: boolean | null = null;
          let storageError = '';
          if (currentProject?.id) {
            try {
              const storageStatus = await projectMediaService.saveSceneVideo(currentProject.id, scene.id, blob);
              persistedLocally = storageStatus.localSaved;
              persistedOnServer = storageStatus.serverPersisted === true;
              storagePersistent = storageStatus.persistent;
            } catch (saveError) {
              storageError = saveError instanceof Error ? saveError.message : 'Unbekannter Speicherfehler';
            }
          }
          setWanClipScene(scene.title);
          attachSceneVideo(projectId, scene.id, clipUrl);
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
      if (!completed && cancellationPending) {
        setWanProgress('Der Worker hat den Abbruch noch nicht final bestätigt. Der Auftrag kann weiterhin GPU-Ressourcen belegen; bitte später den Status erneut prüfen.');
      } else if (!completed) {
        throw new Error('Wan-Generierung dauert ungewöhnlich lange. Der Auftrag kann im Worker weiterlaufen; bitte später den Status erneut prüfen.');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setWanJobState('stopped');
        setWanProgress('ZERO hat die Live-Überwachung in diesem Fenster beendet. Der Auftrag bleibt in der persistenten Auftragsliste und wird nach Rückkehr erneut abgefragt; der GPU-Worker läuft dadurch nicht automatisch aus.');
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
          const url = objectUrlRegistry.create(file, { projectId: currentProject?.id ?? '__image-import__', kind: 'temporary' });
          const img = new Image();
          img.onload = () => { objectUrlRegistry.releaseTemporary(url); resolve(img); };
          img.onerror = () => { objectUrlRegistry.releaseTemporary(url); reject(new Error(`„${file.name}“ konnte nicht geöffnet werden.`)); };
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
      updateScenes((previous) => previous.map((scene, index) => ({
        ...scene,
        imageUrl: optimized[index % optimized.length],
        status: 'Bild bereit',
      })));
      releaseExportPreview();
      setResult(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bilder konnten nicht importiert werden.');
    }
  }

  function updateSceneDuration(id: string, val: number) {
    const safeVal = Math.max(3, Math.min(30, val));
    updateScenes((prev) => prev.map((s) => (s.id === id ? { ...s, durationSec: safeVal } : s)));
  }

  function updateCamera(id: string, movement: FilmScene['cameraMovement']) {
    updateScenes((prev) =>
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
    updateScenes((prev) =>
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
      const previousResultUrl = resultRef.current?.videoUrl;
      if (rendered.videoUrl.startsWith('blob:')) {
        const projectId = currentProject?.id ?? '__export__';
        objectUrlRegistry.register(rendered.videoUrl, { projectId, kind: 'export' });
        objectUrlRegistry.retainPreview(rendered.videoUrl, 'export-preview', projectId, 'export');
      }
      resultRef.current = rendered;
      setResult(rendered);
      if (previousResultUrl && previousResultUrl !== rendered.videoUrl) {
        objectUrlRegistry.releasePreview(previousResultUrl, 'export-preview');
      }
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
            <section className="space-y-2 rounded-xl border border-white/[0.08] bg-black/20 p-3" aria-label="Persistente Wan-Aufträge">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-white">Wan-Aufträge</h3>
                <span className="text-[10px] text-slate-500">{wanJobs.length} gespeichert · automatische Aktualisierung alle 5 s</span>
              </div>
              {wanJobsLoading && <p className="text-[11px] text-slate-500">Lade gespeicherte Aufträge...</p>}
              {wanJobsError && <p className="text-[11px] text-rose-300">{wanJobsError}</p>}
              {!wanJobsLoading && !wanJobsError && wanJobs.length === 0 && <p className="text-[11px] text-slate-500">Noch keine Wan-Aufträge gespeichert.</p>}
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {wanJobs.map((job) => {
                  const statusLabel = ({
                    queued: 'Wartet auf GPU',
                    running: 'Wird generiert',
                    cancel_requested: 'Abbruch angefordert · GPU läuft aus',
                    cancelled: 'Abgebrochen',
                    succeeded: 'Erfolgreich',
                    failed: 'Fehlgeschlagen',
                  } as const)[job.status];
                  const active = job.status === 'queued' || job.status === 'running' || job.status === 'cancel_requested';
                  const statusClass = job.status === 'succeeded' ? 'text-emerald-300' : job.status === 'failed' || job.status === 'cancelled' ? 'text-slate-400' : 'text-amber-300';
                  return (
                    <div key={job.id} className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-all text-[10px] text-slate-400">{job.id}</p>
                          <p className={`mt-1 text-[11px] font-medium ${statusClass}`}>{statusLabel}</p>
                          <p className="mt-0.5 text-[10px] text-slate-500">{job.createdAt ? new Date(job.createdAt).toLocaleString('de-DE') : 'Zeit unbekannt'} · {job.durationSec}s</p>
                          {job.error && <p className="mt-1 text-[10px] text-rose-300">{job.error}</p>}
                          {job.cancelReason && <p className="mt-1 text-[10px] text-slate-500">{job.cancelReason}</p>}
                        </div>
                        <div className="flex shrink-0 flex-col gap-1">
                          <button type="button" onClick={() => void handleResumeWanJob(job.id)} className="min-h-[34px] rounded-md border border-white/10 px-2 text-[10px] text-slate-200">Status übernehmen</button>
                          {active && job.status !== 'cancel_requested' && <button type="button" onClick={() => void handleCancelWanJob(job.id)} className="min-h-[34px] rounded-md border border-rose-400/30 px-2 text-[10px] text-rose-200">Abbrechen</button>}
                          {job.status === 'succeeded' && <button type="button" onClick={() => void handleRestoreWanClip(job)} className="min-h-[34px] rounded-md border border-emerald-400/30 px-2 text-[10px] text-emerald-200">Clip wiederherstellen</button>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            {wanBusy && <div className="space-y-2">
              <div className="text-xs text-sky-300 inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{wanProgress}</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-1/3 animate-pulse rounded-full bg-sky-400" /></div>
              {wanJobId && <p className="text-[10px] text-slate-500 break-all">Auftrags-ID: {wanJobId}</p>}
              <button type="button" onClick={() => void handleCancelWanJob()} disabled={!wanJobId || wanJobState === 'cancel_requested'} className="min-h-[44px] w-full rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 text-xs font-medium text-rose-200 disabled:opacity-50">{wanJobState === 'cancel_requested' ? 'Abbruch angefordert – GPU-Schritt läuft aus' : 'Wan-Auftrag abbrechen'}</button>
            </div>}
            {!wanBusy && wanJobState === 'stopped' && <p className="text-xs text-amber-300">{wanProgress}</p>}
            {!wanBusy && wanJobState === 'cancelled' && <p className="text-xs text-amber-300">{wanProgress}</p>}
            {!wanBusy && wanJobState === 'cancel_requested' && <p className="text-xs text-amber-300">{wanProgress}</p>}
            {!wanBusy && wanJobState === 'failed' && <p className="text-xs text-rose-300">Auftrag fehlgeschlagen. Du kannst die Szene erneut starten.</p>}
            {!wanBusy && wanJobState === 'succeeded' && <p className="text-xs text-emerald-300">Auftrag abgeschlossen.</p>}
            {!wanBusy && wanProgress && !['cancelled', 'failed', 'stopped'].includes(wanJobState) && <p className="text-xs text-emerald-300">{wanProgress}</p>}
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

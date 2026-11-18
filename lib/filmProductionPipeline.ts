import type { FilmScene, StudioProject } from '../src/types/zero.ts';
import type { VideoRenderResult } from './localVideoCompositor.ts';

export const FILM_PRODUCTION_MAX_DURATION_SEC = 60;
export const FILM_PRODUCTION_MAX_WAN_CLIPS = 3;

export interface FilmProductionProgress {
  percent: number;
  label: string;
  stage: 'script' | 'images' | 'voiceover' | 'video' | 'saving' | 'rendering' | 'complete';
}

export interface FilmProductionPipelineServices {
  createDraft(): Promise<{
    project: StudioProject;
    imageGenerationWarnings?: string[];
  }>;
  generateVoiceover(scene: FilmScene): Promise<{ audioDataUrl: string; modelUsed?: string }>;
  /** Returns a temporary browser object URL for a completed 5-second Wan MP4, or null when unavailable. */
  generateVideoClip?(scene: FilmScene, projectId: string, onProgress: (label: string) => void): Promise<string | null>;
  /** Must confirm durable server persistence before a generated clip is used in the render. */
  saveVideoClip?(projectId: string, sceneId: string, blob: Blob): Promise<{ serverPersisted: boolean }>;
  saveProject(projectId: string, scenes: FilmScene[]): Promise<StudioProject>;
  renderVideo(
    project: StudioProject,
    onProgress: (percent: number, label: string) => void,
  ): Promise<VideoRenderResult>;
}

export interface FilmProductionPipelineResult {
  project: StudioProject;
  video: VideoRenderResult;
  warnings: string[];
  imagesReady: number;
  voiceoversReady: number;
}

/**
 * Runs one complete, browser-driven episode production without changing the
 * database schema: create the director draft, add available free-tier voices,
 * persist the scene assets, then render the <=60s master locally.
 *
 * Provider selection and billing enforcement stay inside the existing API
 * endpoints. A failed free provider is reported; this coordinator never
 * invents a paid fallback.
 */
export async function runAutonomousFilmProduction(
  services: FilmProductionPipelineServices,
  onProgress?: (progress: FilmProductionProgress) => void,
): Promise<FilmProductionPipelineResult> {
  onProgress?.({ percent: 3, label: 'ZERO erstellt Drehbuch und Szenenplan...', stage: 'script' });
  const draft = await services.createDraft();
  const project = draft.project;
  if (!project || !Array.isArray(project.scenes) || project.scenes.length === 0) {
    throw new Error('ZERO hat keinen gültigen Szenenplan geliefert.');
  }

  const totalDurationSec = project.scenes.reduce((sum, scene) => {
    if (!Number.isFinite(scene.durationSec) || scene.durationSec <= 0) {
      throw new Error(`Ungültige Szenendauer in „${scene.title}“.`);
    }
    return sum + scene.durationSec;
  }, 0);
  if (totalDurationSec > FILM_PRODUCTION_MAX_DURATION_SEC) {
    throw new Error(`Produktion gestoppt: ${totalDurationSec}s überschreiten das harte 60-Sekunden-Limit.`);
  }

  const warnings = (draft.imageGenerationWarnings ?? []).filter(
    (warning): warning is string => typeof warning === 'string' && warning.trim().length > 0,
  );
  const imagesReady = project.scenes.filter((scene) => Boolean(scene.imageUrl)).length;
  if (imagesReady < project.scenes.length && warnings.length === 0) {
    warnings.push('Nicht alle Szenen besitzen ein KI-Bild. ZERO verwendet für fehlende Bilder den grafischen Storyboard-Schnitt.');
  }

  onProgress?.({
    percent: 25,
    label: `${imagesReady}/${project.scenes.length} Szenenbilder verfügbar`,
    stage: 'images',
  });

  const scenes: FilmScene[] = project.scenes.map((scene) => ({ ...scene }));
  let voiceoversReady = 0;
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    if (!scene.narrationText.trim()) {
      warnings.push(`Szene ${scene.index}: kein Sprechertext vorhanden.`);
      continue;
    }
    onProgress?.({
      percent: 28 + Math.round(((index + 1) / scenes.length) * 32),
      label: `ZERO erzeugt Voiceover für Szene ${scene.index}/${scenes.length}...`,
      stage: 'voiceover',
    });
    try {
      const voice = await services.generateVoiceover(scene);
      if (!voice.audioDataUrl.startsWith('data:audio/')) {
        throw new Error('Der Sprachdienst lieferte keine gültige Audio-Data-URL.');
      }
      scenes[index] = { ...scene, audioDataUrl: voice.audioDataUrl, status: 'Szenenbereit' };
      voiceoversReady += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unbekannter Sprachfehler';
      warnings.push(`Szene ${scene.index}: Voiceover nicht verfügbar – ${detail}`);
    }
  }

  if (voiceoversReady === 0) {
    warnings.push('Kein Voiceover konnte mit einem freigegebenen kostenlosen Modell erzeugt werden. Der Videoexport wird ohne Sprecher-Audio fortgesetzt.');
  }

  // Generate no more than three Wan shots per episode. Worker-side daily and
  // concurrency gates remain authoritative; this is an additional client cap.
  const renderScenes: FilmScene[] = scenes.map((scene) => ({ ...scene }));
  const temporaryClipUrls: string[] = [];
  if (services.generateVideoClip) {
    const candidates = renderScenes.slice(0, FILM_PRODUCTION_MAX_WAN_CLIPS);
    let stopWanAfterFailure = false;
    for (let index = 0; index < candidates.length; index += 1) {
      if (stopWanAfterFailure) break;
      const scene = candidates[index];
      onProgress?.({
        percent: 60 + Math.round(((index + 1) / candidates.length) * 8),
        label: `ZERO generiert KI-Videoclip ${index + 1}/${candidates.length}...`,
        stage: 'video',
      });
      try {
        const videoUrl = await services.generateVideoClip(scene, project.id, (label) => {
          onProgress?.({ percent: 60 + Math.round(((index + 0.5) / candidates.length) * 8), label, stage: 'video' });
        });
        if (videoUrl) {
          if (!videoUrl.startsWith('blob:')) throw new Error('Der Worker-Clip muss als temporäre lokale Blob-URL bereitgestellt werden.');
          temporaryClipUrls.push(videoUrl);
          if (!services.saveVideoClip) throw new Error('ProjectMediaService ist nicht verfügbar; der KI-Clip wird nicht ohne dauerhafte Speicherung verwendet.');
          const clipResponse = await fetch(videoUrl);
          if (!clipResponse.ok) throw new Error('Der temporäre Wan-Clip konnte vor der Speicherung nicht gelesen werden.');
          const clipBlob = await clipResponse.blob();
          const savedClip = await services.saveVideoClip(project.id, scene.id, clipBlob);
          if (savedClip.serverPersisted !== true) {
            throw new Error('Dauerhafte Serverspeicherung des Wan-Clips wurde nicht bestätigt; ZERO verwendet den Storyboard-Schnitt.');
          }
          renderScenes[index] = { ...scene, videoUrl };
        } else {
          warnings.push(`Szene ${scene.index}: kein KI-Videoclip verfügbar. ZERO verwendet den lokalen Storyboard-Schnitt.`);
        }
      } catch (error) {
        stopWanAfterFailure = true;
        const detail = error instanceof Error ? error.message : 'Unbekannter Wan-Worker-Fehler';
        warnings.push(`Szene ${scene.index}: KI-Videoclip nicht verfügbar – ${detail}. ZERO verwendet den lokalen Storyboard-Schnitt.`);
      }
    }
    if (renderScenes.length > FILM_PRODUCTION_MAX_WAN_CLIPS) {
      warnings.push(`Wan-Limit: maximal ${FILM_PRODUCTION_MAX_WAN_CLIPS} KI-Clips pro Episode; übrige Szenen werden lokal als Storyboard geschnitten.`);
    }
  }

  try {
    onProgress?.({ percent: 69, label: 'Sichere Szenen und verfügbare Sprachaufnahmen...', stage: 'saving' });
    // Never persist browser blob: URLs: they are ephemeral and invalid after reload.
    const persistedScenes = renderScenes.map(({ videoUrl: _temporaryVideoUrl, ...scene }) => scene);
    const savedProject = await services.saveProject(project.id, persistedScenes);
    const savedDuration = savedProject.scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
    if (savedDuration > FILM_PRODUCTION_MAX_DURATION_SEC) {
      throw new Error(`Gespeicherte Szenen überschreiten das 60-Sekunden-Limit (${savedDuration}s).`);
    }

    onProgress?.({ percent: 70, label: 'ZERO schneidet den finalen Hochkantfilm...', stage: 'rendering' });
    const clipsBySceneId = new Map(renderScenes.map((scene) => [scene.id, scene.videoUrl]));
    const projectForRender: StudioProject = {
      ...savedProject,
      scenes: savedProject.scenes.map((scene) => ({
        ...scene,
        ...(clipsBySceneId.get(scene.id) ? { videoUrl: clipsBySceneId.get(scene.id) } : {}),
      })),
    };
    const reportRenderProgress = (percent: number, label: string) => {
      onProgress?.({
        percent: Math.min(98, 70 + Math.round(Math.max(0, Math.min(100, percent)) * 0.28)),
        label,
        stage: 'rendering',
      });
    };
    let video: VideoRenderResult;
    try {
      video = await services.renderVideo(projectForRender, reportRenderProgress);
    } catch (clipRenderError) {
      if (temporaryClipUrls.length === 0) throw clipRenderError;
      const detail = clipRenderError instanceof Error ? clipRenderError.message : 'KI-Clip konnte nicht dekodiert werden.';
      warnings.push(`KI-Clip-Wiedergabe fehlgeschlagen – ${detail}. ZERO rendert erneut mit lokalem Storyboard-Schnitt.`);
      onProgress?.({ percent: 70, label: 'KI-Clip nicht kompatibel – wechsle zum lokalen Storyboard-Schnitt...', stage: 'rendering' });
      const storyboardProject: StudioProject = {
        ...savedProject,
        scenes: savedProject.scenes.map(({ videoUrl: _temporaryVideoUrl, ...scene }) => scene),
      };
      video = await services.renderVideo(storyboardProject, reportRenderProgress);
    }
    if (!Number.isFinite(video.durationSec) || video.durationSec > FILM_PRODUCTION_MAX_DURATION_SEC) {
      throw new Error('Der Videoexport hat das harte 60-Sekunden-Limit verletzt und wird nicht als Ergebnis freigegeben.');
    }

    onProgress?.({ percent: 100, label: 'Episode erfolgreich exportiert.', stage: 'complete' });
    return { project: savedProject, video, warnings, imagesReady, voiceoversReady };
  } finally {
    // Clip blobs are only needed during rendering. The final export has its own URL.
    for (const url of temporaryClipUrls) URL.revokeObjectURL(url);
  }
}

import type { FilmScene, StudioProject } from '../src/types/zero.ts';
import type { VideoRenderResult } from './localVideoCompositor.ts';

export const FILM_PRODUCTION_MAX_DURATION_SEC = 60;

export interface FilmProductionProgress {
  percent: number;
  label: string;
  stage: 'script' | 'images' | 'voiceover' | 'saving' | 'rendering' | 'complete';
}

export interface FilmProductionPipelineServices {
  createDraft(): Promise<{
    project: StudioProject;
    imageGenerationWarnings?: string[];
  }>;
  generateVoiceover(scene: FilmScene): Promise<{ audioDataUrl: string; modelUsed?: string }>;
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

  onProgress?.({ percent: 63, label: 'Sichere Szenen und verfügbare Sprachaufnahmen...', stage: 'saving' });
  const savedProject = await services.saveProject(project.id, scenes);
  const savedDuration = savedProject.scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  if (savedDuration > FILM_PRODUCTION_MAX_DURATION_SEC) {
    throw new Error(`Gespeicherte Szenen überschreiten das 60-Sekunden-Limit (${savedDuration}s).`);
  }

  onProgress?.({ percent: 70, label: 'ZERO schneidet den finalen Hochkantfilm...', stage: 'rendering' });
  const video = await services.renderVideo(savedProject, (percent, label) => {
    onProgress?.({
      percent: Math.min(98, 70 + Math.round(Math.max(0, Math.min(100, percent)) * 0.28)),
      label,
      stage: 'rendering',
    });
  });
  if (!Number.isFinite(video.durationSec) || video.durationSec > FILM_PRODUCTION_MAX_DURATION_SEC) {
    throw new Error('Der Videoexport hat das harte 60-Sekunden-Limit verletzt und wird nicht als Ergebnis freigegeben.');
  }

  onProgress?.({ percent: 100, label: 'Episode erfolgreich exportiert.', stage: 'complete' });
  return { project: savedProject, video, warnings, imagesReady, voiceoversReady };
}

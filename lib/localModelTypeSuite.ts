import { processImageLocally } from './localImageProcessor.ts';
import { renderMusicToWavUrl } from './localAudioSynth.ts';
import { renderTimelineVideoMax60s } from './localVideoCompositor.ts';
import type { FilmScene } from '../types/zero.ts';

export interface LocalModelTypeProbe {
  modelId: 'zero-canvas-img2img' | 'zero-timeline-video-60s' | 'zero-webaudio-synth';
  category: 'Bildgenerierung' | 'Videogenerierung' | 'Musik & SFX';
  probeResponse: string;
}

const TEST_SCENE: FilmScene = {
  id: 'zero-suite-probe',
  index: 0,
  title: 'ZERO Runtime Probe',
  location: 'Studio',
  timeOfDay: 'Nacht',
  durationSec: 1,
  cameraMovement: 'Statisch',
  characterIds: [],
  narrationText: '',
  dialogueText: '',
  subtitleText: 'ZERO TEST',
  soundCue: '',
  imagePrompt: '',
  videoPrompt: '',
  status: 'Szenenbereit',
};

/**
 * Executes small real browser-side probes for the local creative engines.
 * These are editor/rendering engines, not generative image/video models.
 */
export async function runLocalModelTypeSuite(
  onProgress?: (label: string) => void,
): Promise<LocalModelTypeProbe[]> {
  const results: LocalModelTypeProbe[] = [];

  onProgress?.('Bild: lokalen Canvas-Filter und PNG-Export testen…');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#24364b"/></svg>';
  const image = await processImageLocally(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, 'noir');
  if (!image.dataUrl.startsWith('data:image/png') || image.width !== 16 || image.height !== 16) {
    throw new Error('Lokaler Bild-Canvas-Test lieferte kein gültiges PNG.');
  }
  results.push({
    modelId: 'zero-canvas-img2img',
    category: 'Bildgenerierung',
    probeResponse: `canvas-png:${image.width}x${image.height}`,
  });

  onProgress?.('Video: echten 1-Sekunden-Timeline-Export testen…');
  const video = await renderTimelineVideoMax60s({
    scenes: [TEST_SCENE],
    aspectRatio: '9:16',
    burnSubtitles: true,
    includeSceneVoiceovers: false,
  });
  if (!video.videoUrl || video.sizeBytes <= 0 || video.durationSec > 60) {
    throw new Error('Lokaler Video-Timeline-Test lieferte keinen gültigen Export innerhalb des 60-Sekunden-Limits.');
  }
  URL.revokeObjectURL(video.videoUrl);
  results.push({
    modelId: 'zero-timeline-video-60s',
    category: 'Videogenerierung',
    probeResponse: `timeline-export:${video.mimeType}:${video.durationSec}s:${video.sizeBytes}bytes`,
  });

  onProgress?.('Musik: echte lokale WAV-Synthese testen…');
  const music = await renderMusicToWavUrl({
    title: 'ZERO Runtime Probe',
    mood: 'Test',
    bpm: 84,
    rootMidi: 40,
    scaleIntervals: [0, 3, 7],
    padBrightness: 0.4,
    pulseIntensity: 0.4,
    subBassLevel: 0.5,
    durationSec: 4,
  });
  if (music.blob.size <= 44 || music.blob.type !== 'audio/wav') {
    throw new Error('Lokaler WebAudio-Test lieferte keine gültige WAV-Datei.');
  }
  URL.revokeObjectURL(music.url);
  results.push({
    modelId: 'zero-webaudio-synth',
    category: 'Musik & SFX',
    probeResponse: `webaudio-wav:${music.blob.size}bytes`,
  });

  return results;
}

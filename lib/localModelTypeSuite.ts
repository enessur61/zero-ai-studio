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

/** Executes real browser-side probes for local creative engines, independently. */
export async function runLocalModelTypeSuite(
  onProgress?: (label: string) => void,
): Promise<{ probes: LocalModelTypeProbe[]; failures: string[] }> {
  const probes: LocalModelTypeProbe[] = [];
  const failures: string[] = [];

  onProgress?.('Bild: lokalen Canvas-Filter und PNG-Export testen…');
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#24364b"/></svg>';
    const image = await processImageLocally('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), 'noir');
    if (!image.dataUrl.startsWith('data:image/png') || image.width !== 16 || image.height !== 16) {
      throw new Error('Kein gültiges PNG erzeugt.');
    }
    probes.push({ modelId: 'zero-canvas-img2img', category: 'Bildgenerierung', probeResponse: 'canvas-png:' + image.width + 'x' + image.height });
  } catch (error) {
    failures.push('Bild/Canvas: ' + (error instanceof Error ? error.message : 'Test fehlgeschlagen'));
  }

  onProgress?.('Video: echten 1-Sekunden-Timeline-Export testen…');
  try {
    const video = await renderTimelineVideoMax60s({
      scenes: [TEST_SCENE],
      aspectRatio: '9:16',
      burnSubtitles: true,
      includeSceneVoiceovers: false,
    });
    if (!video.videoUrl || video.sizeBytes <= 0 || video.durationSec > 60) {
      throw new Error('Kein gültiger Export innerhalb des 60-Sekunden-Limits.');
    }
    URL.revokeObjectURL(video.videoUrl);
    probes.push({ modelId: 'zero-timeline-video-60s', category: 'Videogenerierung', probeResponse: 'timeline-export:' + video.mimeType + ':' + video.durationSec + 's:' + video.sizeBytes + 'bytes' });
  } catch (error) {
    failures.push('Video/Timeline: ' + (error instanceof Error ? error.message : 'Test fehlgeschlagen'));
  }

  onProgress?.('Musik: echte lokale WAV-Synthese testen…');
  try {
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
      throw new Error('Keine gültige WAV-Datei erzeugt.');
    }
    URL.revokeObjectURL(music.url);
    probes.push({ modelId: 'zero-webaudio-synth', category: 'Musik & SFX', probeResponse: 'webaudio-wav:' + music.blob.size + 'bytes' });
  } catch (error) {
    failures.push('Musik/WebAudio: ' + (error instanceof Error ? error.message : 'Test fehlgeschlagen'));
  }

  return { probes, failures };
}

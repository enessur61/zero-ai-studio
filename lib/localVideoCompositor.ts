import type { FilmScene } from '../types/zero.ts';
import { normalizeSceneDurationsForRender } from '../server/filmLimits.ts';

export interface VideoRenderOptions {
  scenes: FilmScene[];
  aspectRatio: '16:9' | '9:16';
  burnSubtitles: boolean;
  audioUrl?: string;
  includeSceneVoiceovers?: boolean;
  onProgress?: (pct: number, label: string) => void;
}

export interface VideoRenderResult {
  videoUrl: string;
  mimeType: string;
  durationSec: number;
  sizeBytes: number;
  hasAudioTrack: boolean;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild konnte nicht geladen werden: ${src.slice(0, 64)}`));
    img.src = src;
  });
}

async function decodeAudioFromUrl(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    if (!arr.byteLength) throw new Error('leere Audiodatei');
    return await ctx.decodeAudioData(arr);
  } catch {
    throw new Error(
      'Eine ausgewählte Audiospur konnte nicht geladen oder dekodiert werden. Bitte eine gültige WAV-, MP3- oder M4A-Datei auswählen.'
    );
  }
}

function drawCoverFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  width: number,
  height: number,
  progress: number,
  movement: FilmScene['cameraMovement'],
  title: string,
  subtitle: string,
  burnSubtitles: boolean,
  alpha = 1
): void {
  ctx.save();
  ctx.globalAlpha = alpha;

  if (!img) {
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#0D1320');
    grad.addColorStop(1, '#1A2338');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#94A3B8';
    ctx.font = '600 22px Manrope, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, height / 2);
  } else {
    const baseScale = Math.max(width / img.width, height / img.height);
    let zoom = 1.05;
    let panX = 0;
    let panY = 0;

    if (movement === 'Langsamer Zoom-In') {
      zoom = 1.02 + progress * 0.14;
    } else if (movement === 'Sanfter Zoom-Out') {
      zoom = 1.16 - progress * 0.13;
    } else if (movement === 'Schwenk Links') {
      zoom = 1.12;
      panX = (0.5 - progress) * 70;
    } else if (movement === 'Schwenk Rechts') {
      zoom = 1.12;
      panX = (progress - 0.5) * 70;
    } else if (movement === 'Vertikaler Tilt') {
      zoom = 1.12;
      panY = (0.5 - progress) * 50;
    }

    const drawW = img.width * baseScale * zoom;
    const drawH = img.height * baseScale * zoom;
    const drawX = (width - drawW) / 2 + panX;
    const drawY = (height - drawH) / 2 + panY;
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  }

  // Subtle cinema bottom scrim for subtitle readability
  if (burnSubtitles && subtitle) {
    const scrim = ctx.createLinearGradient(0, height * 0.65, 0, height);
    scrim.addColorStop(0, 'rgba(0,0,0,0)');
    scrim.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, height * 0.65, width, height * 0.35);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = `600 ${width > height ? 26 : 24}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'center';
    const maxW = width * 0.84;
    const words = subtitle.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (ctx.measureText(test).width > maxW && current) {
        lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    lines.slice(-2).forEach((line, i, arr) => {
      const y = height - 42 - (arr.length - 1 - i) * 34;
      ctx.fillText(line, width / 2, y);
    });
  }

  ctx.restore();
}

export async function renderTimelineVideoMax60s(
  options: VideoRenderOptions
): Promise<VideoRenderResult> {
  const { scenes, aspectRatio, burnSubtitles, audioUrl, includeSceneVoiceovers = true, onProgress } =
    options;
  const renderScenes = normalizeSceneDurationsForRender(scenes);
  if (!renderScenes.length) {
    throw new Error('Keine Szenen zum Rendern vorhanden.');
  }

  // HARD CAP: MAXIMAL 60 SEKUNDEN
  const rawTotal = renderScenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  if (rawTotal > 60) {
    throw new Error(
      `Videolimit überschritten (${rawTotal}s > 60s). ZERO AI STUDIO erlaubt maximal 60 Sekunden pro Video.`
    );
  }

  const width = aspectRatio === '9:16' ? 540 : 960;
  const height = aspectRatio === '9:16' ? 960 : 540;
  const fps = 24;

  onProgress?.(5, 'Lade Szenenbilder...');
  const loadedImages = await Promise.all(
    renderScenes.map(async (s) => {
      if (!s.imageUrl) return null;
      try {
        return await loadImage(s.imageUrl);
      } catch {
        return null;
      }
    })
  );
  const failedImageIndex = renderScenes.findIndex(
    (scene, index) => Boolean(scene.imageUrl) && !loadedImages[index]
  );
  if (failedImageIndex >= 0) {
    throw new Error(
      `Das Szenenbild für „${renderScenes[failedImageIndex].title}“ konnte nicht geladen werden.`
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D Kontext nicht verfügbar.');

  const canvasStream = canvas.captureStream(fps);
  const combinedTracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

  // Optional real audio mixing via WebAudio MediaStreamAudioDestinationNode
  let audioCtx: AudioContext | null = null;
  let hasAudioTrack = false;
  const scheduledSources: AudioBufferSourceNode[] = [];

  const hasVoiceovers = includeSceneVoiceovers && renderScenes.some((s) => Boolean(s.audioDataUrl));
  if (audioUrl || hasVoiceovers) {
    try {
      onProgress?.(8, 'Dekodiere Audiospuren...');
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AudioCtx();
      const dest = audioCtx.createMediaStreamDestination();

      if (audioUrl) {
        const bgBuf = await decodeAudioFromUrl(audioCtx, audioUrl);
        const bgSource = audioCtx.createBufferSource();
        bgSource.buffer = bgBuf;
        bgSource.loop = bgBuf.duration < rawTotal;
        const bgGain = audioCtx.createGain();
        bgGain.gain.value = hasVoiceovers ? 0.38 : 0.85;
        bgSource.connect(bgGain).connect(dest);
        scheduledSources.push(bgSource);
        hasAudioTrack = true;
      }

      if (hasVoiceovers) {
        let offsetSec = 0;
        for (const sc of renderScenes) {
          if (sc.audioDataUrl) {
            const voiceBuf = await decodeAudioFromUrl(audioCtx, sc.audioDataUrl);
            const voiceSource = audioCtx.createBufferSource();
            voiceSource.buffer = voiceBuf;
            const vGain = audioCtx.createGain();
            vGain.gain.value = 1.0;
            voiceSource.connect(vGain).connect(dest);
            // Store start offset in custom property
            (voiceSource as AudioBufferSourceNode & { _startOffset?: number })._startOffset =
              offsetSec;
            (voiceSource as AudioBufferSourceNode & { _maxDur?: number })._maxDur = sc.durationSec;
            scheduledSources.push(voiceSource);
            hasAudioTrack = true;
          }
          offsetSec += sc.durationSec;
        }
      }

      if (hasAudioTrack) {
        dest.stream.getAudioTracks().forEach((t) => combinedTracks.push(t));
      } else {
        await audioCtx.close();
        audioCtx = null;
      }
    } catch (audioError) {
      if (audioCtx) {
        await audioCtx.close().catch(() => {});
        audioCtx = null;
      }
      throw audioError;
    }
  }

  const finalStream = new MediaStream(combinedTracks);
  const preferredMimes = hasAudioTrack
    ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ]
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mimeType = preferredMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const recorder = mimeType
    ? new MediaRecorder(finalStream, { mimeType, videoBitsPerSecond: 2_500_000 })
    : new MediaRecorder(finalStream);

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    };
  });

  // Hard runtime safety stop strictly enforcing <= 60.0s
  const hardTimeoutId = window.setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
    }
  }, 60_000);

  recorder.start(250);

  if (audioCtx && scheduledSources.length > 0) {
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }
    const baseTime = audioCtx.currentTime;
    for (const src of scheduledSources) {
      const tagged = src as AudioBufferSourceNode & { _startOffset?: number; _maxDur?: number };
      const offset = tagged._startOffset ?? 0;
      const dur = tagged._maxDur ? Math.min(tagged._maxDur, Math.max(0.5, rawTotal - offset)) : rawTotal;
      src.start(baseTime + offset, 0, Math.min(dur, 60));
    }
  }

  const totalFrames = Math.floor(rawTotal * fps);
  let frameIndex = 0;

  try {
    for (let sIdx = 0; sIdx < renderScenes.length; sIdx++) {
      const scene = renderScenes[sIdx];
      const img = loadedImages[sIdx];
      const sceneFrames = Math.floor(scene.durationSec * fps);

      for (let f = 0; f < sceneFrames; f++) {
        if (recorder.state !== 'recording') break;
        const progress = f / Math.max(1, sceneFrames - 1);
        ctx.fillStyle = '#090B10';
        ctx.fillRect(0, 0, width, height);

        const fadeInAlpha = f < 10 ? f / 10 : 1;
        drawCoverFrame(
          ctx,
          img,
          width,
          height,
          progress,
          scene.cameraMovement,
          scene.title,
          scene.subtitleText || scene.narrationText,
          burnSubtitles,
          fadeInAlpha
        );

        frameIndex++;
        if (frameIndex % 12 === 0) {
          const pct = Math.min(98, Math.round(10 + (frameIndex / totalFrames) * 88));
          onProgress?.(pct, `Rendere Szene ${sIdx + 1}/ ${renderScenes.length}...`);
        }
        await new Promise((r) => setTimeout(r, 1000 / fps));
      }
    }
  } finally {
    window.clearTimeout(hardTimeoutId);
    if (recorder.state === 'recording') {
      recorder.stop();
    }
    scheduledSources.forEach((s) => {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    });
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
    }
  }

  const blob = await stopped;
  onProgress?.(100, 'Export abgeschlossen');

  return {
    videoUrl: URL.createObjectURL(blob),
    mimeType: blob.type || 'video/webm',
    durationSec: rawTotal,
    sizeBytes: blob.size,
    hasAudioTrack,
  };
}

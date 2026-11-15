export interface MusicParams {
  title: string;
  mood: string;
  bpm: number;
  rootMidi: number;
  scaleIntervals: number[];
  padBrightness: number;
  pulseIntensity: number;
  subBassLevel: number;
  durationSec: number;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function scheduleTrack(ctx: BaseAudioContext, params: MusicParams): void {
  const duration = Math.min(60, Math.max(4, params.durationSec));
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.001, 0);
  master.gain.linearRampToValueAtTime(0.7, 1.2);
  master.gain.setValueAtTime(0.7, Math.max(1.3, duration - 1.5));
  master.gain.linearRampToValueAtTime(0.0001, duration);
  master.connect(ctx.destination);

  const intervals = params.scaleIntervals?.length ? params.scaleIntervals : [0, 2, 3, 7, 8, 10];
  const rootFreq = midiToFreq(params.rootMidi || 40);

  // 1. Sub-Bass Drone
  const subOsc = ctx.createOscillator();
  const subGain = ctx.createGain();
  subOsc.type = 'sine';
  subOsc.frequency.setValueAtTime(rootFreq * 0.5, 0);
  subGain.gain.setValueAtTime(0.28 * (params.subBassLevel ?? 0.7), 0);
  subOsc.connect(subGain);
  subGain.connect(master);
  subOsc.start(0);
  subOsc.stop(duration);

  // 2. Atmospheric Dark Pad
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.setValueAtTime(260 + (params.padBrightness ?? 0.4) * 900, 0);
  padFilter.Q.value = 1.8;
  padFilter.connect(master);

  [0, intervals[2 % intervals.length], intervals[3 % intervals.length]].forEach((semitone, idx) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = idx === 0 ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(midiToFreq((params.rootMidi || 40) + 12 + semitone), 0);
    osc.detune.setValueAtTime(idx === 1 ? -6 : idx === 2 ? 7 : 0, 0);
    g.gain.setValueAtTime(0.08, 0);
    osc.connect(g);
    g.connect(padFilter);
    osc.start(0);
    osc.stop(duration);
  });

  // 3. Tension Sequencer Pulse
  const beatSec = 60 / Math.max(55, Math.min(160, params.bpm || 84));
  const stepSec = beatSec / 2;
  const totalSteps = Math.floor(duration / stepSec);
  const pulseAmt = params.pulseIntensity ?? 0.6;

  if (pulseAmt > 0.05) {
    for (let s = 0; s < totalSteps; s++) {
      const t = s * stepSec;
      if (s % 2 === 0 || s % 5 === 0) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const filt = ctx.createBiquadFilter();
        filt.type = 'bandpass';
        filt.frequency.setValueAtTime(550 + (s % 4) * 180, t);
        const noteInterval = intervals[s % intervals.length];
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(midiToFreq((params.rootMidi || 40) + 12 + noteInterval), t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.14 * pulseAmt, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + stepSec * 0.85);
        osc.connect(filt);
        filt.connect(g);
        g.connect(master);
        osc.start(t);
        osc.stop(t + stepSec * 0.9);
      }
    }
  }
}

export async function renderMusicToWavUrl(params: MusicParams): Promise<{ url: string; blob: Blob }> {
  const sampleRate = 24000;
  const duration = Math.min(60, Math.max(4, params.durationSec));
  const offline = new OfflineAudioContext(2, Math.floor(sampleRate * duration), sampleRate);
  scheduleTrack(offline, { ...params, durationSec: duration });
  const rendered = await offline.startRendering();
  const blob = audioBufferToWavBlob(rendered);
  return { url: URL.createObjectURL(blob), blob };
}

export type SfxKind = 'impact' | 'riser' | 'heartbeat' | 'metallic';

export async function renderSfxToWavUrl(kind: SfxKind): Promise<{ url: string; blob: Blob; durationSec: number }> {
  const durationSec = kind === 'riser' ? 4 : kind === 'heartbeat' ? 3 : 2;
  const sampleRate = 24000;
  const offline = new OfflineAudioContext(1, sampleRate * durationSec, sampleRate);
  const master = offline.createGain();
  master.gain.value = 0.8;
  master.connect(offline.destination);

  if (kind === 'impact') {
    const osc = offline.createOscillator();
    const g = offline.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, 0);
    osc.frequency.exponentialRampToValueAtTime(32, 1.5);
    g.gain.setValueAtTime(0.9, 0);
    g.gain.exponentialRampToValueAtTime(0.001, 1.9);
    osc.connect(g);
    g.connect(master);
    osc.start(0);
    osc.stop(2);
  } else if (kind === 'riser') {
    const osc = offline.createOscillator();
    const g = offline.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(65, 0);
    osc.frequency.exponentialRampToValueAtTime(620, 3.8);
    const filter = offline.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(200, 0);
    filter.frequency.exponentialRampToValueAtTime(2600, 3.8);
    g.gain.setValueAtTime(0.01, 0);
    g.gain.linearRampToValueAtTime(0.6, 3.7);
    g.gain.linearRampToValueAtTime(0.001, 4.0);
    osc.connect(filter);
    filter.connect(g);
    g.connect(master);
    osc.start(0);
    osc.stop(4);
  } else if (kind === 'heartbeat') {
    [0, 0.28, 1.0, 1.28, 2.0, 2.28].forEach((t, i) => {
      const osc = offline.createOscillator();
      const g = offline.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(i % 2 === 0 ? 68 : 56, t);
      osc.frequency.exponentialRampToValueAtTime(28, t + 0.18);
      g.gain.setValueAtTime(i % 2 === 0 ? 0.85 : 0.6, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + 0.24);
    });
  } else {
    [220, 311, 466, 659].forEach((freq) => {
      const osc = offline.createOscillator();
      const g = offline.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, 0);
      g.gain.setValueAtTime(0.22, 0);
      g.gain.exponentialRampToValueAtTime(0.001, 1.9);
      osc.connect(g);
      g.connect(master);
      osc.start(0);
      osc.stop(2);
    });
  }

  const rendered = await offline.startRendering();
  const blob = audioBufferToWavBlob(rendered);
  return { url: URL.createObjectURL(blob), blob, durationSec };
}

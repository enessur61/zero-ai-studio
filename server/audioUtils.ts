export interface PcmWavOptions {
  sampleRate?: number;
  channels?: number;
}

/**
 * Gemini speech generation returns raw 16-bit PCM, not a WAV container.
 * Wrap the PCM bytes in a valid RIFF/WAVE header before exposing an audio/wav URL.
 */
export function pcmBase64ToWavDataUrl(
  base64Pcm: string,
  mimeType?: string,
  options: PcmWavOptions = {}
): string {
  if (!base64Pcm || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Pcm)) {
    throw new Error('TTS-Antwort enthält keine gültigen PCM-Audiodaten.');
  }

  const normalizedMime = (mimeType ?? '').toLowerCase();
  const decoded = Buffer.from(base64Pcm, 'base64');
  const canonicalBase64 = decoded.toString('base64').replace(/=+$/, '');
  if (!decoded.length || canonicalBase64 !== base64Pcm.replace(/=+$/, '')) {
    throw new Error('TTS-Antwort enthält keine gültigen Audiodaten.');
  }

  // Gemini 3.8 unary TTS normally returns a complete WAV file. Detect the
  // container itself so a missing MIME field can never cause a double header.
  const hasWavHeader =
    decoded.length >= 44 &&
    decoded.toString('ascii', 0, 4) === 'RIFF' &&
    decoded.toString('ascii', 8, 12) === 'WAVE';
  if (hasWavHeader) return `data:audio/wav;base64,${base64Pcm}`;

  const mimeRate = normalizedMime.match(/(?:rate|samplerate)=(\\d+)/)?.[1];
  const mimeChannels = normalizedMime.match(/channels=(\\d+)/)?.[1];
  const sampleRate = options.sampleRate ?? (mimeRate ? Number(mimeRate) : 24_000);
  const channels = options.channels ?? (mimeChannels ? Number(mimeChannels) : 1);
  const bitsPerSample = 16;

  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error('TTS-Audio hat eine ungültige Abtastrate.');
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error('TTS-Audio hat eine ungültige Kanalanzahl.');
  }

  const pcm = decoded;
  const blockAlign = channels * (bitsPerSample / 8);
  if (pcm.length === 0 || pcm.length % blockAlign !== 0) {
    throw new Error('TTS-Audio enthält unvollständige PCM-Samples.');
  }

  const byteRate = sampleRate * blockAlign;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

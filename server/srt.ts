export type TimedWordAnnotation = {
  word?: string;
  startOffset?: string;
  endOffset?: string;
};

type TimedWord = { text: string; startMs: number; endMs: number };

function parseOffsetMs(offset?: string): number | null {
  if (!offset) return null;
  const match = /^\\s*(\\d+(?:\\.\\d+)?)s\\s*$/i.exec(offset);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
}

function formatSrtTime(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const remainder = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
}

/** Build valid SRT cues only from real provider-supplied word timestamps. */
export function buildSrtFromTimedWords(words: TimedWordAnnotation[]): {
  srt: string | null;
  subtitleCueCount: number;
} {
  const timedWords: TimedWord[] = words.flatMap((word) => {
    const text = String(word.word ?? '').trim();
    const startMs = parseOffsetMs(word.startOffset);
    const endMs = parseOffsetMs(word.endOffset);
    return text && startMs !== null && endMs !== null && endMs > startMs
      ? [{ text, startMs, endMs }]
      : [];
  });

  const subtitleCues: Array<{ startMs: number; endMs: number; text: string }> = [];
  let cueWords: TimedWord[] = [];
  const flushCue = () => {
    if (!cueWords.length) return;
    subtitleCues.push({
      startMs: cueWords[0].startMs,
      endMs: cueWords[cueWords.length - 1].endMs,
      text: cueWords.map((word) => word.text).join(' '),
    });
    cueWords = [];
  };

  for (const word of timedWords) {
    const first = cueWords[0];
    const durationExceeded = first ? word.endMs - first.startMs > 3_500 : false;
    if (first && (cueWords.length >= 7 || durationExceeded)) flushCue();
    cueWords.push(word);
    if (/[.!?]$/.test(word.text)) flushCue();
  }
  flushCue();

  const srt = subtitleCues
    .map((cue, index) => `${index + 1}\\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\\n${cue.text}`)
    .join('\\n\\n');

  return { srt: srt || null, subtitleCueCount: subtitleCues.length };
}

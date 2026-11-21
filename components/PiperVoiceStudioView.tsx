import { useState, type FormEvent } from 'react';
import { Download, Loader2, Mic2, Volume2 } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';

const MAX_TEXT_LENGTH = 5000;

export function PiperVoiceStudioView() {
  const [text, setText] = useState('Willkommen bei ZERO AI STUDIO. Dies ist ein Sprachtest mit der deutschen Piper-Stimme Thorsten.');
  const [speed, setSpeed] = useState(1);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanText = text.trim();
    if (!cleanText || cleanText.length > MAX_TEXT_LENGTH || loading) return;

    setLoading(true);
    setError(null);
    setAudioUrl(null);
    try {
      const result = await apiRequest<{
        audioDataUrl: string;
        modelUsed: string;
        voice: string;
        costEur: number;
        paidFallback: boolean;
      }>('/api/audio/tts/piper', {
        method: 'POST',
        body: JSON.stringify({ text: cleanText, speed }),
      });

      if (!result.audioDataUrl?.startsWith('data:audio/wav;base64,')) {
        throw new Error('ZERO hat keine gültige WAV-Datei erhalten.');
      }
      if (result.paidFallback !== false || result.costEur !== 0) {
        throw new Error('Die Antwort erfüllt die ZERO-Vorgabe für 0 € externe TTS-Anbietergebühr nicht. Audio wurde nicht übernommen.');
      }
      setAudioUrl(result.audioDataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Piper-Spracherzeugung ist fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-teal-500/15 text-teal-300">
            <Mic2 className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-[0.24em] text-teal-300">BEYOND LIMITS.</p>
            <h1 className="text-2xl font-semibold text-white">ZERO VOICE STUDIO</h1>
          </div>
        </div>
        <p className="text-sm text-slate-400">
          Deutsche Sprachgenerierung mit Piper ONNX · Stimme Thorsten · keine externe TTS-API und keine kostenpflichtigen Fallbacks
        </p>
      </header>

      <form onSubmit={handleGenerate} className="space-y-5 rounded-2xl border border-white/[0.08] bg-[#11151E] p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-white">Deinen Sprechertext</h2>
          <span className="rounded-full border border-teal-500/25 bg-teal-500/10 px-3 py-1 text-xs text-teal-300">
            0 € Anbietergebühr · Piper auf ZERO-Worker
          </span>
        </div>
        <p className="text-xs leading-relaxed text-slate-500">
          Keine externe TTS-API-Gebühr pro Anfrage. Mögliche Kosten für Hosting, CPU und Speicher des ZERO-Workers sind nicht enthalten und hängen vom gewählten Hosting-Tarif ab.
        </p>

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT_LENGTH))}
          maxLength={MAX_TEXT_LENGTH}
          rows={8}
          placeholder="Gib hier deinen deutschen Sprechertext ein ..."
          className="min-h-44 w-full resize-y rounded-xl border border-white/10 bg-[#090B10] p-4 text-base leading-relaxed text-white outline-none placeholder:text-slate-500 focus:border-teal-400"
          aria-label="Sprechertext"
        />
        <div className="flex justify-end text-xs text-slate-500 tabular-nums">
          {text.length.toLocaleString('de-DE')} / {MAX_TEXT_LENGTH.toLocaleString('de-DE')} Zeichen
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="piper-speed" className="text-sm font-medium text-slate-200">Sprechgeschwindigkeit</label>
            <span className="rounded-lg bg-[#090B10] px-3 py-1.5 font-mono text-sm text-white">{speed.toFixed(2)}×</span>
          </div>
          <input
            id="piper-speed"
            type="range"
            min="0.75"
            max="1.25"
            step="0.05"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            className="w-full accent-teal-400"
          />
          <div className="flex justify-between text-[11px] text-slate-500">
            <span>Langsam · 0,75×</span>
            <span>Normal · 1,00×</span>
            <span>Schnell · 1,25×</span>
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !text.trim() || text.length > MAX_TEXT_LENGTH}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-500 px-5 text-sm font-semibold text-[#06201D] transition-colors hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Volume2 className="h-5 w-5" />}
          {loading ? 'Deine Stimme wird erzeugt …' : 'Sprache erzeugen'}
        </button>
        <p className="text-center text-xs text-slate-500">
          Ein einzelner Aufruf pro Klick · maximal 5.000 Zeichen · WAV-Ausgabe
        </p>
      </form>

      {audioUrl && (
        <section className="space-y-4 rounded-2xl border border-teal-500/25 bg-[#11151E] p-4 sm:p-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-teal-300">
            <Volume2 className="h-4 w-4" />
            Deine Sprachaufnahme ist bereit
          </div>
          <audio controls preload="metadata" src={audioUrl} className="w-full" />
          <a
            href={audioUrl}
            download="ZERO-Voice-Thorsten.wav"
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#090B10] px-4 text-sm font-medium text-white hover:bg-white/[0.06]"
          >
            <Download className="h-4 w-4" />
            WAV-Datei speichern
          </a>
        </section>
      )}
    </div>
  );
}

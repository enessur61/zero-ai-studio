import { useRef, useState } from 'react';
import { Check, Download, FolderPlus, Loader2, Mic, Square, Upload, Volume2 } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import {
  isNativeIOSCoreMLAvailable,
  runNativeIOSSynthesize,
} from '../lib/iosCoreMLBridge.ts';
import type { StudioProject } from '../types/zero.ts';

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface AudioStudioViewProps {
  projects: StudioProject[];
  onProjectUpdated: (p: StudioProject) => void;
}

export function AudioStudioView({ projects, onProjectUpdated }: AudioStudioViewProps) {
  const [text, setText] = useState(
    'Nichts im Rauschen passiert ohne Grund. Bei exakt vierhundertdreißig Hertz löste sich die Verzerrung.'
  );
  const [voiceName, setVoiceName] = useState<'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr'>(
    'Kore'
  );
  const [style, setStyle] = useState('Ruhige, cinematische deutsche Thriller-Erzählstimme');
  const [expressive, setExpressive] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [targetProjectId, setTargetProjectId] = useState(projects[0]?.id ?? '');
  const [savingAudio, setSavingAudio] = useState(false);
  const [savedAudioMsg, setSavedAudioMsg] = useState<string | null>(null);

  // Local Transcription
  const [recording, setRecording] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcriptSrt, setTranscriptSrt] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const nativeIOSActive = isNativeIOSCoreMLAvailable();

  async function handleGenerateTts(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || ttsLoading) return;
    setTtsLoading(true);
    setTtsError(null);
    try {
      const data = await apiRequest<{ audioDataUrl: string }>('/api/audio/tts', {
        method: 'POST',
        body: JSON.stringify({ text, voiceName, style, expressive }),
      });
      setAudioUrl(data.audioDataUrl);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'TTS fehlgeschlagen');
    } finally {
      setTtsLoading(false);
    }
  }

  function handleAppleWebSpeech() {
    if (!('speechSynthesis' in window)) {
      setTtsError('Web Speech API wird von diesem Browser nicht unterstützt.');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'de-DE';
    const voices = window.speechSynthesis.getVoices();
    const deVoice = voices.find((v) => v.lang.startsWith('de'));
    if (deVoice) utter.voice = deVoice;
    window.speechSynthesis.speak(utter);
  }

  async function handleNativeIOSAudio(modelId: 'piper-tts-de' | 'kokoro-82m') {
    if (!text.trim() || ttsLoading) return;
    setTtsLoading(true);
    setTtsError(null);
    try {
      const res = await runNativeIOSSynthesize({ modelId, text, voiceName });
      if (res.audioDataUrl) {
        setAudioUrl(res.audioDataUrl);
      }
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'Nativer iOS TTS fehlgeschlagen');
    } finally {
      setTtsLoading(false);
    }
  }

  function handleToggleLocalDictation() {
    if (dictating && recognitionRef.current) {
      recognitionRef.current.stop();
      setDictating(false);
      return;
    }
    setTranscribeError(null);
    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const Rec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!Rec) {
      setTranscribeError(
        'Browser-Spracherkennung wird von diesem Browser nicht unterstützt. Nutze „Mikrofon aufnehmen“ mit dem verfügbaren ZERO-Transkriptionsmodell.'
      );
      return;
    }
    const rec = new Rec();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (ev) => {
      let combined = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        combined += ev.results[i][0].transcript + ' ';
      }
      setTranscript(combined.trim());
      setTranscriptSrt(null);
    };
    rec.onerror = (ev) => {
      setTranscribeError(`Browser-Diktat: ${ev.error}`);
      setDictating(false);
    };
    rec.onend = () => {
      setDictating(false);
    };
    recognitionRef.current = rec;
    rec.start();
    setDictating(true);
  }

  async function sendAudioForTranscription(dataUrl: string) {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const data = await apiRequest<{ transcript: string; srt?: string | null }>('/api/audio/transcribe', {
        method: 'POST',
        body: JSON.stringify({ audioDataUrl: dataUrl }),
      });
      setTranscript(data.transcript);
      setTranscriptSrt(data.srt ?? null);
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : 'Transkription fehlgeschlagen');
    } finally {
      setTranscribing(false);
    }
  }

  async function handleToggleRecording() {
    if (recording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecording(false);
      return;
    }

    setTranscribeError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Mikrofonaufnahme wird von diesem Browser nicht unterstützt. Bitte eine Audiodatei auswählen.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (blob.size > 18 * 1024 * 1024) {
          setTranscribeError('Die Aufnahme ist größer als 18 MB. Bitte kürzer aufnehmen oder komprimieren.');
          return;
        }
        if (!blob.size) {
          setTranscribeError('Die Aufnahme enthält keine Audiodaten. Bitte erneut aufnehmen.');
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          void sendAudioForTranscription(String(reader.result));
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
    } catch (err) {
      setTranscribeError(
        err instanceof Error ? err.message : 'Mikrofonzugriff verweigert oder nicht verfügbar.'
      );
    }
  }

  function handleAudioUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 18 * 1024 * 1024) {
      setTranscribeError('Die Audiodatei ist größer als 18 MB. Bitte eine kleinere Datei auswählen.');
      e.target.value = '';
      return;
    }
    if (!file.type.startsWith('audio/')) {
      setTranscribeError('Bitte eine gültige Audiodatei auswählen.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:audio/')) {
        setTranscribeError('Die Audiodatei konnte nicht gelesen werden. Bitte erneut auswählen.');
        return;
      }
      void sendAudioForTranscription(reader.result);
    };
    reader.onerror = () => {
      setTranscribeError('Die Audiodatei konnte nicht gelesen werden. Bitte erneut auswählen.');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">ZERO AUDIO STUDIO</h1>
        <p className="text-xs text-slate-400 mt-1">
          Lokale Apple-Sprachausgabe · Gemini-Free-Tier-TTS · Cloudflare Whisper oder Gemini-Free für Transkription
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* TTS */}
        <form
          onSubmit={handleGenerateTts}
          className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4"
        >
          <h2 className="text-base font-semibold text-white">Text-to-Speech & Voiceover</h2>

          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Deutschen oder mehrsprachigen Sprechertext eingeben..."
            className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#2563EB]"
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Stimmenprofil</label>
              <select
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value as typeof voiceName)}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
              >
                <option value="Kore">Kore (Klar & Präzise)</option>
                <option value="Charon">Charon (Tief & Ruhig)</option>
                <option value="Fenrir">Fenrir (Markant)</option>
                <option value="Puck">Puck (Lebendig)</option>
                <option value="Zephyr">Zephyr (Warm)</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Modell</label>
              <select
                value={expressive ? 'flash' : 'lite'}
                onChange={(e) => setExpressive(e.target.value === 'flash')}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
              >
                <option value="lite">Gemini 3.8 Flash Lite TTS (Free Tier · API-Key)</option>
                <option value="flash">Gemini 3.8 Flash TTS Regie (Free Tier · API-Key)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">Regie-Anweisung</label>
            <input
              type="text"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
            />
          </div>

          {ttsError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {ttsError}
            </div>
          )}

          <div className="flex flex-wrap gap-2.5">
            <button
              type="submit"
              disabled={ttsLoading || !text.trim()}
              className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap"
            >
              {ttsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
              WAV generieren (Free Tier)
            </button>

            <button
              type="button"
              onClick={handleAppleWebSpeech}
              className="min-h-[44px] px-4 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white whitespace-nowrap"
            >
              iOS / Lokal vorlesen
            </button>

            {nativeIOSActive && (
              <button
                type="button"
                onClick={() => void handleNativeIOSAudio('piper-tts-de')}
                className="min-h-[44px] px-3.5 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 border border-teal-500/30 text-xs font-medium text-teal-300 whitespace-nowrap"
              >
                Piper ONNX (iOS Lokal)
              </button>
            )}
          </div>

          {audioUrl && (
            <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
              <audio src={audioUrl} controls className="w-full" />
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={audioUrl}
                  download={`zero-voice-${voiceName.toLowerCase()}.wav`}
                  className="min-h-[40px] px-3.5 rounded-xl bg-[#090B10] border border-white/[0.1] text-xs text-slate-200 inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  WAV herunterladen
                </a>
                {projects.length > 0 && (
                  <>
                    <select
                      value={targetProjectId || projects[0]?.id || ''}
                      onChange={(e) => setTargetProjectId(e.target.value)}
                      className="min-h-[40px] bg-[#090B10] border border-white/[0.1] rounded-xl px-2.5 text-xs text-slate-200"
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={savingAudio}
                      onClick={async () => {
                        const pid = targetProjectId || projects[0]?.id;
                        if (!pid || !audioUrl) return;
                        setSavingAudio(true);
                        setSavedAudioMsg(null);
                        try {
                          const res = await apiRequest<{ project: StudioProject }>(
                            `/api/projects/${pid}/assets`,
                            {
                              method: 'POST',
                              body: JSON.stringify({
                                type: 'audio',
                                title: `Voiceover (${voiceName}): ${text.slice(0, 36)}`,
                                url: audioUrl,
                                modelId: expressive
                                  ? 'gemini-3.8-flash-tts'
                                  : 'gemini-3.8-flash-lite-tts',
                              }),
                            }
                          );
                          onProjectUpdated(res.project);
                          setSavedAudioMsg(`In "${res.project.title}" gespeichert.`);
                        } catch (err) {
                          setTtsError(err instanceof Error ? err.message : 'Audio konnte nicht im Projekt gespeichert werden.');
                        } finally {
                          setSavingAudio(false);
                        }
                      }}
                      className="min-h-[40px] px-3.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-xs font-medium text-white inline-flex items-center gap-1.5"
                    >
                      {savingAudio ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : savedAudioMsg ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <FolderPlus className="w-3.5 h-3.5" />
                      )}
                      In Projekt speichern
                    </button>
                  </>
                )}
              </div>
              {savedAudioMsg && (
                <p className="text-xs text-emerald-400">{savedAudioMsg}</p>
              )}
            </div>
          )}
        </form>

        {/* STT & Subtitles */}
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4">
          <h2 className="text-base font-semibold text-white">
            Spracherkennung & Transkript
          </h2>
          <p className="text-xs text-slate-400">
            Mikrofonaufnahme direkt vom iPhone oder Audio-Datei hochladen — ZERO CORE nutzt bevorzugt das aktivierte Cloudflare-Whisper-Modell (gemeinsames Workers-AI-Free-Kontingent) oder ein aktiviertes Gemini-Free-Modell. Kein kostenpflichtiger Fallback. Browser-Diktat kann je nach Gerät eine Netzwerkverbindung benötigen.
          </p>

          <div className="flex flex-wrap gap-2.5">
            <button
              onClick={handleToggleRecording}
              className={`min-h-[44px] px-4 rounded-xl text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap ${
                recording
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-[#2563EB] hover:bg-[#1D4ED8] text-white'
              }`}
            >
              {recording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              {recording ? 'Aufnahme stoppen' : 'Mikrofon aufnehmen'}
            </button>

            <button
              type="button"
              onClick={handleToggleLocalDictation}
              className={`min-h-[44px] px-3.5 rounded-xl border text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap ${
                dictating
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-white/[0.06] hover:bg-white/[0.1] border-white/[0.08] text-white'
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              {dictating ? 'Diktat stoppen' : 'Browser-Diktat (0 €)'}
            </button>

            <label className="min-h-[44px] px-4 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white inline-flex items-center gap-2 cursor-pointer whitespace-nowrap">
              <Upload className="w-4 h-4" />
              Audiodatei wählen
              <input type="file" accept="audio/*" onChange={handleAudioUpload} className="hidden" />
            </label>
          </div>

          {transcribing && (
            <div className="p-4 rounded-xl bg-[#090B10] border border-white/[0.08] text-xs text-slate-300 inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Audio wird transkribiert...
            </div>
          )}

          {transcribeError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {transcribeError}
            </div>
          )}

          <div className="p-4 rounded-xl bg-[#090B10] border border-white/[0.08] min-h-[180px] text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">
            {transcript || 'Noch keine Transkription vorhanden.'}
          </div>
          {transcriptSrt && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3">
              <p className="text-xs text-emerald-300">Echte Wort-Zeitstempel erkannt · {transcriptSrt.split(/\n\n/).length} Untertitelblöcke</p>
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([transcriptSrt], { type: 'application/x-subrip;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = 'zero-transkript.srt';
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
                className="min-h-[40px] rounded-xl bg-[#2563EB] px-3.5 text-xs font-medium text-white inline-flex items-center gap-2"
              >
                <Download className="h-3.5 w-3.5" />
                SRT herunterladen
              </button>
            </div>
          )}
          {transcript && !transcriptSrt && !dictating && !transcribing && (
            <p className="text-[11px] text-slate-500">Für dieses Transkript wurden keine verlässlichen Wort-Zeitstempel geliefert; daher wird keine SRT-Datei erfunden.</p>
          )}
        </div>
      </div>
    </div>
  );
}

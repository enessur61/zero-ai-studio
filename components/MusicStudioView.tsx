import { useEffect, useRef, useState } from 'react';
import { Check, Download, Film, FolderPlus, Loader2, Music, Sparkles, Volume2 } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { ObjectUrlLease } from '../lib/objectUrlLease.ts';
import {
  type MusicParams,
  renderMusicToWavUrl,
  renderSfxToWavUrl,
  type SfxKind,
} from '../lib/localAudioSynth.ts';
import type { StudioProject } from '../types/zero.ts';

interface MusicStudioViewProps {
  projects: StudioProject[];
  onProjectUpdated: (p: StudioProject) => void;
  onUseInVideoStudio: (url: string, title: string) => void;
}

async function blobUrlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export function MusicStudioView({
  projects,
  onProjectUpdated,
  onUseInVideoStudio,
}: MusicStudioViewProps) {
  const [prompt, setPrompt] = useState(
    'Dunkler Berliner Neo-Noir Thriller Soundtrack, tiefer Sub-Bass, analoger Puls, geheimnisvolle Spannung'
  );
  const [durationSec, setDurationSec] = useState(25);
  const [params, setParams] = useState<MusicParams>({
    title: 'Berlin 432 Hz Spannung',
    mood: 'Thriller / Atmosphärisch',
    bpm: 84,
    rootMidi: 40,
    scaleIntervals: [0, 2, 3, 7, 8, 10],
    padBrightness: 0.42,
    pulseIntensity: 0.65,
    subBassLevel: 0.78,
    durationSec: 25,
  });

  const [composing, setComposing] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const [sfxUrl, setSfxUrl] = useState<{ label: string; url: string } | null>(null);
  const objectUrlLeaseRef = useRef(new ObjectUrlLease());
  const trackUrlRef = useRef<string | null>(null);
  const sfxUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    objectUrlLeaseRef.current.releaseAll();
  }, []);

  function replaceTrackUrl(url: string) {
    objectUrlLeaseRef.current.release(trackUrlRef.current);
    objectUrlLeaseRef.current.adopt(url);
    trackUrlRef.current = url;
    setTrackUrl(url);
  }

  function replaceSfxUrl(next: { label: string; url: string }) {
    objectUrlLeaseRef.current.release(sfxUrlRef.current);
    objectUrlLeaseRef.current.adopt(next.url);
    sfxUrlRef.current = next.url;
    setSfxUrl(next);
  }

  const [error, setError] = useState<string | null>(null);
  const [targetProjectId, setTargetProjectId] = useState(projects[0]?.id ?? '');
  const [savingMusic, setSavingMusic] = useState(false);
  const [savedMusicMsg, setSavedMusicMsg] = useState<string | null>(null);

  async function handleComposeAndRender(e: React.FormEvent) {
    e.preventDefault();
    if (composing || rendering) return;
    setError(null);
    setComposing(true);
    try {
      const data = await apiRequest<{ composition: MusicParams }>('/api/music/compose', {
        method: 'POST',
        body: JSON.stringify({ prompt, durationSec }),
      });
      setParams(data.composition);
      setComposing(false);
      setRendering(true);
      const rendered = await renderMusicToWavUrl(data.composition);
      replaceTrackUrl(rendered.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Musikproduktion fehlgeschlagen');
    } finally {
      setComposing(false);
      setRendering(false);
    }
  }

  async function handleRenderCurrentParams() {
    setRendering(true);
    setError(null);
    try {
      const rendered = await renderMusicToWavUrl({ ...params, durationSec });
      setTrackUrl(rendered.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Synthese fehlgeschlagen');
    } finally {
      setRendering(false);
    }
  }

  async function handleSfx(kind: SfxKind, label: string) {
    const res = await renderSfxToWavUrl(kind);
    replaceSfxUrl({ label, url: res.url });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">ZERO MUSIC STUDIO</h1>
        <p className="text-xs text-slate-400 mt-1">
          Rechtefreie Thriller-, Atmosphären- & Spannungsmusik + Soundeffekte über lokale Web-Audio-Synthese (100% lizenzfrei · 0 €)
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleComposeAndRender}
          className="lg:col-span-6 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4"
        >
          <div className="flex items-center gap-3">
            <img
              src="/assets/images/scene_studio_synth_1794745338615.jpg"
              alt="Analoges Mastering Studio"
              referrerPolicy="no-referrer"
              className="w-16 h-12 rounded-xl object-cover border border-white/[0.08]"
            />
            <div>
              <h2 className="text-base font-semibold text-white">KI-Komposition & Synthesizer</h2>
              <p className="text-xs text-slate-400">
                Gemini 3.8 Flash entwirft Harmonik & Tempo; WebAudio rendert lokal ins WAV-Format.
              </p>
            </div>
          </div>

          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3.5 text-sm text-white focus:outline-none focus:border-[#2563EB]"
          />

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Dauer (max 60s)</label>
              <input
                type="number"
                min={10}
                max={60}
                value={durationSec}
                onChange={(e) => setDurationSec(Math.min(60, Math.max(10, Number(e.target.value))))}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-sm font-mono text-white"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Tempo (BPM)</label>
              <input
                type="number"
                min={55}
                max={160}
                value={params.bpm}
                onChange={(e) => setParams({ ...params, bpm: Number(e.target.value) })}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-sm font-mono text-white"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Puls-Intensität</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={params.pulseIntensity}
                onChange={(e) => setParams({ ...params, pulseIntensity: Number(e.target.value) })}
                className="w-full mt-3"
              />
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2.5">
            <button
              type="submit"
              disabled={composing || rendering}
              className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap"
            >
              {composing || rendering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              KI komponieren & rendern
            </button>

            <button
              type="button"
              onClick={handleRenderCurrentParams}
              disabled={rendering}
              className="min-h-[44px] px-4 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white whitespace-nowrap"
            >
              Direkt lokal rendern
            </button>
          </div>
        </form>

        {/* Output & SFX */}
        <div className="lg:col-span-6 space-y-4">
          <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-400">{params.mood} · {params.bpm} BPM</p>
                <h3 className="text-base font-semibold text-white">{params.title}</h3>
              </div>
              <Music className="w-5 h-5 text-slate-400" />
            </div>

            {trackUrl ? (
              <div className="space-y-3 pt-2">
                <audio src={trackUrl} controls className="w-full" />
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={trackUrl}
                    download={`zero-soundtrack-${params.bpm}bpm.wav`}
                    className="min-h-[42px] px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white inline-flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    WAV exportieren
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      objectUrlLeaseRef.current.transfer(trackUrl);
                      onUseInVideoStudio(trackUrl, `${params.title} (${params.bpm} BPM)`);
                    }}
                    className="min-h-[42px] px-3.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-xs font-medium text-white inline-flex items-center gap-2"
                  >
                    <Film className="w-4 h-4" />
                    Für Video Studio übernehmen
                  </button>
                </div>

                {projects.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/[0.06]">
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
                      disabled={savingMusic}
                      onClick={async () => {
                        const pid = targetProjectId || projects[0]?.id;
                        if (!pid || !trackUrl) return;
                        setSavingMusic(true);
                        setSavedMusicMsg(null);
                        try {
                          const dataUrl = await blobUrlToDataUrl(trackUrl);
                          const res = await apiRequest<{ project: StudioProject }>(
                            `/api/projects/${pid}/assets`,
                            {
                              method: 'POST',
                              body: JSON.stringify({
                                type: 'music',
                                title: `${params.title} (${durationSec}s · ${params.bpm} BPM)`,
                                url: dataUrl,
                                durationSec,
                                modelId: 'webaudio-procedural-synth',
                              }),
                            }
                          );
                          onProjectUpdated(res.project);
                          setSavedMusicMsg(`Soundtrack in "${res.project.title}" gespeichert.`);
                        } finally {
                          setSavingMusic(false);
                        }
                      }}
                      className="min-h-[40px] px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-white inline-flex items-center gap-1.5"
                    >
                      {savingMusic ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : savedMusicMsg ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <FolderPlus className="w-3.5 h-3.5" />
                      )}
                      In Projekt speichern
                    </button>
                  </div>
                )}
                {savedMusicMsg && <p className="text-xs text-emerald-400">{savedMusicMsg}</p>}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-4">
                Klicke auf „KI komponieren & rendern“, um eine lizenzfreie WAV-Audiospur zu erzeugen.
              </p>
            )}
          </div>

          <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-white">Soundeffekte (On-Device SFX)</h3>
            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  ['impact', 'Sub-Bass Impact'],
                  ['riser', 'Spannungs-Riser (4s)'],
                  ['heartbeat', 'Herzschlag-Puls'],
                  ['metallic', 'Metallischer Hall'],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  onClick={() => handleSfx(kind, label)}
                  className="min-h-[44px] px-3 rounded-xl bg-[#090B10] hover:bg-white/[0.06] border border-white/[0.08] text-xs font-medium text-slate-200 inline-flex items-center justify-center gap-2"
                >
                  <Volume2 className="w-3.5 h-3.5 text-slate-400" />
                  {label}
                </button>
              ))}
            </div>

            {sfxUrl && (
              <div className="pt-2 border-t border-white/[0.08] space-y-2">
                <p className="text-xs text-slate-300">Aktiver SFX: {sfxUrl.label}</p>
                <audio src={sfxUrl.url} controls autoPlay className="w-full" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

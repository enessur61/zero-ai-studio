import { useEffect, useState } from 'react';
import {
  Clapperboard,
  Film,
  Loader2,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { renderTimelineVideoMax60s, type VideoRenderResult } from '../lib/localVideoCompositor.ts';
import { runAutonomousFilmProduction } from '../lib/filmProductionPipeline.ts';
import type { CharacterProfile, StudioProject } from '../types/zero.ts';

interface FilmDirectorViewProps {
  projects: StudioProject[];
  characters: CharacterProfile[];
  onProjectCreated: (p: StudioProject) => void;
  onProjectUpdated: (p: StudioProject) => void;
  onOpenVideoStudio: (projectId: string) => void;
}

export function FilmDirectorView({
  projects,
  characters,
  onProjectCreated,
  onProjectUpdated,
  onOpenVideoStudio,
}: FilmDirectorViewProps) {
  const [idea, setIdea] = useState(
    'Ein verlassener Berliner U-Bahn-Schacht sendet jede Nacht um 03:00 Uhr eine verschlüsselte Morse-Melodie.'
  );
  const [genre, setGenre] = useState('Neo-Noir Mystery Thriller');
  const [targetDurationSec, setTargetDurationSec] = useState(58);
  const [characterId, setCharacterId] = useState(characters[0]?.id ?? '');
  const [generateImages, setGenerateImages] = useState(true);
  const [directing, setDirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productionProgress, setProductionProgress] = useState({ percent: 0, label: '' });
  const [productionWarnings, setProductionWarnings] = useState<string[]>([]);
  const [productionVideo, setProductionVideo] = useState<VideoRenderResult | null>(null);
  const [productionVideoProjectId, setProductionVideoProjectId] = useState('');

  useEffect(() => () => {
    if (productionVideo?.videoUrl.startsWith('blob:')) URL.revokeObjectURL(productionVideo.videoUrl);
  }, [productionVideo]);

  const [activeProjectId, setActiveProjectId] = useState(projects[0]?.id ?? '');
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];

  const [regenSceneId, setRegenSceneId] = useState<string | null>(null);
  const [regenInstruction, setRegenInstruction] = useState(
    'Erhöhe Spannung und emotionale Wirkung; überarbeite Erzähltext, Dialog und Untertitel.'
  );
  const [ttsSceneId, setTtsSceneId] = useState<string | null>(null);

  async function handleCreateFilm(e: React.FormEvent) {
    e.preventDefault();
    if (!idea.trim() || directing) return;
    setDirecting(true);
    setError(null);
    setProductionWarnings([]);
    setProductionVideo(null);
    setProductionVideoProjectId('');
    setProductionProgress({ percent: 1, label: 'ZERO startet die autonome Episode...' });
    try {
      let defaultCharacter = characters.find((item) => item.id === characterId);
      const result = await runAutonomousFilmProduction({
        createDraft: async () => {
          const draft = await apiRequest<{
            project: StudioProject;
            imageGenerationWarnings?: string[];
          }>('/api/film/direct', {
            method: 'POST',
            body: JSON.stringify({
              idea: idea.trim(),
              genre,
              targetDurationSec: Math.min(60, Math.max(20, targetDurationSec)),
              characterId,
              generateImages,
            }),
          });
          defaultCharacter = characters.find((item) => draft.project.characterIds.includes(item.id)) || defaultCharacter;
          return draft;
        },
        generateVoiceover: async (scene) => {
          const sceneCharacter = characters.find((item) => scene.characterIds.includes(item.id)) || defaultCharacter;
          const tts = await apiRequest<{ audioDataUrl: string; modelUsed?: string }>('/api/audio/tts', {
            method: 'POST',
            body: JSON.stringify({
              text: scene.narrationText,
              voiceName: sceneCharacter?.voiceName || 'Kore',
              style: sceneCharacter?.voiceStyle || 'Ruhige, klare deutsche Thriller-Erzählstimme',
            }),
          });
          return { audioDataUrl: tts.audioDataUrl, modelUsed: tts.modelUsed };
        },
        saveProject: async (projectId, scenes) => {
          const saved = await apiRequest<{ project: StudioProject }>(`/api/projects/${projectId}`, {
            method: 'PUT',
            body: JSON.stringify({
              scenes,
              status: 'Schnittbereit',
              snapshotNote: 'ZERO autonome Episode: Szenen und verfügbare Voiceovers',
            }),
          });
          onProjectCreated(saved.project);
          setActiveProjectId(saved.project.id);
          return saved.project;
        },
        renderVideo: async (project, onRenderProgress) => renderTimelineVideoMax60s({
          scenes: project.scenes,
          aspectRatio: '9:16',
          burnSubtitles: true,
          includeSceneVoiceovers: true,
          onProgress: onRenderProgress,
        }),
      }, (progress) => setProductionProgress({
        percent: progress.percent,
        label: progress.label,
      }));
      setProductionWarnings(result.warnings);
      setProductionVideo(result.video);
      setProductionVideoProjectId(result.project.id);
      setActiveProjectId(result.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Autonome Episode fehlgeschlagen');
      setProductionProgress((current) => ({
        ...current,
        label: err instanceof Error ? err.message : 'Produktion wurde unterbrochen.',
      }));
    } finally {
      setDirecting(false);
    }
  }

  async function handleRegenerateScene(sceneId: string) {
    if (!activeProject || regenSceneId) return;
    setRegenSceneId(sceneId);
    setError(null);
    try {
      const data = await apiRequest<{ project: StudioProject }>('/api/film/regenerate-scene', {
        method: 'POST',
        body: JSON.stringify({
          projectId: activeProject.id,
          sceneId,
          instruction: regenInstruction,
        }),
      });
      onProjectUpdated(data.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Szenen-Update fehlgeschlagen');
    } finally {
      setRegenSceneId(null);
    }
  }

  async function handleGenerateSceneVoice(sceneId: string, narrationText: string) {
    if (!activeProject || ttsSceneId || !narrationText.trim()) return;
    setTtsSceneId(sceneId);
    setError(null);
    try {
      const char = characters.find((c) => activeProject.characterIds.includes(c.id));
      const tts = await apiRequest<{ audioDataUrl: string }>('/api/audio/tts', {
        method: 'POST',
        body: JSON.stringify({
          text: narrationText,
          voiceName: char?.voiceName || 'Kore',
          style: char?.voiceStyle || 'Ruhige deutsche Thriller-Erzählstimme',
        }),
      });
      const updatedScenes = activeProject.scenes.map((s) =>
        s.id === sceneId ? { ...s, audioDataUrl: tts.audioDataUrl, status: 'Szenenbereit' as const } : s
      );
      const saved = await apiRequest<{ project: StudioProject }>(
        `/api/projects/${activeProject.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            scenes: updatedScenes,
            snapshotNote: `Sprachaufnahme für Szene generiert`,
          }),
        }
      );
      onProjectUpdated(saved.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sprachgenerierung fehlgeschlagen');
    } finally {
      setTtsSceneId(null);
    }
  }

  const totalSec = activeProject?.scenes.reduce((sum, s) => sum + s.durationSec, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">ZERO FILM DIRECTOR</h1>
        <p className="text-xs text-slate-400 mt-1">
          Autonome Episode: Drehbuch, Szenen, verfügbare Gratis-Voiceovers, Schnitt und Hochkant-Export · Strikt max. 60 Sekunden
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Director Brief */}
        <form
          onSubmit={handleCreateFilm}
          className="lg:col-span-5 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4 h-fit"
        >
          <h2 className="text-base font-semibold text-white">Neue Filmidee umsetzen</h2>

          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Filmidee / Prämisse</label>
            <textarea
              rows={3}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3 text-sm text-white focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Genre</label>
              <input
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">
                Ziel-Dauer (20–60s)
              </label>
              <input
                type="number"
                min={20}
                max={60}
                value={targetDurationSec}
                onChange={(e) =>
                  setTargetDurationSec(Math.min(60, Math.max(20, Number(e.target.value))))
                }
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-sm font-mono text-white"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">Hauptfigur (Character Engine)</label>
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
            >
              <option value="">Automatische Figur</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.role})
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-300 min-h-[40px] cursor-pointer">
            <input
              type="checkbox"
              checked={generateImages}
              onChange={(event) => setGenerateImages(event.target.checked)}
              className="rounded bg-[#090B10] border-white/20"
            />
            Szenenbilder automatisch mit FLUX erzeugen (nur bei bestätigtem Cloudflare Workers Free-Plan und erfolgreichem Modelltest)
          </label>

          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={directing || !idea.trim()}
            className="w-full min-h-[46px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors"
          >
            {directing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Clapperboard className="w-4 h-4" />
            )}
            {directing ? 'ZERO produziert die Episode...' : 'Episode autonom produzieren & exportieren'}
          </button>
          {(directing || productionProgress.percent > 0) && (
            <div className="space-y-2 rounded-xl border border-white/[0.08] bg-[#090B10] p-3">
              <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
                <span>{productionProgress.label || 'ZERO wartet...'}</span>
                <span className="font-mono">{productionProgress.percent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full bg-[#2563EB] transition-all"
                  style={{ width: `${productionProgress.percent}%` }}
                />
              </div>
            </div>
          )}
          {productionWarnings.length > 0 && (
            <div className="space-y-1 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-xs text-amber-100">
              <p className="font-semibold">Produktionshinweise</p>
              {productionWarnings.map((warning, index) => <p key={index}>• {warning}</p>)}
            </div>
          )}
        </form>

        {/* Active Production Breakdown */}
        <div className="lg:col-span-7 space-y-4">
          {productionVideo && productionVideoProjectId === activeProject?.id && (
            <div className="space-y-3 rounded-2xl border border-emerald-400/20 bg-[#11151E] p-4">
              <div>
                <h2 className="text-sm font-semibold text-white">ZERO Episode – Videoexport bereit</h2>
                <p className="mt-1 text-xs text-slate-400">
                  {productionVideo.durationSec}s · {productionVideo.mimeType} · {productionVideo.sizeBytes.toLocaleString('de-DE')} Bytes · {productionVideo.hasAudioTrack ? 'mit Audiospur' : 'ohne Audiospur'}
                </p>
              </div>
              <video
                src={productionVideo.videoUrl}
                controls
                playsInline
                className="aspect-[9/16] max-h-[520px] w-auto max-w-full rounded-xl bg-black"
              />
              <button
                type="button"
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = productionVideo.videoUrl;
                  link.download = `${(activeProject?.title || 'zero-episode').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.${productionVideo.mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
                  link.click();
                }}
                className="min-h-[42px] rounded-xl bg-[#2563EB] px-4 text-xs font-semibold text-white"
              >
                Exportiertes Video herunterladen
              </button>
            </div>
          )}
          {activeProject && (
            <>
              <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <select
                      value={activeProject.id}
                      onChange={(e) => setActiveProjectId(e.target.value)}
                      className="bg-[#090B10] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-slate-300 mb-2"
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                    <h2 className="text-lg font-semibold text-white">{activeProject.title}</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {activeProject.genre} · {activeProject.scenes.length} Szenen ·{' '}
                      <span className="font-mono text-emerald-400">{totalSec}s / 60s</span>
                    </p>
                  </div>

                  <button
                    onClick={() => onOpenVideoStudio(activeProject.id)}
                    className="min-h-[42px] px-4 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Film className="w-4 h-4" />
                    Im Video Studio schneiden
                  </button>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">{activeProject.story}</p>

                <div className="pt-2 border-t border-white/[0.06]">
                  <label className="text-[11px] text-slate-400 block mb-1">
                    Regie-Anweisung für Einzel-Szenen-Neugenerierung:
                  </label>
                  <input
                    type="text"
                    value={regenInstruction}
                    onChange={(e) => setRegenInstruction(e.target.value)}
                    className="w-full min-h-[38px] bg-[#090B10] border border-white/[0.1] rounded-lg px-3 text-xs text-white"
                  />
                </div>
              </div>

              <div className="space-y-3">
                {activeProject.scenes.map((sc) => (
                  <div
                    key={sc.id}
                    className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row gap-4">
                      <div className="w-full sm:w-44 aspect-video rounded-xl overflow-hidden bg-[#090B10] border border-white/[0.07] shrink-0">
                        {sc.imageUrl ? (
                          <img
                            src={sc.imageUrl}
                            alt={sc.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                            Entwurf ohne Bild
                          </div>
                        )}
                      </div>

                      <div className="flex-1 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-xs text-slate-400">
                              Szene {sc.index} · {sc.location} · {sc.cameraMovement}
                            </p>
                            <h3 className="text-sm font-semibold text-white">{sc.title}</h3>
                          </div>
                          <span className="text-xs font-mono text-slate-300">{sc.durationSec}s</span>
                        </div>

                        <p className="text-xs text-slate-200 leading-relaxed">
                          <span className="text-slate-500">Sprecher: </span>
                          {sc.narrationText}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          Sound: {sc.soundCue}
                        </p>

                        {sc.audioDataUrl && (
                          <audio src={sc.audioDataUrl} controls className="w-full h-8 mt-1" />
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.06]">
                      <button
                        onClick={() => handleRegenerateScene(sc.id)}
                        disabled={regenSceneId === sc.id}
                        className="min-h-[38px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs text-white inline-flex items-center gap-1.5"
                      >
                        {regenSceneId === sc.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        Szene neu generieren
                      </button>

                      <button
                        onClick={() => handleGenerateSceneVoice(sc.id, sc.narrationText)}
                        disabled={ttsSceneId === sc.id}
                        className="min-h-[38px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs text-white inline-flex items-center gap-1.5"
                      >
                        {ttsSceneId === sc.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5" />
                        )}
                        Voiceover erzeugen (Free-Tier)
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

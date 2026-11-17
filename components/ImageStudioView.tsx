import { useState } from 'react';
import {
  Check,
  Download,
  Eye,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Sliders,
  Upload,
  Wand2,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { type ImageFilterPreset, processImageLocally } from '../lib/localImageProcessor.ts';
import type { CharacterProfile, StudioProject } from '../types/zero.ts';

interface ImageStudioViewProps {
  characters: CharacterProfile[];
  projects: StudioProject[];
  onProjectUpdated: (p: StudioProject) => void;
}

interface GeneratedImageItem {
  id: string;
  url: string;
  prompt: string;
  engine: string;
  aspectRatio: string;
  createdAt: string;
}

async function cropImageToAspectRatio(dataUrl: string, aspectRatio: '16:9' | '9:16' | '1:1' | '4:3'): Promise<string> {
  if (aspectRatio === '1:1') return dataUrl;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Das generierte Bild konnte nicht für das Zielformat geöffnet werden.'));
    image.src = dataUrl;
  });

  const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
  const targetRatio = ratioWidth / ratioHeight;
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;
  if (sourceRatio > targetRatio) {
    sw = Math.round(sh * targetRatio);
    sx = Math.round((image.naturalWidth - sw) / 2);
  } else {
    sh = Math.round(sw / targetRatio);
    sy = Math.round((image.naturalHeight - sh) / 2);
  }

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Lokaler Bildzuschnitt ist auf diesem Gerät nicht verfügbar.');
  context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/jpeg', 0.94);
}

export function ImageStudioView({
  characters,
  projects,
  onProjectUpdated,
}: ImageStudioViewProps) {
  const [prompt, setPrompt] = useState(
    'Regnerische Berliner Straße bei Nacht, nasse Pflastersteine mit warmen Laternenreflexionen, Neo-Noir Kinostil'
  );
  const [model, setModel] = useState<'flux' | 'turbo' | 'sana'>('flux');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1' | '4:3'>('16:9');
  const [characterId, setCharacterId] = useState('');
  const [targetProjectId, setTargetProjectId] = useState(projects[0]?.id ?? '');
  const [savingToProject, setSavingToProject] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [style, setStyle] = useState('Leica 35mm cinema photography, high contrast');
  const [error, setError] = useState<string | null>(null);

  const [gallery, setGallery] = useState<GeneratedImageItem[]>([
    {
      id: 'seed-berlin',
      url: '/src/assets/images/scene_berlin_rain_1794745336613.jpg',
      prompt: 'Berlin Mitte Nachtregen Szene',
      engine: 'Studio Vorlage',
      aspectRatio: '16:9',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'seed-elena',
      url: '/src/assets/images/char_elena_vance_1794745336698.jpg',
      prompt: 'Charakterreferenz Elena Vance',
      engine: 'Charakter Engine',
      aspectRatio: '1:1',
      createdAt: new Date().toISOString(),
    },
  ]);

  const [activeImage, setActiveImage] = useState<GeneratedImageItem>(gallery[0]);
  const [analysisText, setAnalysisText] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [processingLocal, setProcessingLocal] = useState(false);
  const [generating, setGenerating] = useState(false);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (generating || !prompt.trim()) return;
    setGenerating(true);
    setError(null);
    setAnalysisText(null);
    try {
      const character = characters.find((item) => item.id === characterId);
      const fullPrompt = [
        prompt.trim(),
        style.trim(),
        character ? `Character continuity: ${character.consistencyPrompt || character.appearance || character.name}` : '',
        character ? `Face and clothing consistency: ${character.faceFeatures}; ${character.clothing}` : '',
      ].filter(Boolean).join(', ');
      const data = await apiRequest<{ imageDataUrl: string; engine: string }>('/api/image/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: fullPrompt, model, aspectRatio: '1:1' }),
      });
      const outputDataUrl = await cropImageToAspectRatio(data.imageDataUrl, aspectRatio);
      const item: GeneratedImageItem = {
        id: `img-${Date.now()}`,
        url: outputDataUrl,
        prompt: prompt.trim(),
        engine: aspectRatio === '1:1' ? data.engine : `${data.engine} + lokaler ${aspectRatio}-Zuschnitt`,
        aspectRatio,
        createdAt: new Date().toISOString(),
      };
      setGallery((previous) => [item, ...previous]);
      setActiveImage(item);
      setSavedNotice(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'FLUX-Bildgenerierung fehlgeschlagen');
    } finally {
      setGenerating(false);
    }
  }

  async function handleLocalEdit(preset: ImageFilterPreset) {
    if (!activeImage || processingLocal) return;
    setProcessingLocal(true);
    setError(null);
    try {
      const res = await processImageLocally(activeImage.url, preset);
      const edited: GeneratedImageItem = {
        id: `img-edit-${Date.now()}`,
        url: res.dataUrl,
        prompt: `${activeImage.prompt} [${res.operation}]`,
        engine: `ZERO Local Canvas (${res.width}x${res.height})`,
        aspectRatio: activeImage.aspectRatio,
        createdAt: new Date().toISOString(),
      };
      setGallery((prev) => [edited, ...prev]);
      setActiveImage(edited);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lokale Bearbeitung fehlgeschlagen');
    } finally {
      setProcessingLocal(false);
    }
  }

  async function handleAnalyzeVision() {
    if (!activeImage || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      let dataUrl = activeImage.url;
      if (!dataUrl.startsWith('data:')) {
        const res = await fetch(activeImage.url);
        const blob = await res.blob();
        dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        });
      }
      const data = await apiRequest<{ analysis: string }>('/api/image/analyze', {
        method: 'POST',
        body: JSON.stringify({ imageDataUrl: dataUrl }),
      });
      setAnalysisText(data.analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildanalyse fehlgeschlagen');
    } finally {
      setAnalyzing(false);
    }
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    if (!file.type.startsWith('image/')) {
      setError('Bitte wähle eine gültige Bilddatei aus.');
      return;
    }
    // Base64 increases payload size by roughly one third. Keep iPhone memory
    // usage and the 25 MB JSON request ceiling safely bounded.
    if (file.size > 8 * 1024 * 1024) {
      setError('Das Bild ist größer als 8 MB. Bitte wähle eine kleinere Datei.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/')) {
        setError('Das Bild konnte nicht gelesen werden. Bitte versuche es erneut.');
        return;
      }
      const item: GeneratedImageItem = {
        id: `img-up-${Date.now()}`,
        url: reader.result,
        prompt: file.name,
        engine: 'Lokaler Upload (Img2Img)',
        aspectRatio: 'Upload',
        createdAt: new Date().toISOString(),
      };
      setGallery((prev) => [item, ...prev]);
      setActiveImage(item);
      setAnalysisText(null);
      setError(null);
    };
    reader.onerror = () => setError('Das Bild konnte nicht gelesen werden. Bitte versuche es erneut.');
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">ZERO IMAGE STUDIO</h1>
        <p className="text-xs text-slate-400 mt-1">
          FLUX.1 Schnell über Cloudflare · Bildgenerierung, Upload, Charakterreferenzen & lokale Bildbearbeitung
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Controls */}
        <form
          onSubmit={handleGenerate}
          className="lg:col-span-5 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4"
        >
          <div>
            <label className="text-xs font-medium text-slate-300 block mb-1.5">
              Bildbeschreibung (Deutsch oder Englisch)
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Cloud-Modell</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as 'flux' | 'turbo' | 'sana')}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white focus:outline-none focus:border-[#2563EB]"
              >
                <option value="flux">FLUX.1 Schnell · Cloudflare Free</option>
                <option value="turbo" disabled>SD Turbo · nicht verfügbar</option>
                <option value="sana" disabled>Sana · nicht verfügbar</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Format</label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as '16:9' | '9:16' | '1:1' | '4:3')}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white focus:outline-none focus:border-[#2563EB]"
              >
                <option value="16:9">16:9 Kino</option>
                <option value="9:16">9:16 iPhone Vollbild</option>
                <option value="1:1">1:1 Quadrat</option>
                <option value="4:3">4:3 Klassisch</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">
              Charakter-Konsistenz verknüpfen
            </label>
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white focus:outline-none focus:border-[#2563EB]"
            >
              <option value="">Ohne feste Figur</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.role}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">Kamera & Stilvorgabe</label>
            <input
              type="text"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div className="p-3 rounded-xl bg-sky-500/10 border border-sky-500/25 text-xs text-sky-200">FLUX.1 Schnell läuft über Cloudflare Workers AI. Das tägliche Free-Kontingent von 10.000 Neurons wird mit anderen Cloudflare-Modellen geteilt. Bei erschöpftem Kontingent stoppt ZERO ohne kostenpflichtigen Fallback.</div>

          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="submit"
              disabled={generating || !prompt.trim()}
              className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {generating ? 'FLUX erstellt Bild…' : 'Bild generieren'}
            </button>

            <label className="min-h-[44px] px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" />
              Bild laden
              <input type="file" accept="image/*" onChange={handleUpload} className="hidden" />
            </label>
          </div>
        </form>

        {/* Preview & Local Image-to-Image Tools */}
        <div className="lg:col-span-7 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-slate-400">
                {activeImage.engine} · {activeImage.aspectRatio}
              </p>
              <p className="text-sm font-medium text-white truncate max-w-md">
                {activeImage.prompt}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {projects.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={targetProjectId || projects[0]?.id || ''}
                    onChange={(e) => setTargetProjectId(e.target.value)}
                    className="min-h-[40px] max-w-[140px] bg-[#090B10] border border-white/[0.08] rounded-xl px-2.5 text-xs text-slate-200"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={savingToProject}
                    onClick={async () => {
                      const pid = targetProjectId || projects[0]?.id;
                      if (!pid || !activeImage) return;
                      setSavingToProject(true);
                      setSavedNotice(null);
                      try {
                        const res = await apiRequest<{ project: StudioProject }>(
                          `/api/projects/${pid}/assets`,
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              type: 'image',
                              title: activeImage.prompt.slice(0, 64),
                              url: activeImage.url,
                              modelId: activeImage.engine.startsWith('ZERO Local Canvas')
                                ? 'zero-local-canvas'
                                : activeImage.engine.startsWith('Lokaler Upload')
                                  ? 'zero-local-upload'
                                  : 'zero-studio-reference',
                            }),
                          }
                        );
                        onProjectUpdated(res.project);
                        setSavedNotice(`In Projekt "${res.project.title}" gespeichert.`);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Bild konnte nicht im Projekt gespeichert werden.');
                      } finally {
                        setSavingToProject(false);
                      }
                    }}
                    className="min-h-[40px] px-3 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-xs text-white inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    {savingToProject ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : savedNotice ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <FolderPlus className="w-3.5 h-3.5" />
                    )}
                    In Projekt speichern
                  </button>
                </div>
              )}
              <button
                onClick={handleAnalyzeVision}
                disabled={analyzing}
                className="min-h-[40px] px-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs text-white inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                Vision-Analyse
              </button>
              <a
                href={activeImage.url}
                download={`zero-image-${activeImage.id}.png`}
                className="min-h-[40px] px-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs text-white inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Speichern
              </a>
            </div>
          </div>

          {savedNotice && (
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
              {savedNotice}
            </div>
          )}

          <div className="rounded-xl overflow-hidden bg-[#090B10] border border-white/[0.07] aspect-video flex items-center justify-center">
            {activeImage ? (
              <img
                src={activeImage.url}
                alt={activeImage.prompt}
                referrerPolicy="no-referrer"
                className="max-h-[420px] w-full object-contain"
              />
            ) : (
              <ImageIcon className="w-10 h-10 text-slate-600" />
            )}
          </div>

          {/* Local Canvas Processing */}
          <div className="space-y-2">
            <p className="text-xs text-slate-400 inline-flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5" />
              Lokale On-Device Bearbeitung & Upscaling (iPhone / Browser Canvas · 0 €):
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['noir', 'Noir Kontrast'],
                  ['cold_berlin', 'Kaltes Berlin'],
                  ['warm_tungsten', 'Warmes Wolfram'],
                  ['upscale_2x', '2x Upscaling'],
                ] as const
              ).map(([preset, label]) => (
                <button
                  key={preset}
                  onClick={() => handleLocalEdit(preset)}
                  disabled={processingLocal}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#090B10] hover:bg-white/[0.08] border border-white/[0.1] text-xs text-slate-200 transition-colors whitespace-nowrap"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {analysisText && (
            <div className="p-4 rounded-xl bg-[#090B10] border border-white/[0.08] text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
              <p className="font-semibold text-white mb-1">Gemini 3.8 Flash Vision-Analyse (Free Tier · API-Key):</p>
              {analysisText}
            </div>
          )}

          {/* Thumbnails */}
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 pt-2 border-t border-white/[0.06]">
            {gallery.slice(0, 6).map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveImage(item);
                  setAnalysisText(null);
                }}
                className={`rounded-lg overflow-hidden border aspect-square bg-[#090B10] ${
                  activeImage.id === item.id ? 'border-[#2563EB]' : 'border-white/[0.08]'
                }`}
              >
                <img
                  src={item.url}
                  alt={item.prompt}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

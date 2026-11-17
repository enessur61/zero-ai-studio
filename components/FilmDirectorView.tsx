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
import type { CharacterKnowledge, ContinuityEvent, ContinuitySeries, SemanticContinuityConflict } from '../src/types/continuity.ts';

interface ContinuitySeriesDetail {
  series: ContinuitySeries;
  knowledge: CharacterKnowledge[];
  events: ContinuityEvent[];
  relationships: Array<{ id: string; fromCharacterId: string; toCharacterId: string; type: string; description: string }>;
  locations: Array<{ id: string; name: string; description: string }>;
  sceneVersions: Array<{ id: string; sceneId: string; version: number }>;
  conflicts: Array<{ knowledgeId: string; eventId: string; message: string }>;
  semanticConflicts: SemanticContinuityConflict[];
  storySupervisor: { episodeCount: number; sceneCount: number; episodes: Array<{ projectId: string; title: string; sceneCount: number }>; characterArcs: Array<{ characterId: string; name: string; role: string; episodeTitles: string[]; appearanceCount: number; developmentSummary: string; knowledgeMilestones: Array<{ learnedAt: string; fact: string; factType: string }> }>; revealTimeline: Array<{ eventId: string; title: string; occurredAt: string; kind: string; characterId: string; canonicalValue: string }>; conflicts: SemanticContinuityConflict[]; dataWarnings: string[]; dramaturgyInsights: Array<{ id: string; category: 'emotion' | 'motivation' | 'contradiction'; characterName: string; episodeTitle: string; evidence: string; recommendation: string; confidence: 'heuristic' }> } | null;
}

function getLocalDateTimeInput(value: string | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

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
  const [continuitySeries, setContinuitySeries] = useState<ContinuitySeries[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState('');
  const [continuityDetail, setContinuityDetail] = useState<ContinuitySeriesDetail | null>(null);
  const [continuityLoading, setContinuityLoading] = useState(false);
  const [dramaturgyAiLoading, setDramaturgyAiLoading] = useState(false);
  const [dramaturgyAiError, setDramaturgyAiError] = useState('');
  const [dramaturgyVersions, setDramaturgyVersions] = useState<Array<any>>([]);
  const [dramaturgyDecisions, setDramaturgyDecisions] = useState<Array<any>>([]);
  const [dramaturgyApplications, setDramaturgyApplications] = useState<Array<any>>([]);
  const [correctionDraft, setCorrectionDraft] = useState<{ version: number; findingId: string; projectId: string; sceneId: string; field: 'narrationText' | 'dialogueText' | 'subtitleText'; replacementText: string; confirmed: boolean } | null>(null);
  const [applyingCorrection, setApplyingCorrection] = useState(false);
  const [dramaturgyAiResult, setDramaturgyAiResult] = useState<{
    overallAssessment: string;
    characterAnalyses: Array<{ characterId: string; psychologicalProfile: string; coreMotivation: string; emotionalArc: string; relationshipDynamics: string[]; contradictions: string[] }>;
    findings: Array<{ id: string; category: string; severity: string; characterIds: string[]; episodeTitle: string; sceneTitle: string; evidence: string; interpretation: string; recommendation: string; confidence: string }>;
    storyRecommendations: string[];
    modelId: string;
    generatedAt: string;
  } | null>(null);
  const [newSeriesTitle, setNewSeriesTitle] = useState('');
  const [seriesBibleDraft, setSeriesBibleDraft] = useState('');
  const [savingSeriesBible, setSavingSeriesBible] = useState(false);
  const [continuityNotice, setContinuityNotice] = useState('');
  const [knowledgeDraft, setKnowledgeDraft] = useState({ id: '', characterId: '', fact: '', learnedAt: getLocalDateTimeInput(), factType: 'fact' as 'fact' | 'identity' | 'secret', subjectCharacterId: '', canonicalValue: '', sourceEventId: '' });
  const [eventDraft, setEventDraft] = useState({ id: '', title: '', description: '', occurredAt: new Date().toISOString().slice(0, 16), kind: 'fact' as 'scene' | 'fact' | 'death' | 'identity_reveal' | 'secret_reveal', subjectCharacterId: '', canonicalValue: '', timeMode: 'present' as 'present' | 'flashback' | 'dream', characterIds: [] as string[] });
  const [savingContinuityItem, setSavingContinuityItem] = useState(false);

  useEffect(() => () => {
    if (productionVideo?.videoUrl.startsWith('blob:')) URL.revokeObjectURL(productionVideo.videoUrl);
  }, [productionVideo]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ series: ContinuitySeries[] }>('/api/continuity/series').then((data) => { if (!cancelled) setContinuitySeries(data.series.filter((series) => !series.archivedAt)); }).catch((err) => { if (!cancelled) setContinuityNotice(err instanceof Error ? err.message : 'Serien konnten nicht geladen werden.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedSeriesId) { setDramaturgyVersions([]); setDramaturgyDecisions([]); setDramaturgyApplications([]); setDramaturgyApplications([]); setCorrectionDraft(null); return; }
    let cancelled = false;
    apiRequest<{ analyses: any[]; decisions: any[]; applications: any[] }>('/api/continuity/series/' + selectedSeriesId + '/dramaturgy-analyses')
      .then((data) => { if (!cancelled) { setDramaturgyVersions(data.analyses.sort((a,b) => b.version-a.version)); setDramaturgyDecisions(data.decisions); setDramaturgyApplications(data.applications ?? []); } })
      .catch(() => { if (!cancelled) { setDramaturgyVersions([]); setDramaturgyDecisions([]); } });
    return () => { cancelled = true; };
  }, [selectedSeriesId]);

  useEffect(() => {
    if (!selectedSeriesId) { setContinuityDetail(null); setSeriesBibleDraft(''); return; }
    let cancelled = false;
    setContinuityLoading(true);
    apiRequest<ContinuitySeriesDetail>('/api/continuity/series/' + selectedSeriesId).then((detail) => {
      if (cancelled) return;
      setContinuityDetail(detail); setSeriesBibleDraft(detail.series.bible || ''); setContinuityNotice('');
    }).catch((err) => { if (!cancelled) setContinuityNotice(err instanceof Error ? err.message : 'Serienkontext konnte nicht geladen werden.'); }).finally(() => { if (!cancelled) setContinuityLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSeriesId]);

  const [activeProjectId, setActiveProjectId] = useState(projects[0]?.id ?? '');
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];

  const [regenSceneId, setRegenSceneId] = useState<string | null>(null);
  const [regenInstruction, setRegenInstruction] = useState(
    'Erhöhe Spannung und emotionale Wirkung; überarbeite Erzähltext, Dialog und Untertitel.'
  );
  const [ttsSceneId, setTtsSceneId] = useState<string | null>(null);

  async function handleAiDramaturgyAnalysis() {
    if (!selectedSeriesId || dramaturgyAiLoading) return;
    setDramaturgyAiLoading(true); setDramaturgyAiError(''); setDramaturgyAiResult(null);
    try {
      const response = await apiRequest<{ analysis: NonNullable<typeof dramaturgyAiResult> extends infer T ? Omit<NonNullable<typeof dramaturgyAiResult>, 'modelId' | 'generatedAt'> : never; modelId: string; generatedAt: string; paidFallback: false }>(
        '/api/continuity/series/' + selectedSeriesId + '/analyze-dramaturgy',
        { method: 'POST', body: JSON.stringify({}) },
      );
      setDramaturgyAiResult({ ...response.analysis, modelId: response.modelId, generatedAt: response.generatedAt });
    } catch (err) { setDramaturgyAiError(err instanceof Error ? err.message : 'KI-Analyse konnte nicht ausgeführt werden.'); }
    finally { setDramaturgyAiLoading(false); }
  }

  async function handleDramaturgyDecision(version: number, findingId: string, approved: boolean) {
    if (!selectedSeriesId) return;
    try {
      const result = await apiRequest<{ decision: any }>(`/api/continuity/series/${selectedSeriesId}/dramaturgy-analyses/${version}/decisions`, {
        method: 'POST', body: JSON.stringify({ findingId, approved, note: approved ? 'Manuell durch Regie freigegeben' : 'Manuell durch Regie abgelehnt' }),
      });
      setDramaturgyDecisions((current) => [...current, result.decision]);
      if (approved) setCorrectionDraft({ version, findingId, projectId: continuityDetail?.series.projectIds[0] ?? '', sceneId: '', field: 'dialogueText', replacementText: '', confirmed: false });
      else setCorrectionDraft((current) => current?.version === version && current.findingId === findingId ? null : current);
      setContinuityNotice(approved ? 'Freigabe gespeichert. Wähle jetzt Szene und Textfeld und prüfe die Änderung.' : 'Korrekturvorschlag abgelehnt.');
    } catch (err) { setContinuityNotice(err instanceof Error ? err.message : 'Entscheidung konnte nicht gespeichert werden.'); }
  }

  async function handleApplyDramaturgyCorrection() {
    if (!selectedSeriesId || !correctionDraft || !correctionDraft.confirmed || applyingCorrection) return;
    const project = projects.find((item) => item.id === correctionDraft.projectId);
    const scene = project?.scenes.find((item) => item.id === correctionDraft.sceneId);
    if (!project || !scene) { setContinuityNotice('Bitte ein gültiges Serienprojekt und eine Szene auswählen.'); return; }
    const latest = [...dramaturgyDecisions].reverse().find((item) => item.analysisVersionId === dramaturgyVersions.find((v) => v.version === correctionDraft.version)?.id && item.findingId === correctionDraft.findingId);
    if (!latest || latest.decision !== 'approved') { setContinuityNotice('Keine aktuell gültige Freigabe. Bitte Analysehistorie aktualisieren.'); return; }
    setApplyingCorrection(true);
    try {
      const result = await apiRequest<{ applied: boolean; application: any; sceneVersion: any }>(`/api/continuity/series/${selectedSeriesId}/dramaturgy-analyses/${correctionDraft.version}/apply`, {
        method: 'POST',
        body: JSON.stringify({ decisionId: latest.id, findingId: correctionDraft.findingId, projectId: project.id, sceneId: scene.id, field: correctionDraft.field, expectedPreviousText: scene[correctionDraft.field] ?? '', replacementText: correctionDraft.replacementText, confirmed: correctionDraft.confirmed }),
      });
      onProjectUpdated({ ...project, version: (project.version ?? 0) + 1, updatedAt: new Date().toISOString(), scenes: project.scenes.map((item) => item.id === scene.id ? { ...item, [correctionDraft.field]: correctionDraft.replacementText } : item) });
      setDramaturgyApplications((current) => [...current, result.application]);
      setCorrectionDraft(null);
      setContinuityNotice('Korrektur angewendet. Der vorherige Szenenstand wurde versioniert gesichert.');
    } catch (err) { setContinuityNotice(err instanceof Error ? err.message : 'Korrektur konnte nicht angewendet werden.'); }
    finally { setApplyingCorrection(false); }
  }

  async function handleCreateSeries() {
    const title = newSeriesTitle.trim();
    if (!title) return;
    setContinuityNotice('');
    try {
      const created = await apiRequest<{ series: ContinuitySeries }>('/api/continuity/series', { method: 'POST', body: JSON.stringify({ title, logline: idea.trim(), genre, bible: '', projectIds: [] }) });
      setContinuitySeries((current) => [created.series, ...current]); setSelectedSeriesId(created.series.id); setNewSeriesTitle(''); setContinuityNotice('Serie angelegt. Ergänze jetzt die Serienbibel.');
    } catch (err) { setContinuityNotice(err instanceof Error ? err.message : 'Serie konnte nicht angelegt werden.'); }
  }

  async function handleSaveSeriesBible() {
    if (!continuityDetail || savingSeriesBible) return;
    setSavingSeriesBible(true);
    try {
      const updated = await apiRequest<{ series: ContinuitySeries }>('/api/continuity/series/' + continuityDetail.series.id, { method: 'PUT', body: JSON.stringify({ bible: seriesBibleDraft }) });
      setContinuityDetail((current) => current ? { ...current, series: updated.series } : current);
      setContinuitySeries((current) => current.map((series) => series.id === updated.series.id ? updated.series : series));
      setContinuityNotice('Serienbibel gespeichert.');
    } catch (err) { setContinuityNotice(err instanceof Error ? err.message : 'Serienbibel konnte nicht gespeichert werden.'); }
    finally { setSavingSeriesBible(false); }
  }

  function localDateValue(value: string) { const date = new Date(value); const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16); }
  function isoDateValue(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }
  async function handleSaveKnowledge() {
    if (!continuityDetail || savingContinuityItem || !knowledgeDraft.characterId || !knowledgeDraft.fact.trim()) return;
    setSavingContinuityItem(true);
    try {
      const payload = { characterId: knowledgeDraft.characterId, fact: knowledgeDraft.fact, learnedAt: isoDateValue(knowledgeDraft.learnedAt), factType: knowledgeDraft.factType, subjectCharacterId: knowledgeDraft.subjectCharacterId || undefined, canonicalValue: knowledgeDraft.canonicalValue || undefined, sourceEventId: knowledgeDraft.sourceEventId || undefined };
      await apiRequest<{ knowledge: CharacterKnowledge }>(knowledgeDraft.id ? '/api/continuity/knowledge/' + knowledgeDraft.id : '/api/continuity/series/' + continuityDetail.series.id + '/knowledge', { method: knowledgeDraft.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      const refreshed = await apiRequest<ContinuitySeriesDetail>('/api/continuity/series/' + continuityDetail.series.id); setContinuityDetail(refreshed);
      setKnowledgeDraft({ id: '', characterId: '', fact: '', learnedAt: getLocalDateTimeInput(), factType: 'fact', subjectCharacterId: '', canonicalValue: '', sourceEventId: '' }); setContinuityNotice('Figurenwissen gespeichert.');
    } catch (err) { setContinuityNotice(err instanceof Error ? err.message : 'Figurenwissen konnte nicht gespeichert werden.'); } finally { setSavingContinuityItem(false); }
  }
  async function handleSaveEvent() {
    if (!continuityDetail || savingContinuityItem || !eventDraft.title.trim()) return;
    setSavingContinuityItem(true);
    try {
      const payload = { title: eventDraft.title, description: eventDraft.description, occurredAt: isoDateValue(eventDraft.occurredAt), kind: eventDraft.kind, subjectCharacterId: eventDraft.subjectCharacterId || undefined, canonicalValue: eventDraft.canonicalValue || undefined, timeMode: eventDraft.timeMode, characterIds: eventDraft.characterIds };
      await apiRequest<{ event: ContinuityEvent }>(eventDraft.id ? '/api/continuity/events/' + eventDraft.id : '/api/continuity/series/' + continuityDetail.series.id + '/events', { method: eventDraft.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      const refreshed = await apiRequest<ContinuitySeriesDetail>('/api/continuity/series/' + continuityDetail.series.id); setContinuityDetail(refreshed);
      setEventDraft({ id: '', title: '', description: '', occurredAt: new Date().toISOString().slice(0,16), kind: 'fact', subjectCharacterId: '', canonicalValue: '', timeMode: 'present', characterIds: [] }); setContinuityNotice('Ereignis gespeichert.');
    } catch (err) { setContinuityNotice(err instanceof Error ? err.message : 'Ereignis konnte nicht gespeichert werden.'); } finally { setSavingContinuityItem(false); }
  }
  function editKnowledge(item: CharacterKnowledge) { setKnowledgeDraft({ id: item.id, characterId: item.characterId, fact: item.fact, learnedAt: localDateValue(item.learnedAt), factType: item.factType || 'fact', subjectCharacterId: item.subjectCharacterId || '', canonicalValue: item.canonicalValue || '', sourceEventId: item.sourceEventId || '' }); }
  function editEvent(item: ContinuityEvent) { setEventDraft({ id: item.id, title: item.title, description: item.description, occurredAt: localDateValue(item.occurredAt), kind: item.kind || 'fact', subjectCharacterId: item.subjectCharacterId || '', canonicalValue: item.canonicalValue || '', timeMode: item.timeMode || 'present', characterIds: item.characterIds || [] }); }

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
              ...(selectedSeriesId ? { seriesId: selectedSeriesId } : {}),
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

  async function handleRegenerateScene(sceneId: string, correction?: { conflictId: string; suggestion: string; projectId?: string }) {
    const targetProject = correction?.projectId ? projects.find((item) => item.id === correction.projectId) : activeProject;
    if (!targetProject || regenSceneId) return;
    setRegenSceneId(sceneId);
    setError(null);
    try {
      const data = await apiRequest<{ project: StudioProject; resolvedConflictId?: string }>('/api/film/regenerate-scene', {
        method: 'POST',
        body: JSON.stringify({
          projectId: targetProject.id,
          sceneId,
          instruction: correction?.suggestion || regenInstruction,
          ...(correction ? { targetConflictId: correction.conflictId } : {}),
        }),
      });
      onProjectUpdated(data.project);
      if (selectedSeriesId) { const detail = await apiRequest<ContinuitySeriesDetail>('/api/continuity/series/' + selectedSeriesId); setContinuityDetail(detail); }
      if (data.resolvedConflictId) setContinuityNotice('Konflikt behoben: Szene wurde gezielt neu generiert und als neue Version gespeichert.');
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

          <div className="rounded-xl border border-white/[0.08] bg-[#090B10] p-3 space-y-3">
            <label className="text-xs text-slate-300 block mb-1.5">Continuity Engine · Serienkontext</label>
            <select value={selectedSeriesId} onChange={(event) => setSelectedSeriesId(event.target.value)} className="w-full min-h-[42px] bg-[#11151E] border border-white/[0.1] rounded-lg px-3 text-xs text-white">
              <option value="">Ohne Serienbindung produzieren</option>
              {continuitySeries.map((series) => <option key={series.id} value={series.id}>{series.title}</option>)}
            </select>
            <div className="flex gap-2"><input value={newSeriesTitle} onChange={(event) => setNewSeriesTitle(event.target.value)} placeholder="Neue Serie anlegen" className="min-w-0 flex-1 min-h-[40px] bg-[#11151E] border border-white/[0.1] rounded-lg px-3 text-xs text-white" /><button type="button" onClick={handleCreateSeries} disabled={!newSeriesTitle.trim()} className="min-h-[40px] px-3 rounded-lg bg-white/[0.08] text-xs text-white disabled:opacity-40">Anlegen</button></div>
            {continuityLoading && <p className="text-[11px] text-slate-400">Lade Serienbibel und Kontinuität...</p>}
            {continuityDetail && <div className="space-y-2 border-t border-white/[0.08] pt-3">
              <label className="text-[11px] text-slate-400 block">Serienbibel · wird ZERO DIRECTOR als Kanon übergeben</label>
              <textarea rows={4} value={seriesBibleDraft} onChange={(event) => setSeriesBibleDraft(event.target.value)} placeholder="Weltregeln, Tonalität, zentrale Geheimnisse, Staffel- und Figurenbögen..." className="w-full bg-[#11151E] border border-white/[0.1] rounded-lg p-3 text-xs text-white" />
              <button type="button" onClick={handleSaveSeriesBible} disabled={savingSeriesBible} className="min-h-[38px] px-3 rounded-lg bg-[#2563EB] text-xs text-white disabled:opacity-50">{savingSeriesBible ? "Speichert..." : "Serienbibel speichern"}</button>
              <div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-white/[0.04] p-2"><p className="text-sm font-semibold text-white">{continuityDetail.knowledge.length}</p><p className="text-[10px] text-slate-400">Wissenseinträge</p></div><div className="rounded-lg bg-white/[0.04] p-2"><p className="text-sm font-semibold text-white">{continuityDetail.events.length}</p><p className="text-[10px] text-slate-400">Ereignisse</p></div><div className="rounded-lg bg-white/[0.04] p-2"><p className="text-sm font-semibold text-white">{continuityDetail.relationships.length}</p><p className="text-[10px] text-slate-400">Beziehungen</p></div></div>
               {continuityDetail.storySupervisor && <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3 space-y-3">
                 <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-cyan-200">ZERO STORY-SUPERVISOR · gesamte Serie</h3><span className="text-[10px] text-slate-400">{continuityDetail.storySupervisor.episodeCount} Episoden · {continuityDetail.storySupervisor.sceneCount} Szenen</span></div>
                 <div className="space-y-2"><p className="text-[11px] text-slate-300">Figurenentwicklungen</p>
                   {continuityDetail.storySupervisor.characterArcs.length === 0 ? <p className="text-[11px] text-slate-500">Noch keine Figurenauftritte erfasst.</p> : continuityDetail.storySupervisor.characterArcs.map((arc) => <div key={arc.characterId} className="rounded-lg bg-black/20 p-2"><div className="flex justify-between gap-2"><span className="text-xs text-white">{arc.name}</span><span className="text-[10px] text-slate-400">{arc.appearanceCount} Szenen</span></div><p className="text-[10px] text-slate-400">{arc.developmentSummary}</p>{arc.episodeTitles.length > 0 && <p className="text-[10px] text-cyan-200/70">{arc.episodeTitles.join(' · ')}</p>}{arc.knowledgeMilestones.slice(-2).map((milestone,index) => <p key={index} className="text-[10px] text-slate-500">{new Date(milestone.learnedAt).toLocaleDateString('de-DE')} · {milestone.fact}</p>)}</div>)}
                 </div>
                 <div className="space-y-1"><p className="text-[11px] text-slate-300">Enthüllungszeitachse</p>{continuityDetail.storySupervisor.revealTimeline.length === 0 ? <p className="text-[10px] text-slate-500">Keine Identitäts- oder Geheimnisenthüllungen festgelegt.</p> : continuityDetail.storySupervisor.revealTimeline.map((reveal) => <p key={reveal.eventId} className="text-[10px] text-slate-400">{new Date(reveal.occurredAt).toLocaleString('de-DE')} · {reveal.kind === 'identity_reveal' ? 'Identität' : 'Geheimnis'}: {reveal.canonicalValue}</p>)}</div>
                 <div className="space-y-2 rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-3">
                   <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-semibold text-violet-200">KI-DRAMATURGIE · episodenübergreifend</p><button type="button" onClick={handleAiDramaturgyAnalysis} disabled={dramaturgyAiLoading} className="min-h-[40px] rounded-lg bg-violet-500/20 px-3 text-[11px] font-semibold text-violet-100 disabled:opacity-50">{dramaturgyAiLoading ? 'Analysiere…' : 'Serie mit KI analysieren'}</button></div>
                   <p className="text-[10px] text-slate-400">Analysiert Psychologie, Motivation, Gefühlsbögen, Beziehungen, Subtext und widersprüchliche Handlungen. Nur bestätigte Free-Tier-Modelle; kein kostenpflichtiger Fallback.</p>
                   {dramaturgyAiError && <p role="alert" className="text-[11px] text-amber-300">{dramaturgyAiError}</p>}
                   {dramaturgyAiResult && <div className="space-y-3"><p className="text-xs text-white">{dramaturgyAiResult.overallAssessment}</p><p className="text-[10px] text-slate-500">Modell: {dramaturgyAiResult.modelId} · {new Date(dramaturgyAiResult.generatedAt).toLocaleString('de-DE')} · 0-€-Route</p>
                     {dramaturgyAiResult.characterAnalyses.map((arc) => <div key={arc.characterId} className="rounded-lg bg-black/20 p-2"><p className="text-[11px] font-semibold text-cyan-100">{characters.find((c) => c.id === arc.characterId)?.name || arc.characterId}</p><p className="text-[10px] text-slate-300">Psychologie: {arc.psychologicalProfile}</p><p className="text-[10px] text-slate-300">Motivation: {arc.coreMotivation}</p><p className="text-[10px] text-slate-300">Emotionaler Bogen: {arc.emotionalArc}</p>{arc.relationshipDynamics.map((item,i) => <p key={'r'+i} className="text-[10px] text-slate-400">Beziehung: {item}</p>)}{arc.contradictions.map((item,i) => <p key={'c'+i} className="text-[10px] text-amber-300">Spannung: {item}</p>)}</div>)}
                     {dramaturgyAiResult.findings.map((finding) => <div key={finding.id} className="rounded-lg border border-white/[0.06] bg-black/20 p-2"><p className="text-[10px] text-violet-200">{finding.category} · {finding.severity} · {finding.confidence}</p><p className="text-[11px] text-white">{finding.episodeTitle} / {finding.sceneTitle}</p><p className="text-[10px] text-slate-300">Beleg: {finding.evidence}</p><p className="text-[10px] text-slate-300">Subtext / Deutung: {finding.interpretation}</p><p className="text-[10px] text-cyan-100">Vorschlag: {finding.recommendation}</p></div>)}
                     {dramaturgyAiResult.storyRecommendations.map((item,i) => <p key={i} className="text-[10px] text-cyan-100">• {item}</p>)}
                   </div>}
                 </div>
                 {dramaturgyVersions.length > 0 && <div className="space-y-2 rounded-lg border border-white/[0.08] p-3">
                   <p className="text-[11px] font-semibold text-white">Unveränderliche Analysehistorie</p>
                   {dramaturgyVersions.map((version) => <div key={version.id} className="space-y-2 rounded-lg bg-black/20 p-2">
                     <div className="flex items-center justify-between gap-2"><p className="text-[11px] text-cyan-100">Version {version.version}</p><span className="text-[10px] text-slate-500">{new Date(version.createdAt).toLocaleString('de-DE')} · {version.modelId}</span></div>
                     {version.comparison && <><p className="text-[10px] text-slate-300">{version.comparison.summary}</p>
                       {version.comparison.changedCharacters.map((change:any) => { const prior = dramaturgyVersions.find((item:any) => item.version === version.comparison.previousVersion); const before = prior?.analysis.characterAnalyses.find((item:any) => item.characterId === change.characterId); const after = version.analysis.characterAnalyses.find((item:any) => item.characterId === change.characterId); const labels:any = {psychologicalProfile:'Psychologie',coreMotivation:'Motivation',emotionalArc:'Emotion',relationshipDynamics:'Beziehungen',contradictions:'Widersprüche'}; return <div key={change.characterId} className="rounded-md border border-white/[0.06] p-2"><p className="text-[10px] font-semibold text-cyan-100">{characters.find((c)=>c.id===change.characterId)?.name || change.characterId} · Vorher / Nachher</p>{change.changedFields.map((field:string)=><div key={field} className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2"><p className="text-[10px] text-slate-400">Vorher · {labels[field] || field}: {Array.isArray(before?.[field]) ? before[field].join(' · ') : before?.[field] || '—'}</p><p className="text-[10px] text-emerald-200">Nachher · {labels[field] || field}: {Array.isArray(after?.[field]) ? after[field].join(' · ') : after?.[field] || '—'}</p></div>)}</div>; })}
                       {version.comparison.newContradictions.map((item:string,i:number)=><p key={'new'+i} className="text-[10px] text-amber-300">Neuer Widerspruch: {item}</p>)}
                       {version.comparison.resolvedContradictions.map((item:string,i:number)=><p key={'resolved'+i} className="text-[10px] text-emerald-300">Nicht mehr gemeldet: {item}</p>)}
                       {version.comparison.newSubtext.map((item:string,i:number)=><p key={'subtext'+i} className="text-[10px] text-violet-200">Neuer Subtext: {item}</p>)}
                       {version.comparison.resolvedSubtext.map((item:string,i:number)=><p key={'subtext-resolved'+i} className="text-[10px] text-slate-400">Subtext nicht mehr gemeldet: {item}</p>)}
                     </>}
                     {version.analysis.findings.map((finding:any) => { const latest = [...dramaturgyDecisions].filter((d:any)=>d.analysisVersionId===version.id&&d.findingId===finding.id).sort((a:any,b:any)=>b.createdAt.localeCompare(a.createdAt))[0]; return <div key={finding.id} className="rounded-md border border-white/[0.06] p-2"><p className="text-[10px] text-slate-300">{finding.episodeTitle} / {finding.sceneTitle} · {finding.category}</p><p className="text-[10px] text-white">{finding.recommendation}</p><p className="text-[10px] text-slate-500">Status: {latest?.decision === 'approved' ? 'Freigegeben' : latest?.decision === 'rejected' ? 'Abgelehnt' : 'Offen'}</p>{!latest && <div className="flex gap-2 pt-1"><button type="button" onClick={()=>handleDramaturgyDecision(version.version,finding.id,true)} className="min-h-[34px] rounded-md bg-emerald-500/15 px-2 text-[10px] text-emerald-200">Freigeben</button><button type="button" onClick={()=>handleDramaturgyDecision(version.version,finding.id,false)} className="min-h-[34px] rounded-md bg-rose-500/15 px-2 text-[10px] text-rose-200">Ablehnen</button></div>}{latest?.decision === 'rejected' && <button type="button" onClick={()=>handleDramaturgyDecision(version.version,finding.id,true)} className="mt-2 min-h-[36px] rounded-md border border-emerald-400/30 px-3 text-[10px] text-emerald-200">Erneut ausdrücklich freigeben</button>}{latest?.decision === 'approved' && !dramaturgyApplications.some((a:any)=>a.decisionId===latest.id) && <button type="button" onClick={()=>setCorrectionDraft({version:version.version,findingId:finding.id,projectId:continuityDetail.series.projectIds[0] ?? '',sceneId:'',field:'dialogueText',replacementText:'',confirmed:false})} className="mt-2 min-h-[36px] rounded-md border border-cyan-400/30 px-3 text-[10px] text-cyan-100">Manuelle Korrektur vorbereiten</button>}{dramaturgyApplications.some((a:any)=>a.decisionId===latest?.id) && <p className="text-[10px] text-emerald-300">Korrektur bereits angewendet · Snapshot gesichert</p>}</div>; })}
                   </div>)}
                   <p className="text-[10px] text-slate-500">Eine Freigabe allein verändert keine Szene. Die Anwendung verlangt eine konkrete manuelle Textfassung und sichert vorher den bisherigen Szenenstand.</p>
                 </div>}
                 {correctionDraft && <div className="space-y-3 rounded-lg border border-cyan-400/30 bg-cyan-950/10 p-3">
                   <div><p className="text-xs font-semibold text-cyan-100">Manuelle Korrektur · Version {correctionDraft.version}</p><p className="text-[10px] text-slate-400">Freigabe liegt vor. Die Änderung wird erst nach Vorschau und deiner ausdrücklichen Bestätigung angewendet.</p></div>
                   <label className="block space-y-1"><span className="text-[10px] text-slate-300">Serienprojekt</span><select value={correctionDraft.projectId} onChange={(e)=>setCorrectionDraft((d)=>d?{...d,projectId:e.target.value,sceneId:'',confirmed:false}:d)} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="">Projekt auswählen</option>{projects.filter((p)=>continuityDetail.series.projectIds.includes(p.id)).map((p)=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
                   <label className="block space-y-1"><span className="text-[10px] text-slate-300">Szene</span><select value={correctionDraft.sceneId} onChange={(e)=>setCorrectionDraft((d)=>d?{...d,sceneId:e.target.value,confirmed:false}:d)} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="">Szene auswählen</option>{(projects.find((p)=>p.id===correctionDraft.projectId)?.scenes ?? []).map((scene)=><option key={scene.id} value={scene.id}>{scene.index+1}. {scene.title}</option>)}</select></label>
                   <label className="block space-y-1"><span className="text-[10px] text-slate-300">Textfeld</span><select value={correctionDraft.field} onChange={(e)=>setCorrectionDraft((d)=>d?{...d,field:e.target.value as typeof d.field,confirmed:false}:d)} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="narrationText">Erzähltext</option><option value="dialogueText">Dialog</option><option value="subtitleText">Untertitel</option></select></label>
                   {(() => { const scene=projects.find((p)=>p.id===correctionDraft.projectId)?.scenes.find((item)=>item.id===correctionDraft.sceneId); const previous=scene?.[correctionDraft.field] ?? ''; return <><div className="space-y-1"><p className="text-[10px] text-slate-300">Vorher</p><div className="whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-[11px] text-slate-400">{previous || '— leer —'}</div></div><label className="block space-y-1"><span className="text-[10px] text-slate-300">Nachher · Textfassung selbst festlegen</span><textarea rows={5} value={correctionDraft.replacementText} onChange={(e)=>setCorrectionDraft((d)=>d?{...d,replacementText:e.target.value,confirmed:false}:d)} placeholder="Deine überarbeitete Textfassung …" className="w-full min-h-[120px] rounded-lg bg-[#11151E] border border-white/[0.1] p-3 text-xs text-white" /></label><div className="space-y-1"><p className="text-[10px] text-slate-300">Vorschau Nachher</p><div className="whitespace-pre-wrap rounded-lg border border-emerald-400/20 bg-emerald-950/10 p-3 text-[11px] text-emerald-100">{correctionDraft.replacementText || 'Noch keine neue Textfassung'}</div></div><label className="flex items-start gap-2 text-[10px] text-slate-300"><input type="checkbox" checked={correctionDraft.confirmed} onChange={(e)=>setCorrectionDraft((d)=>d?{...d,confirmed:e.target.checked}:d)} className="mt-0.5" />Ich habe Vorher/Nachher geprüft und bestätige ausdrücklich, dass diese Textfassung die ausgewählte Szene ersetzen darf.</label><button type="button" disabled={applyingCorrection||!correctionDraft.confirmed||!correctionDraft.replacementText.trim()||!scene||correctionDraft.replacementText===previous} onClick={handleApplyDramaturgyCorrection} className="w-full min-h-[44px] rounded-lg bg-cyan-500/20 px-3 text-xs font-semibold text-cyan-100 disabled:opacity-40">{applyingCorrection?'Wird angewendet …':'Bestätigen und Korrektur anwenden'}</button></>; })()}
                   <button type="button" onClick={()=>setCorrectionDraft(null)} className="min-h-[36px] rounded-md px-3 text-[10px] text-slate-400">Abbrechen</button>
                 </div>}
                 {continuityDetail.storySupervisor.dramaturgyInsights.length > 0 && <div className="space-y-2"><p className="text-[11px] text-slate-300">Dramaturgische Signale · regelbasiert, keine KI-Gewissheit</p>{continuityDetail.storySupervisor.dramaturgyInsights.slice(0, 12).map((insight) => <div key={insight.id} className="rounded-lg bg-black/20 p-2"><p className="text-[10px] text-cyan-200">{insight.category === 'emotion' ? 'Emotion' : insight.category === 'motivation' ? 'Motivation' : 'Möglicher Widerspruch'} · {insight.characterName} · {insight.episodeTitle}</p><p className="text-[10px] text-slate-300">{insight.evidence}</p><p className="text-[10px] text-slate-500">Prüfvorschlag: {insight.recommendation}</p></div>)}</div>}
                 {continuityDetail.storySupervisor.dataWarnings.length > 0 && <p className="text-[10px] text-amber-300">{continuityDetail.storySupervisor.dataWarnings.length} Daten-/Zeitachsenhinweis(e) prüfen.</p>}
               </div>}
              {continuityDetail.conflicts.length > 0 && <p className="text-[11px] text-rose-300">{continuityDetail.conflicts.length} Kontinuitätskonflikt(e) – Produktion wird bis zur Klärung gestoppt.</p>}
              <div className="border-t border-white/[0.08] pt-3 space-y-3">
                <h3 className="text-xs font-semibold text-white">Figurenwissen bearbeiten</h3>
                <select value={knowledgeDraft.characterId} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, characterId: e.target.value }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="">Wissende Figur wählen</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                <textarea rows={2} value={knowledgeDraft.fact} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, fact: e.target.value }))} placeholder="Was weiß diese Figur?" className="w-full min-h-[72px] rounded-lg bg-[#11151E] border border-white/[0.1] p-3 text-xs text-white" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><select value={knowledgeDraft.factType} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, factType: e.target.value as typeof d.factType }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="fact">Allgemeines Wissen</option><option value="identity">Identitätswissen</option><option value="secret">Geheimniswissen</option></select><input type="datetime-local" value={knowledgeDraft.learnedAt} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, learnedAt: e.target.value }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white" /></div>
                {knowledgeDraft.factType !== 'fact' && <><select value={knowledgeDraft.subjectCharacterId} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, subjectCharacterId: e.target.value }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="">Betroffene Figur wählen</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input value={knowledgeDraft.canonicalValue} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, canonicalValue: e.target.value }))} placeholder="Kanonische Identität / Geheimnis" className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white" /></>}
                <select value={knowledgeDraft.sourceEventId} onChange={(e) => setKnowledgeDraft((d) => ({ ...d, sourceEventId: e.target.value }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="">Kein Quellereignis</option>{continuityDetail.events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}</select>
                <button type="button" onClick={handleSaveKnowledge} disabled={savingContinuityItem || !knowledgeDraft.characterId || !knowledgeDraft.fact.trim()} className="w-full min-h-[44px] rounded-lg bg-[#2563EB] text-xs font-medium text-white disabled:opacity-40">{savingContinuityItem ? 'Speichert...' : knowledgeDraft.id ? 'Wissenseintrag aktualisieren' : 'Wissenseintrag hinzufügen'}</button>
                <div className="space-y-2">{continuityDetail.knowledge.map((fact) => <div key={fact.id} className="flex items-start justify-between gap-2 rounded-lg bg-white/[0.04] p-2"><div className="min-w-0"><p className="text-xs text-white">{characters.find((c) => c.id === fact.characterId)?.name || 'Figur'} · {fact.fact}</p><p className="text-[10px] text-slate-500">{fact.factType || 'Fakt'} · ab {new Date(fact.learnedAt).toLocaleString('de-DE')}</p></div><button type="button" onClick={() => editKnowledge(fact)} className="shrink-0 min-h-[40px] px-3 rounded-lg bg-white/[0.08] text-xs text-white">Bearbeiten</button></div>)}</div>
              </div>
              <div className="border-t border-white/[0.08] pt-3 space-y-3">
                <h3 className="text-xs font-semibold text-white">Ereigniszeitachse bearbeiten</h3>
                <input value={eventDraft.title} onChange={(e) => setEventDraft((d) => ({ ...d, title: e.target.value }))} placeholder="Ereignistitel" className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white" />
                <textarea rows={2} value={eventDraft.description} onChange={(e) => setEventDraft((d) => ({ ...d, description: e.target.value }))} placeholder="Was geschieht?" className="w-full min-h-[72px] rounded-lg bg-[#11151E] border border-white/[0.1] p-3 text-xs text-white" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><select value={eventDraft.kind} onChange={(e) => setEventDraft((d) => ({ ...d, kind: e.target.value as typeof d.kind }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="fact">Fakt / Ereignis</option><option value="death">Tod einer Figur</option><option value="identity_reveal">Identität enthüllt</option><option value="secret_reveal">Geheimnis enthüllt</option><option value="scene">Szenenereignis</option></select><input type="datetime-local" value={eventDraft.occurredAt} onChange={(e) => setEventDraft((d) => ({ ...d, occurredAt: e.target.value }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white" /></div>
                {eventDraft.kind !== 'fact' && eventDraft.kind !== 'scene' && <><select value={eventDraft.subjectCharacterId} onChange={(e) => setEventDraft((d) => ({ ...d, subjectCharacterId: e.target.value }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="">Betroffene Figur wählen</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>{(eventDraft.kind === 'identity_reveal' || eventDraft.kind === 'secret_reveal') && <input value={eventDraft.canonicalValue} onChange={(e) => setEventDraft((d) => ({ ...d, canonicalValue: e.target.value }))} placeholder="Wahre Identität / Geheimnis" className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white" />}</>}
                <label className="block text-[11px] text-slate-400">Figuren in diesem Ereignis</label><div className="flex flex-wrap gap-2">{characters.map((c) => <label key={c.id} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-white/[0.04] px-3 text-xs text-slate-300"><input type="checkbox" checked={eventDraft.characterIds.includes(c.id)} onChange={(e) => setEventDraft((d) => ({ ...d, characterIds: e.target.checked ? [...d.characterIds, c.id] : d.characterIds.filter((id) => id !== c.id) }))} />{c.name}</label>)}</div>
                <select value={eventDraft.timeMode} onChange={(e) => setEventDraft((d) => ({ ...d, timeMode: e.target.value as typeof d.timeMode }))} className="w-full min-h-[44px] rounded-lg bg-[#11151E] border border-white/[0.1] px-3 text-xs text-white"><option value="present">Gegenwart</option><option value="flashback">Rückblende</option><option value="dream">Traum / Vision</option></select>
                <button type="button" onClick={handleSaveEvent} disabled={savingContinuityItem || !eventDraft.title.trim()} className="w-full min-h-[44px] rounded-lg bg-[#2563EB] text-xs font-medium text-white disabled:opacity-40">{savingContinuityItem ? 'Speichert...' : eventDraft.id ? 'Ereignis aktualisieren' : 'Ereignis hinzufügen'}</button>
                <div className="space-y-2">{continuityDetail.events.slice().sort((a,b) => a.occurredAt.localeCompare(b.occurredAt)).map((event) => <div key={event.id} className="flex items-start justify-between gap-2 rounded-lg bg-white/[0.04] p-2"><div className="min-w-0"><p className="text-xs text-white">{event.title}</p><p className="text-[10px] text-slate-500">{new Date(event.occurredAt).toLocaleString('de-DE')} · {event.kind || 'Fakt'}</p></div><button type="button" onClick={() => editEvent(event)} className="shrink-0 min-h-[40px] px-3 rounded-lg bg-white/[0.08] text-xs text-white">Bearbeiten</button></div>)}</div>
              </div>
              {continuityDetail.semanticConflicts.length > 0 && <div className="border-t border-rose-500/20 pt-3 space-y-2"><h3 className="text-xs font-semibold text-rose-300">Story-Supervisor · {continuityDetail.semanticConflicts.length} Konflikt(e)</h3>{continuityDetail.semanticConflicts.map((conflict) => <div key={conflict.id} className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] p-3 space-y-2"><p className="text-xs text-white">{conflict.message}</p><p className="text-[11px] text-slate-400">Vorschlag: {conflict.suggestion}</p>{conflict.sceneId && <button type="button" onClick={() => handleRegenerateScene(conflict.sceneId!, { conflictId: conflict.id, suggestion: conflict.suggestion, projectId: conflict.projectId })} disabled={Boolean(regenSceneId)} className="w-full min-h-[44px] rounded-lg bg-[#2563EB] text-xs text-white disabled:opacity-40">{regenSceneId === conflict.sceneId ? 'Korrigiert Szene...' : 'Diese Szene gezielt korrigieren'}</button>}</div>)}</div>}
            </div>}
            {continuityNotice && <p className="text-[11px] text-slate-400">{continuityNotice}</p>}
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

import { useMemo, useState } from 'react';
import { Download, FolderPlus, Loader2, RotateCcw, Search, Trash2, UserPlus } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { CharacterProfile, StudioProject } from '../types/zero.ts';

interface ProjectsCharactersViewProps {
  projects: StudioProject[];
  characters: CharacterProfile[];
  onProjectCreated: (p: StudioProject) => void;
  onProjectDeleted: (id: string) => void;
  onProjectUpdated: (p: StudioProject) => void;
  onCharacterCreated: (c: CharacterProfile) => void;
  onOpenDirector: () => void;
}

export function ProjectsCharactersView({
  projects,
  characters,
  onProjectCreated,
  onProjectDeleted,
  onProjectUpdated,
  onCharacterCreated,
  onOpenDirector,
}: ProjectsCharactersViewProps) {
  const [tab, setTab] = useState<'projects' | 'characters'>('projects');
  const [deletingProjId, setDeletingProjId] = useState<string | null>(null);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<'Alle' | 'Aktiv' | 'Entwurf' | 'Abgeschlossen'>('Alle');
  const filteredProjects = useMemo(() => projects.filter((p) => {
    const q = projectSearch.trim().toLocaleLowerCase('de');
    const matchesSearch = !q || [p.title, p.logline, p.genre, p.status].some((v) => v.toLocaleLowerCase('de').includes(q));
    const matchesFilter = projectFilter === 'Alle' || (projectFilter === 'Aktiv' ? p.status === 'In Produktion' : projectFilter === 'Entwurf' ? p.status === 'Konzept' : p.status === 'Exportiert' || p.status === 'Schnittbereit');
    return matchesSearch && matchesFilter;
  }), [projects, projectSearch, projectFilter]);

  // New Project form
  const [projTitle, setProjTitle] = useState('');
  const [projLogline, setProjLogline] = useState('');
  const [projDuration, setProjDuration] = useState(58);
  const [creatingProj, setCreatingProj] = useState(false);

  // New Character form
  const [charName, setCharName] = useState('');
  const [charRole, setCharRole] = useState('');
  const [charAppearance, setCharAppearance] = useState('');
  const [charClothing, setCharClothing] = useState('');
  const [charVoice, setCharVoice] = useState<CharacterProfile['voiceName']>('Charon');
  const [genRefImg] = useState(false);
  const [creatingChar, setCreatingChar] = useState(false);

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!projTitle.trim() || creatingProj) return;
    setCreatingProj(true);
    try {
      const data = await apiRequest<{ project: StudioProject }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          title: projTitle.trim(),
          logline: projLogline.trim(),
          targetDurationSec: Math.min(60, Math.max(15, projDuration)),
        }),
      });
      onProjectCreated(data.project);
      setProjTitle('');
      setProjLogline('');
    } finally {
      setCreatingProj(false);
    }
  }

  async function handleCreateCharacter(e: React.FormEvent) {
    e.preventDefault();
    if (!charName.trim() || creatingChar) return;
    setCreatingChar(true);
    try {
      const data = await apiRequest<{ character: CharacterProfile }>('/api/characters', {
        method: 'POST',
        body: JSON.stringify({
          name: charName.trim(),
          role: charRole.trim() || 'Nebenfigur',
          appearance: charAppearance.trim(),
          faceFeatures: charAppearance.trim(),
          clothing: charClothing.trim(),
          voiceName: charVoice,
          generateReference: genRefImg,
        }),
      });
      onCharacterCreated(data.character);
      setCharName('');
      setCharRole('');
      setCharAppearance('');
      setCharClothing('');
    } finally {
      setCreatingChar(false);
    }
  }

  function exportProjectJson(project: StudioProject) {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.title.toLowerCase().replace(/\s+/g, '-')}-v${project.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-[10px] font-mono tracking-[0.28em] text-rose-400 mb-2">ZERO PROJECT MANAGER</p>
          <h1 className="text-3xl font-semibold text-white">{tab === 'projects' ? 'Projekte' : 'Charaktere'}</h1>
          <p className="text-xs text-slate-400 mt-1">
            Produktionen verwalten, durchsuchen und jederzeit weiterbearbeiten.
          </p>
        </div>

        <div className="inline-flex p-1 bg-[#11151E] border border-white/[0.08] rounded-xl self-start">
          <button
            onClick={() => setTab('projects')}
            className={`min-h-[40px] px-4 rounded-lg text-xs font-medium transition-colors ${
              tab === 'projects' ? 'bg-[#F43F5E] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Projekte ({projects.length})
          </button>
          <button
            onClick={() => setTab('characters')}
            className={`min-h-[40px] px-4 rounded-lg text-xs font-medium transition-colors ${
              tab === 'characters' ? 'bg-[#F43F5E] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Charaktere ({characters.length})
          </button>
        </div>
      </div>

      {tab === 'projects' ? (
        <div className="space-y-5">
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input value={projectSearch} onChange={(e) => setProjectSearch(e.target.value)} placeholder="Projekte, Tags, Beschreibung suchen"
                className="w-full min-h-[52px] bg-[#11151E] border border-white/[0.12] rounded-2xl pl-11 pr-4 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500/60" />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {(['Alle', 'Aktiv', 'Entwurf', 'Abgeschlossen'] as const).map((filter) => (
                <button key={filter} onClick={() => setProjectFilter(filter)} className={`shrink-0 min-h-[38px] px-4 rounded-full border text-xs font-medium ${projectFilter === filter ? 'bg-rose-500/15 border-rose-500/70 text-white' : 'bg-[#11151E] border-white/[0.10] text-slate-400'}`}>{filter}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleCreateProject}
            className="lg:col-span-4 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3.5 h-fit"
          >
            <h2 className="text-base font-semibold text-white">Neues Projekt anlegen</h2>
            <input
              type="text"
              value={projTitle}
              onChange={(e) => setProjTitle(e.target.value)}
              placeholder="Projekttitel"
              className="w-full min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-white"
            />
            <textarea
              rows={2}
              value={projLogline}
              onChange={(e) => setProjLogline(e.target.value)}
              placeholder="Kurze Logline / Beschreibung"
              className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3.5 text-sm text-white"
            />
            <div>
              <label className="text-xs text-slate-400 block mb-1">
                Ziel-Laufzeit (max 60s)
              </label>
              <input
                type="number"
                min={15}
                max={60}
                value={projDuration}
                onChange={(e) => setProjDuration(Math.min(60, Math.max(15, Number(e.target.value))))}
                className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-sm font-mono text-white"
              />
            </div>
            <button
              type="submit"
              disabled={creatingProj || !projTitle.trim()}
              className="w-full min-h-[44px] rounded-xl bg-[#F43F5E] hover:bg-[#E11D48] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2"
            >
              {creatingProj ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />}
              Projekt speichern
            </button>
          </form>

          <div className="lg:col-span-8 space-y-4">
            {filteredProjects.map((p) => (
              <div
                key={p.id}
                className="bg-[#11151E] border border-white/[0.10] rounded-[24px] overflow-hidden space-y-0"
              >
                <div className="h-28 sm:h-36 bg-gradient-to-br from-slate-800 via-[#11151E] to-rose-950/40 relative overflow-hidden">
                  {p.assets.find((asset) => asset.type === 'image')?.url && <img src={p.assets.find((asset) => asset.type === 'image')!.url} alt="Projektvorschau" className="absolute inset-0 w-full h-full object-cover opacity-70" />}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#11151E] via-transparent to-black/10" />
                  <span className="absolute top-3 right-3 rounded-full border border-white/15 bg-black/35 px-3 py-1 text-[10px] font-medium tracking-wide text-slate-200">{p.status === 'In Produktion' ? 'AKTIV' : p.status === 'Konzept' ? 'ENTWURF' : p.status === 'Exportiert' ? 'ABGESCHLOSSEN' : 'SCHNITTBEREIT'}</span>
                </div>
                <div className="p-4 sm:p-5 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-400">
                      {p.genre} · Version {p.version} · {p.scenes.length} Szenen ·{' '}
                      <span className="font-mono text-slate-200">{p.targetDurationSec}s</span>
                    </p>
                    <h3 className="text-lg font-semibold text-white mt-0.5">{p.title}</h3>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={onOpenDirector}
                      className="min-h-[38px] px-3 rounded-lg bg-[#F43F5E] text-white text-xs font-medium"
                    >
                      In Regie öffnen
                    </button>
                    <button
                      onClick={() => exportProjectJson(p)}
                      className="min-h-[38px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs text-white inline-flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export JSON
                    </button>
                    {projects.length > 1 && (
                      <button
                        type="button"
                        disabled={deletingProjId === p.id}
                        onClick={async () => {
                          setDeletingProjId(p.id);
                          try {
                            await apiRequest(`/api/projects/${p.id}`, { method: 'DELETE' });
                            onProjectDeleted(p.id);
                          } finally {
                            setDeletingProjId(null);
                          }
                        }}
                        className="min-h-[38px] px-2.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 inline-flex items-center gap-1"
                        title="Projekt löschen"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{p.logline}</p>
                {p.snapshots && p.snapshots.length > 0 && (
                  <div className="pt-3 border-t border-white/[0.06] space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-slate-400">Versionsverlauf ({p.snapshots.length})</p>
                      <span className="text-[10px] text-slate-500">Vollständige Sicherungen sind wiederherstellbar</span>
                    </div>
                    {p.snapshots.slice(0, 5).map((snapshot) => (
                      <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#090B10] border border-white/[0.06] px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-xs text-slate-200">Version {snapshot.version} · {snapshot.sceneCount} Szenen · {snapshot.totalDurationSec}s</p>
                          <p className="text-[10px] text-slate-500 truncate">{snapshot.note} · {new Date(snapshot.createdAt).toLocaleString('de-DE')}</p>
                        </div>
                        <button
                          type="button"
                          disabled={!snapshot.state || restoringSnapshotId === snapshot.id}
                          onClick={async () => {
                            if (!snapshot.state || restoringSnapshotId) return;
                            const confirmed = window.confirm(`Projekt "${p.title}" wirklich auf Version ${snapshot.version} zurücksetzen? Der aktuelle Stand wird vorher als neue Sicherung gespeichert.`);
                            if (!confirmed) return;
                            setRestoringSnapshotId(snapshot.id);
                            setSnapshotError(null);
                            try {
                              const result = await apiRequest<{ project: StudioProject }>(
                                `/api/projects/${p.id}/snapshots/${snapshot.id}/restore`,
                                { method: 'POST' }
                              );
                              onProjectUpdated(result.project);
                            } catch (error) {
                              setSnapshotError(error instanceof Error ? error.message : 'Version konnte nicht wiederhergestellt werden.');
                            } finally {
                              setRestoringSnapshotId(null);
                            }
                          }}
                          className="min-h-[34px] px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-not-allowed text-[11px] text-white inline-flex items-center gap-1.5"
                          title={snapshot.state ? 'Diese Projektversion wiederherstellen' : 'Nur Metadaten vorhanden; diese alte Version ist nicht wiederherstellbar'}
                        >
                          {restoringSnapshotId === snapshot.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          {snapshot.state ? 'Wiederherstellen' : 'Nur Info'}
                        </button>
                      </div>
                    ))}
                    {snapshotError && <p role="alert" className="text-xs text-rose-300">{snapshotError}</p>}
                  </div>
                )}
                {p.assets && p.assets.length > 0 && (
                  <div className="pt-2 border-t border-white/[0.06] space-y-1.5">
                    <p className="text-[11px] font-medium text-slate-400">
                      Gespeicherte Studio-Assets ({p.assets.length}):
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {p.assets.slice(0, 4).map((a) => (
                        <div
                          key={a.id}
                          className="p-2 rounded-lg bg-[#090B10] border border-white/[0.06] text-[11px] flex items-center justify-between gap-2"
                        >
                          <span className="truncate text-slate-200">
                            [{a.type.toUpperCase()}] {a.title}
                          </span>
                          <span className="font-mono text-slate-500 shrink-0">{a.modelId}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="pt-2 border-t border-white/[0.06] text-[11px] text-slate-500 font-mono">
                  {p.scenes.length} Folgen/Szenen · {p.scenes.filter((scene) => scene.status === 'Szenenbereit').length} bereit · {p.assets.length} Assets
                </div>
                </div>
              </div>
            ))}
            {filteredProjects.length === 0 && <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-sm text-slate-400">Keine passenden Projekte gefunden.</div>}
          </div>
        </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleCreateCharacter}
            className="lg:col-span-4 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3.5 h-fit"
          >
            <h2 className="text-base font-semibold text-white">Charakterprofil erstellen</h2>
            <input
              type="text"
              value={charName}
              onChange={(e) => setCharName(e.target.value)}
              placeholder="Name (z.B. Lukas Weber)"
              className="w-full min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-white"
            />
            <input
              type="text"
              value={charRole}
              onChange={(e) => setCharRole(e.target.value)}
              placeholder="Rolle (z.B. Tontechniker)"
              className="w-full min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-white"
            />
            <textarea
              rows={2}
              value={charAppearance}
              onChange={(e) => setCharAppearance(e.target.value)}
              placeholder="Gesichts- & Körpermerkmale (auf Englisch oder Deutsch)"
              className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3 text-sm text-white"
            />
            <input
              type="text"
              value={charClothing}
              onChange={(e) => setCharClothing(e.target.value)}
              placeholder="Kleidung (z.B. Schwarze Lederjacke, Brille)"
              className="w-full min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-white"
            />
            <select
              value={charVoice}
              onChange={(e) => setCharVoice(e.target.value as CharacterProfile['voiceName'])}
              className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
            >
              <option value="Kore">Stimme: Kore</option>
              <option value="Charon">Stimme: Charon</option>
              <option value="Fenrir">Stimme: Fenrir</option>
              <option value="Puck">Stimme: Puck</option>
              <option value="Zephyr">Stimme: Zephyr</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-slate-300 min-h-[38px] cursor-pointer">
              <input
                type="checkbox"
                checked={genRefImg}
                disabled
              />
              Referenzporträt-Generierung (Cloud derzeit deaktiviert)
            </label>
            <button
              type="submit"
              disabled={creatingChar || !charName.trim()}
              className="w-full min-h-[44px] rounded-xl bg-[#F43F5E] hover:bg-[#E11D48] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2"
            >
              {creatingChar ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              Charakter speichern
            </button>
          </form>

          <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {characters.map((c) => (
              <div
                key={c.id}
                className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 space-y-3"
              >
                <div className="flex items-center gap-3.5">
                  <div className="w-16 h-16 rounded-xl overflow-hidden bg-[#090B10] border border-white/[0.08] shrink-0">
                    {c.referenceImageUrl ? (
                      <img
                        src={c.referenceImageUrl}
                        alt={c.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                        Kein Bild
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">
                      {c.role} · Stimme {c.voiceName}
                    </p>
                    <h3 className="text-base font-semibold text-white">{c.name}</h3>
                  </div>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{c.consistencyPrompt}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

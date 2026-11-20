import { Component, lazy, Suspense, useCallback, useEffect, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react';
import {
  Brain,
  Clapperboard,
  Cpu,
  Database,
  Film,
  FolderKanban,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Mic,
  Music,
  Settings,
  Workflow,
  X,
} from 'lucide-react';
import { apiRequest } from './lib/api.ts';
import type {
  AutomationRun,
  BackupConfigState,
  BudgetGuardState,
  CharacterProfile,
  ChatMessage,
  DevelopmentPhase,
  IstZustandItem,
  MemoryEntry,
  ModelDefinition,
  NavigationTab,
  StudioProject,
  SystemBackupMeta,
} from './types/zero.ts';
const HomeView = lazy(() => import('./components/HomeView.tsx').then((module) => ({ default: module.HomeView })));
const BrainView = lazy(() => import('./components/BrainView.tsx').then((module) => ({ default: module.BrainView })));
const ModelHubView = lazy(() => import('./components/ModelHubView.tsx').then((module) => ({ default: module.ModelHubView })));
const ImageStudioView = lazy(() => import('./components/ImageStudioView.tsx').then((module) => ({ default: module.ImageStudioView })));
const VideoStudioView = lazy(() => import('./components/VideoStudioView.tsx').then((module) => ({ default: module.VideoStudioView })));
const AudioStudioView = lazy(() => import('./components/AudioStudioView.tsx').then((module) => ({ default: module.AudioStudioView })));
const MusicStudioView = lazy(() => import('./components/MusicStudioView.tsx').then((module) => ({ default: module.MusicStudioView })));
const FilmDirectorView = lazy(() => import('./components/FilmDirectorView.tsx').then((module) => ({ default: module.FilmDirectorView })));
const ProjectsCharactersView = lazy(() => import('./components/ProjectsCharactersView.tsx').then((module) => ({ default: module.ProjectsCharactersView })));
const MemoryView = lazy(() => import('./components/MemoryView.tsx').then((module) => ({ default: module.MemoryView })));
const SettingsView = lazy(() => import('./components/SettingsView.tsx').then((module) => ({ default: module.SettingsView })));


class StudioLoadErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ZERO STUDIO] Studio konnte nicht geladen werden:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <section role="alert" className="mx-auto flex min-h-[40vh] max-w-xl flex-col items-center justify-center gap-3 rounded-2xl border border-rose-400/20 bg-[#11151E] p-6 text-center">
          <p className="text-sm font-semibold text-white">Dieser Studio-Bereich konnte nicht geladen werden.</p>
          <p className="text-xs leading-relaxed text-slate-400">Möglicherweise ist noch eine ältere App-Version im Browser-Cache. Lade ZERO neu, um die aktuellen Dateien abzurufen.</p>
          <button type="button" onClick={() => window.location.reload()} className="min-h-[44px] rounded-xl bg-rose-500 px-5 text-sm font-semibold text-white">ZERO neu laden</button>
        </section>
      );
    }
    return this.props.children;
  }
}

interface NavItem {
  id: NavigationTab;
  label: string;
  icon: typeof Home;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'brain', label: 'ZERO BRAIN', icon: Brain },
  { id: 'models', label: 'MODEL HUB', icon: Cpu },
  { id: 'image', label: 'IMAGE STUDIO', icon: ImageIcon },
  { id: 'video', label: 'VIDEO STUDIO', icon: Film },
  { id: 'audio', label: 'AUDIO STUDIO', icon: Mic },
  { id: 'music', label: 'MUSIC STUDIO', icon: Music },
  { id: 'director', label: 'FILM DIRECTOR', icon: Clapperboard },
  { id: 'projects', label: 'PROJECTS', icon: FolderKanban },
  { id: 'memory', label: 'MEMORY', icon: Database },
  { id: 'automation', label: 'AUTOMATION', icon: Workflow },
  { id: 'settings', label: 'SETTINGS', icon: Settings },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<NavigationTab>('home');
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authStatusLoading, setAuthStatusLoading] = useState(true);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);

  const [models, setModels] = useState<ModelDefinition[]>([]);
  const [budgetGuard, setBudgetGuard] = useState<BudgetGuardState | null>(null);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [backups, setBackups] = useState<SystemBackupMeta[]>([]);
  const [backupConfig, setBackupConfig] = useState<BackupConfigState>({
    currentVersion: '1.1.0',
    autoZipOnChange: true,
    lastVerifiedAt: null,
    zipBackups: [],
    changelogHistory: [],
  });
  const [excludedSecrets, setExcludedSecrets] = useState<string[]>([]);
  const [istZustand, setIstZustand] = useState<IstZustandItem[]>([]);
  const [roadmap, setRoadmap] = useState<DevelopmentPhase[]>([]);
  const [videoProjectId, setVideoProjectId] = useState<string | undefined>(undefined);
  const [videoSoundtrack, setVideoSoundtrack] = useState<{ url: string; title: string } | null>(
    null
  );

  useEffect(() => {
    const onSessionExpired = () => {
      setAuthRequired(true);
      setLoading(false);
      setAuthStatusLoading(false);
    };
    window.addEventListener('zero:session-expired', onSessionExpired);
    return () => window.removeEventListener('zero:session-expired', onSessionExpired);
  }, []);

  useEffect(() => {
    const userAgent = window.navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/i.test(userAgent);
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    setShowIosInstallHint(isIos && !isStandalone);
  }, []);

  const loadAllData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [modelsRes, projRes, charRes, memRes, brainRes, autoRes, auditRes, zipRes] =
        await Promise.all([
          apiRequest<{ models: ModelDefinition[]; budgetGuard: BudgetGuardState }>('/api/models'),
          apiRequest<{ projects: StudioProject[] }>('/api/projects'),
          apiRequest<{ characters: CharacterProfile[] }>('/api/characters'),
          apiRequest<{ memories: MemoryEntry[] }>('/api/memory'),
          apiRequest<{ messages: ChatMessage[] }>('/api/brain/history'),
          apiRequest<{ runs: AutomationRun[] }>('/api/automation'),
          apiRequest<{
            istZustand: IstZustandItem[];
            roadmap: DevelopmentPhase[];
            budgetGuard: BudgetGuardState;
            backups: SystemBackupMeta[];
          }>('/api/system/audit'),
          apiRequest<
            BackupConfigState & {
              totalStorageBytes: number;
              excludedSecrets: string[];
            }
          >('/api/system/zip-backups'),
        ]);

      setModels(modelsRes.models);
      setBudgetGuard(auditRes.budgetGuard);
      setProjects(projRes.projects);
      setCharacters(charRes.characters);
      setMemories(memRes.memories);
      setChatMessages(brainRes.messages);
      setAutomationRuns(autoRes.runs);
      setBackups(auditRes.backups);
      setIstZustand(auditRes.istZustand);
      setRoadmap(auditRes.roadmap);
      setBackupConfig({
        currentVersion: zipRes.currentVersion,
        autoZipOnChange: zipRes.autoZipOnChange,
        lastVerifiedAt: zipRes.lastVerifiedAt,
        zipBackups: zipRes.zipBackups,
        changelogHistory: zipRes.changelogHistory,
      });
      setExcludedSecrets(zipRes.excludedSecrets ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Backend konnte nicht geladen werden.';
      if (message.includes('401') || message.includes('Anmeldung erforderlich')) {
        setAuthRequired(true);
        setLoadError(null);
      } else {
        setLoadError(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setAuthStatusLoading(true);
      try {
        const status = await apiRequest<{
          required: boolean;
          configured: boolean;
          authenticated: boolean;
        }>('/api/auth/status');
        if (cancelled) return;
        setAuthEnabled(status.required);
        setAuthConfigured(status.configured);
        if (status.required && (!status.configured || !status.authenticated)) {
          setAuthRequired(true);
          setLoading(false);
          return;
        }
        await loadAllData();
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Backend konnte nicht geladen werden.');
          setLoading(false);
        }
      } finally {
        if (!cancelled) setAuthStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAllData]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: authPassword }),
      });
      const status = await apiRequest<{ authenticated: boolean }>('/api/auth/status');
      if (!status.authenticated) throw new Error('Anmeldung konnte nicht bestätigt werden.');
      setAuthRequired(false);
      setAuthPassword('');
      await loadAllData();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } finally {
      setAuthRequired(true);
      setAuthPassword('');
      setMobileSheetOpen(false);
      setLoading(false);
    }
  }

  function navigateTo(tab: NavigationTab) {
    setActiveTab(tab);
    setMobileSheetOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleProjectUpdated(updated: StudioProject) {
    setProjects((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === activeTab) ?? NAV_ITEMS[0];

  if (authStatusLoading || loading) {
    return (
      <div className="min-h-screen bg-[#090B10] text-white flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <Loader2 className="w-5 h-5 animate-spin text-[#F43F5E]" />
          ZERO AI STUDIO initialisiert Module...
        </div>
      </div>
    );
  }

  if (authRequired) {
    return (
      <div className="min-h-screen bg-[#090B10] text-white flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-[#11151E] border border-white/[0.1] rounded-2xl p-6 space-y-5">
          <div className="space-y-2">
            <p className="text-[10px] tracking-[0.24em] text-rose-400 font-semibold">BEYOND LIMITS.</p>
            <h1 className="text-xl font-semibold">ZERO AI STUDIO</h1>
            <p className="text-sm text-slate-400">
              {authConfigured
                ? 'Dieser ZERO-Server ist geschützt. Melde dich mit deinem Admin-Passwort an.'
                : 'Der Server ist noch nicht sicher konfiguriert. Setze ZERO_ADMIN_PASSWORD (mindestens 12 Zeichen) und ZERO_SESSION_SECRET (mindestens 32 Zeichen) in den Hosting-Umgebungsvariablen.'}
            </p>
          </div>
          {authConfigured ? (
            <form onSubmit={handleLogin} className="space-y-3">
              <label className="block text-xs text-slate-300" htmlFor="zero-admin-password">Admin-Passwort</label>
              <input
                id="zero-admin-password"
                type="password"
                autoComplete="current-password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                required
                className="w-full min-h-[48px] rounded-xl bg-[#090B10] border border-white/10 px-4 text-sm text-white outline-none focus:border-rose-400"
                placeholder="Admin-Passwort eingeben"
              />
              {authError && <p className="text-xs text-rose-300">{authError}</p>}
              <button
                type="submit"
                disabled={authBusy || !authPassword}
                className="w-full min-h-[48px] rounded-xl bg-[#F43F5E] text-white text-sm font-semibold disabled:opacity-50"
              >
                {authBusy ? 'Anmeldung läuft...' : 'Sicher anmelden'}
              </button>
            </form>
          ) : (
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">
              Bis beide Variablen gesetzt sind, bleiben alle privaten API-Daten gesperrt.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#090B10] text-white flex items-center justify-center p-6">
        <div className="max-w-md bg-[#11151E] border border-white/[0.1] rounded-2xl p-6 space-y-4">
          <h1 className="text-lg font-semibold text-white">Verbindungsfehler</h1>
          <p className="text-xs text-rose-300">{loadError}</p>
          <button
            onClick={() => void loadAllData()}
            className="min-h-[44px] px-4 rounded-xl bg-[#F43F5E] text-white text-sm font-medium"
          >
            Erneut verbinden
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090B10] text-[#F1F4F9] flex flex-col">
      {/* Desktop Top Bar (3-Zone Contract) */}
      <header className="hidden lg:flex h-14 px-6 border-b border-white/[0.08] bg-[#090B10]/95 backdrop-blur-md sticky top-0 z-30 items-center justify-between gap-8">
        <button
          onClick={() => navigateTo('home')}
          className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          ZERO AI STUDIO
        </button>

        <nav className="flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            onClick={() => navigateTo('brain')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'brain' ? 'text-white' : ''
            }`}
          >
            ZERO BRAIN
          </button>
          <button
            onClick={() => navigateTo('models')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'models' ? 'text-white' : ''
            }`}
          >
            MODEL HUB
          </button>
          <button
            onClick={() => navigateTo('director')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'director' ? 'text-white' : ''
            }`}
          >
            FILM DIRECTOR
          </button>
          <button
            onClick={() => navigateTo('settings')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'settings' ? 'text-white' : ''
            }`}
          >
            BACKUP & EXPORT
          </button>
        </nav>

        <div className="shrink-0 flex items-center gap-2">
          {authEnabled && (
            <button
              onClick={() => void handleLogout()}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-white/10 text-xs text-slate-300 hover:text-white"
            >
              Abmelden
            </button>
          )}
          <button
            onClick={() => navigateTo('director')}
            className="min-h-[38px] px-4 py-1.5 rounded-lg bg-[#F43F5E] hover:bg-[#E11D48] text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0"
          >
            Kurzfilm starten
          </button>
        </div>
      </header>

      {/* Mobile Compact Top Bar (<= 52px) */}
      <header className="lg:hidden min-h-[64px] pt-safe px-4 border-b border-white/[0.08] bg-[#090B10]/95 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between gap-3">
        <button
          onClick={() => navigateTo('home')}
          className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          <span className="block">ZERO AI STUDIO</span>
          <span className="block text-[9px] tracking-[0.24em] text-rose-400 font-medium">BEYOND LIMITS.</span>
        </button>
        <span className="text-xs font-medium text-slate-400 truncate">{activeNav.label}</span>
        <button
          onClick={() => setMobileSheetOpen(true)}
          className="min-h-[40px] px-2.5 text-xs font-medium text-sky-400 whitespace-nowrap shrink-0"
        >
          Alle Studios
        </button>
      </header>

      {/* Main Layout */}
      <div className="flex-1 flex max-w-[1600px] w-full mx-auto">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-white/[0.08] p-4 gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => navigateTo(item.id)}
                className={`min-h-[44px] px-3.5 rounded-xl flex items-center gap-3 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-[#F43F5E] text-white'
                    : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>

        {/* Active Studio Viewport */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pb-28 lg:pb-12">
          {showIosInstallHint && (
            <section className="mb-5 rounded-2xl border border-rose-400/20 bg-[#11151E] p-4" aria-label="ZERO auf dem iPhone installieren">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold tracking-[0.16em] text-rose-300">ZERO AUF DEM IPHONE</p>
                  <p className="mt-1 text-sm font-semibold text-white">Als App zum Home-Bildschirm hinzufügen</p>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">
                    In Safari auf „Teilen“ tippen, „Zum Home-Bildschirm“ auswählen und anschließend „Hinzufügen“ bestätigen.
                  </p>
                </div>
                <button type="button" onClick={() => setShowIosInstallHint(false)} className="min-h-[36px] min-w-[36px] rounded-lg text-slate-400 hover:text-white" aria-label="Installationshinweis schließen">
                  <X className="mx-auto h-4 w-4" />
                </button>
              </div>
            </section>
          )}
          <StudioLoadErrorBoundary>
          <Suspense fallback={<div className="flex min-h-[40vh] items-center justify-center gap-3 text-sm text-slate-400"><Loader2 className="h-5 w-5 animate-spin text-rose-400" />Studio wird geladen…</div>}>
          {activeTab === 'home' && (
            <HomeView
              models={models}
              projects={projects}
              istZustand={istZustand}
              roadmap={roadmap}
              spentEur={budgetGuard?.totalSpentEur ?? 0}
              onNavigate={navigateTo}
            />
          )}

          {(activeTab === 'brain' || activeTab === 'automation') && (
            <BrainView
              initialMessages={chatMessages}
              projects={projects}
              initialRuns={automationRuns}
              initialMode={activeTab === 'automation' ? 'automation' : 'assistant'}
            />
          )}

          {activeTab === 'models' && (
            <ModelHubView
              models={models}
              onModelUpdated={(updated) =>
                setModels((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
              }
              onModelsReplaced={setModels}
            />
          )}

          {activeTab === 'image' && (
            <ImageStudioView
              characters={characters}
              projects={projects}
              onProjectUpdated={handleProjectUpdated}
            />
          )}

          {activeTab === 'video' && (
            <VideoStudioView
              projects={projects}
              activeProjectId={videoProjectId}
              soundtrack={videoSoundtrack}
            />
          )}

          {activeTab === 'audio' && (
            <AudioStudioView projects={projects} onProjectUpdated={handleProjectUpdated} />
          )}

          {activeTab === 'music' && (
            <MusicStudioView
              projects={projects}
              onProjectUpdated={handleProjectUpdated}
              onUseInVideoStudio={(url, title) => {
                setVideoSoundtrack({ url, title });
                navigateTo('video');
              }}
            />
          )}

          {activeTab === 'director' && (
            <FilmDirectorView
              projects={projects}
              characters={characters}
              onProjectCreated={(p) => setProjects((prev) => [p, ...prev])}
              onProjectUpdated={handleProjectUpdated}
              onOpenVideoStudio={(pid) => {
                setVideoProjectId(pid);
                navigateTo('video');
              }}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectsCharactersView
              projects={projects}
              characters={characters}
              onProjectCreated={(p) => setProjects((prev) => [p, ...prev])}
              onProjectDeleted={(id) =>
                setProjects((prev) => prev.filter((item) => item.id !== id))
              }
              onProjectUpdated={handleProjectUpdated}
              onCharacterCreated={(c) => setCharacters((prev) => [c, ...prev])}
              onOpenDirector={() => navigateTo('director')}
            />
          )}

          {activeTab === 'memory' && (
            <MemoryView
              memories={memories}
              onMemoryAdded={(entry) => setMemories((prev) => [entry, ...prev])}
              onMemoryDeleted={(id) =>
                setMemories((prev) => prev.filter((item) => item.id !== id))
              }
            />
          )}

          {activeTab === 'settings' && budgetGuard && (
            <SettingsView
              budgetGuard={budgetGuard}
              initialBackups={backups}
              initialBackupConfig={backupConfig}
              initialExcludedSecrets={excludedSecrets}
              onRestored={() => void loadAllData()}
            />
          )}
          </Suspense>
          </StudioLoadErrorBoundary>
        </main>
      </div>

      {/* ZERO mobile primary navigation: six clear destinations */}
      <nav aria-label="Hauptnavigation" className="lg:hidden fixed bottom-0 left-0 right-0 z-40 min-h-[72px] pb-safe bg-[#090B10]/96 backdrop-blur-xl border-t border-white/[0.10] grid grid-cols-6 items-center px-1">
        {([
          { id: 'home', label: 'Übersicht', icon: LayoutGrid, active: activeTab === 'home' },
          { id: 'brain', label: 'Erstellen', icon: Brain, active: ['brain','automation','director','image','video','audio','music'].includes(activeTab) },
          { id: 'projects', label: 'Projekte', icon: Film, active: activeTab === 'projects' },
          { id: 'models', label: 'Modelle', icon: Cpu, active: activeTab === 'models' },
          { id: 'memory', label: 'Bibliothek', icon: FolderKanban, active: activeTab === 'memory' },
          { id: 'settings', label: 'Setup', icon: Settings, active: activeTab === 'settings' },
        ] as const).map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} onClick={() => navigateTo(item.id)} aria-current={item.active ? 'page' : undefined}
              className={`relative min-h-[60px] flex flex-col items-center justify-center gap-1 transition-colors ${item.active ? 'text-[#F43F5E]' : 'text-slate-400'}`}>
              {item.active && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-9 h-[3px] rounded-full bg-[#F43F5E]" />}
              <Icon className="w-[21px] h-[21px]" strokeWidth={item.active ? 2.3 : 1.8} />
              <span className="text-[9px] sm:text-[10px] font-medium tracking-tight whitespace-nowrap">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Mobile Bottom Sheet for all 12 Navigation Destinations */}
      {mobileSheetOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end"
          onClick={() => setMobileSheetOpen(false)}
        >
          <div
            className="w-full bg-[#11151E] border-t border-white/[0.1] rounded-t-3xl p-5 pb-safe space-y-4 max-h-[82vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-white/20 rounded-full mx-auto" />
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Alle ZERO Studios</h2>
              <button
                onClick={() => setMobileSheetOpen(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => navigateTo(item.id)}
                    className={`min-h-[48px] px-3.5 rounded-xl border text-left flex items-center gap-2.5 text-xs font-medium ${
                      isActive
                        ? 'bg-[#F43F5E] border-[#F43F5E] text-white'
                        : 'bg-[#090B10] border-white/[0.08] text-slate-200'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
            {authEnabled && (
              <button
                onClick={() => void handleLogout()}
                className="w-full min-h-[44px] rounded-xl border border-white/10 text-sm text-slate-300"
              >
                Sicher abmelden
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import {
  ArrowRight,
  Brain,
  Clapperboard,
  Cpu,
  Film,
  Image as ImageIcon,
  Mic,
  Music,
  ShieldCheck,
} from 'lucide-react';
import type {
  DevelopmentPhase,
  IstZustandItem,
  ModelDefinition,
  NavigationTab,
  StudioProject,
} from '../types/zero.ts';

interface HomeViewProps {
  models: ModelDefinition[];
  projects: StudioProject[];
  istZustand: IstZustandItem[];
  roadmap: DevelopmentPhase[];
  spentEur: number;
  onNavigate: (tab: NavigationTab) => void;
}

export function HomeView({
  models,
  projects,
  istZustand,
  roadmap,
  spentEur,
  onNavigate,
}: HomeViewProps) {
  const activeModels = models.filter(
    (m) =>
      m.enabled &&
      (m.status === 'FUNKTIONIERT' ||
        m.status === 'LOKAL INSTALLIERT' ||
        m.status === 'Ready for Deployment')
  );
  const blockedPaid = models.filter((m) => m.requiresPaidKey).length;
  const activeProject = projects[0];

  const studioShortcuts: Array<{
    tab: NavigationTab;
    title: string;
    desc: string;
    icon: typeof Brain;
  }> = [
    {
      tab: 'brain',
      title: 'ZERO BRAIN & Web',
      desc: 'Assistent, echte Google-Search-Quellen & Automatisierung.',
      icon: Brain,
    },
    {
      tab: 'director',
      title: 'Film Director',
      desc: 'Idee zu komplettem 58-Sekunden-Kurzfilm mit Szenenregie.',
      icon: Clapperboard,
    },
    {
      tab: 'image',
      title: 'Image Studio',
      desc: 'FLUX.1 Free Cloud, Charakterkonsistenz & 2x Upscaling.',
      icon: ImageIcon,
    },
    {
      tab: 'video',
      title: 'Video Studio',
      desc: 'Ken-Burns Schnitt, Untertitel & Export bis max. 60 Sekunden.',
      icon: Film,
    },
    {
      tab: 'audio',
      title: 'Audio Studio',
      desc: 'Gemini 3.8 TTS, Apple AVSpeech & Whisper/Gemini Transkription.',
      icon: Mic,
    },
    {
      tab: 'music',
      title: 'Music Studio',
      desc: 'Prozeduraler Thriller-Synthesizer & SFX mit WAV-Export.',
      icon: Music,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Hero Split */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 bg-[#11151E] border border-white/[0.08] rounded-2xl p-6 sm:p-8 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-slate-400">
              ZERO CORE · iPhone 16 Pro Max Zielarchitektur · Budget 0,00 €
            </p>
            <h1 className="mt-3 text-3xl sm:text-4xl font-semibold text-white tracking-tight text-balance">
              Nichts ist zufällig. Dein eigenständiges KI-Produktionsstudio.
            </h1>
            <p className="mt-4 text-sm sm:text-base text-slate-300 leading-relaxed max-w-2xl">
              ZERO AI STUDIO verbindet echte kostenlose Cloud-Modelle mit lokalen On-Device
              Synthese-, Bild-, Audio- und Video-Pipelines. Keine Abonnements, keine versteckten
              Upgrades, harte 60-Sekunden-Videogrenze.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onNavigate('director')}
              className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              Kurzfilm produzieren
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => onNavigate('models')}
              className="min-h-[44px] px-5 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-slate-100 text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Cpu className="w-4 h-4 text-slate-300" />
              Model Hub prüfen
            </button>
          </div>
        </div>

        <div className="lg:col-span-5 relative rounded-2xl overflow-hidden border border-white/[0.08] bg-[#11151E] min-h-[240px]">
          <img
            src="/src/assets/images/hero_studio_console_1794745336582.jpg"
            alt="ZERO AI STUDIO Mastering- und Produktionskonsole"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover lg:h-full"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-5">
            <p className="text-xs text-slate-300">
              Aktives Beispielprojekt · {activeProject?.targetDurationSec ?? 58}s Laufzeit
            </p>
            <p className="mt-1 text-base font-semibold text-white">
              {activeProject ? activeProject.title : 'Schatten über Mitte'}
            </p>
            <p className="mt-1 text-xs text-slate-300 line-clamp-2">
              {activeProject?.logline}
            </p>
          </div>
        </div>
      </section>

      {/* 4-Column Tabular KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-5">
          <p className="text-xs text-slate-400">Laufende Kosten</p>
          <p className="mt-2 text-2xl font-semibold text-white font-mono tabular-nums">
            {spentEur.toFixed(2).replace('.', ',')} €
          </p>
          <p className="mt-1 text-xs text-emerald-400 inline-flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            {blockedPaid} Bezahlanbieter gesperrt
          </p>
        </div>

        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-5">
          <p className="text-xs text-slate-400">Aktive 0 € Adapter</p>
          <p className="mt-2 text-2xl font-semibold text-white font-mono tabular-nums">
            {activeModels.length} / {models.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">Geprüft & sofort lauffähig</p>
        </div>

        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-5">
          <p className="text-xs text-slate-400">Video-Obergrenze</p>
          <p className="mt-2 text-2xl font-semibold text-white font-mono tabular-nums">
            60,0 s
          </p>
          <p className="mt-1 text-xs text-slate-400">Zielbereich 55–60 Sekunden</p>
        </div>

        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-5">
          <p className="text-xs text-slate-400">Studio-Projekte</p>
          <p className="mt-2 text-2xl font-semibold text-white font-mono tabular-nums">
            {projects.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">Lokal persistent gesichert</p>
        </div>
      </section>

      {/* Module Shortcuts */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Produktionsmodule</h2>
          <span className="text-xs text-slate-400">Alle Werkzeuge ohne Bezahlschranke</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {studioShortcuts.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.tab}
                onClick={() => onNavigate(item.tab)}
                className="text-left bg-[#11151E] hover:bg-[#161B26] border border-white/[0.08] rounded-2xl p-5 transition-colors min-h-[44px] group"
              >
                <div className="flex items-center justify-between">
                  <div className="w-9 h-9 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-slate-200">
                    <Icon className="w-4 h-4" />
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">{item.desc}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Phase 1 Audit: Ist-Zustand & Entwicklungsplan */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-white">
              Technischer Ist-Zustand & Ehrliche Hardware-Prüfung
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Unterscheidung zwischen laufenden 0 € Modulen, iPhone CoreML/MLX & GPU-Modellen
            </p>
          </div>
          <div className="divide-y divide-white/[0.07]">
            {istZustand.map((item) => (
              <div key={item.area} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-white">{item.area}</p>
                  <span className="text-xs font-mono text-slate-400 shrink-0">
                    {item.status === 'neu_implementiert'
                      ? 'AKTIV'
                      : item.status === 'vorhanden'
                        ? 'BASIS'
                        : 'HARDWARE'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-300">{item.summary}</p>
                <p className="mt-0.5 text-xs text-slate-500">{item.details}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-white">
              12-Phasen Entwicklungsplan
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Web-Ökosystem komplett produktiv; Phase 12 beschreibt die native iOS SwiftUI Bridge
            </p>
          </div>
          <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
            {roadmap.map((p) => (
              <div
                key={p.phase}
                className="flex items-start justify-between gap-3 py-2 border-b border-white/[0.06] last:border-b-0"
              >
                <div>
                  <p className="text-sm font-medium text-white">
                    <span className="font-mono text-slate-400 mr-2">
                      {String(p.phase).padStart(2, '0')}.
                    </span>
                    {p.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">{p.deliverables.join(' · ')}</p>
                </div>
                <span
                  className={`text-xs font-mono shrink-0 ${
                    p.status === 'abgeschlossen' ? 'text-emerald-400' : 'text-sky-400'
                  }`}
                >
                  {p.status === 'abgeschlossen' ? 'BEREIT' : 'iOS NATIV'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

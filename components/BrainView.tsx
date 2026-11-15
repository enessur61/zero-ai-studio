import { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  Send,
  ShieldAlert,
  Trash2,
  Workflow,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import {
  type NativeIOSTextModelId,
  runNativeCoreMLPrompt,
} from '../lib/iosCoreMLBridge.ts';
import type { AutomationRun, ChatMessage, StudioProject } from '../types/zero.ts';

interface BrainViewProps {
  initialMessages: ChatMessage[];
  projects: StudioProject[];
  initialRuns: AutomationRun[];
  initialMode?: 'assistant' | 'web' | 'automation';
}

export function BrainView({
  initialMessages,
  projects,
  initialRuns,
  initialMode = 'assistant',
}: BrainViewProps) {
  const [mode, setMode] = useState<'assistant' | 'web' | 'automation'>(initialMode);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  // Assistant state
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState<
    | 'gemini-3.8-flash'
    | 'gemini-3.1-flash-lite'
    | 'gpt-oss-20b-free'
    | NativeIOSTextModelId
  >('gemini-3.8-flash');
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? '');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // Web Intelligence state
  const [researchQuery, setResearchQuery] = useState('');
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchResult, setResearchResult] = useState<{
    report: string;
    sources: Array<{ title: string; uri: string }>;
    modelUsed: string;
  } | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);

  // Automation Engine state
  const [autoGoal, setAutoGoal] = useState(
    'Analysiere das Projekt "Schatten über Mitte", prüfe alle 4 Szenen auf 60s-Limit und bereite Audio- und Export-Checkliste vor.'
  );
  const [includeGate, setIncludeGate] = useState(true);
  const [runs, setRuns] = useState<AutomationRun[]>(initialRuns);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  async function handleSendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || chatLoading) return;
    setChatError(null);
    setChatLoading(true);
    try {
      if (
        selectedModel === 'llama-3.2-1b-coreml' ||
        selectedModel === 'llama-3.2-3b-coreml' ||
        selectedModel === 'qwen-2.5-3b-coreml' ||
        selectedModel === 'gemma-3-4b-it' ||
        selectedModel === 'deepseek-r1-distill-1.5b'
      ) {
        const promptText = input.trim();
        const res = await runNativeCoreMLPrompt({
          modelId: selectedModel,
          prompt: promptText,
        });
        const now = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          { id: `msg-u-${Date.now()}`, role: 'user', content: promptText, timestamp: now },
          {
            id: `msg-a-${Date.now() + 1}`,
            role: 'assistant',
            content: res.text || '',
            modelUsed: selectedModel,
            routingSteps: [
              `ZERO CORE -> iOS WKWebView Bridge (${selectedModel} · A18 Pro Neural Engine/MLX · 0,00 €)`,
            ],
            timestamp: new Date().toISOString(),
          },
        ]);
        setInput('');
      } else {
        const data = await apiRequest<{ messages: ChatMessage[] }>('/api/brain/chat', {
          method: 'POST',
          body: JSON.stringify({
            message: input.trim(),
            modelId: selectedModel,
            useWebSearch,
            projectId: selectedProjectId,
          }),
        });
        setMessages(data.messages);
        setInput('');
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Fehler bei ZERO BRAIN');
    } finally {
      setChatLoading(false);
    }
  }

  async function handleClearChat() {
    const data = await apiRequest<{ messages: ChatMessage[] }>('/api/brain/clear', {
      method: 'POST',
    });
    setMessages(data.messages);
  }

  async function handleResearch(e: React.FormEvent) {
    e.preventDefault();
    if (!researchQuery.trim() || researchLoading) return;
    setResearchLoading(true);
    setResearchError(null);
    try {
      const data = await apiRequest<{
        report: string;
        sources: Array<{ title: string; uri: string }>;
        modelUsed: string;
      }>('/api/web/research', {
        method: 'POST',
        body: JSON.stringify({ query: researchQuery.trim() }),
      });
      setResearchResult(data);
    } catch (err) {
      setResearchError(err instanceof Error ? err.message : 'Recherche fehlgeschlagen');
    } finally {
      setResearchLoading(false);
    }
  }

  async function handleStartAutomation(e: React.FormEvent) {
    e.preventDefault();
    if (!autoGoal.trim() || autoLoading) return;
    setAutoLoading(true);
    setAutoError(null);
    try {
      const data = await apiRequest<{ run: AutomationRun }>('/api/automation/run', {
        method: 'POST',
        body: JSON.stringify({
          goal: autoGoal.trim(),
          includeExternalPublishGate: includeGate,
        }),
      });
      setRuns((prev) => [data.run, ...prev]);
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : 'Automatisierung fehlgeschlagen');
    } finally {
      setAutoLoading(false);
    }
  }

  async function handleConfirmGate(runId: string) {
    const data = await apiRequest<{ run: AutomationRun }>(`/api/automation/${runId}/confirm`, {
      method: 'POST',
    });
    setRuns((prev) => prev.map((r) => (r.id === runId ? data.run : r)));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">ZERO BRAIN & Intelligence</h1>
          <p className="text-xs text-slate-400 mt-1">
            Zentrales KI-Gehirn · Verifizierte Webrecherche · Mehrstufige Automatisierung
          </p>
        </div>

        {/* Segmented Control */}
        <div className="inline-flex items-center p-1 bg-[#11151E] border border-white/[0.08] rounded-xl self-start">
          <button
            onClick={() => setMode('assistant')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              mode === 'assistant' ? 'bg-[#2563EB] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            Assistent
          </button>
          <button
            onClick={() => setMode('web')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              mode === 'web' ? 'bg-[#2563EB] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            Web Intelligence
          </button>
          <button
            onClick={() => setMode('automation')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              mode === 'automation' ? 'bg-[#2563EB] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Workflow className="w-3.5 h-3.5" />
            Automation Engine
          </button>
        </div>
      </div>

      {mode === 'assistant' && (
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl overflow-hidden flex flex-col">
          {/* Controls bar */}
          <div className="p-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedModel}
                onChange={(e) =>
                  setSelectedModel(
                    e.target.value as
                      | 'gemini-3.8-flash'
                      | 'gemini-3.1-flash-lite'
                      | 'gpt-oss-20b-free'
                      | NativeIOSTextModelId
                  )
                }
                className="min-h-[40px] bg-[#090B10] border border-white/[0.1] rounded-lg px-3 text-xs text-slate-200 focus:outline-none focus:border-[#2563EB]"
              >
                <option value="gemini-3.8-flash">Gemini 3.8 Flash (Free-Tier, API-Key erforderlich)</option>
                <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (Schnell · 0 €)</option>
                <option value="gemini-3.7-flash">Gemini 3.7 Flash (Free-Tier)</option>
                <option value="gemini-3.6-flash">Gemini 3.6 Flash (Free-Tier)</option>
                <option value="gemini-3.5-flash">Gemini 3.5 Flash (Free-Tier)</option>
                <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite (Free-Tier · Schnell)</option>
                <option value="gpt-oss-20b-free">
                  GPT-OSS 20B (Open Cloud · kein API-Key · 0 €)
                </option>
                <option value="llama-3.2-1b-coreml">
                  Llama 3.2 1B (Apple CoreML · iPhone Lokal · 0 €)
                </option>
                <option value="llama-3.2-3b-coreml">
                  Llama 3.2 3B (Apple CoreML · iPhone Lokal · 0 €)
                </option>
                <option value="qwen-2.5-3b-coreml">
                  Qwen 2.5 3B (Apple MLX · iPhone Lokal · 0 €)
                </option>
                <option value="deepseek-r1-distill-1.5b">
                  DeepSeek-R1 1.5B (Apple MLX · iPhone Lokal · 0 €)
                </option>
                <option value="gemma-3-4b-it">
                  Gemma 3 4B IT (MediaPipe · iPhone Lokal · 0 €)
                </option>
              </select>

              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="min-h-[40px] bg-[#090B10] border border-white/[0.1] rounded-lg px-3 text-xs text-slate-200 focus:outline-none focus:border-[#2563EB]"
              >
                <option value="">Kein Projektkontext</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Projekt: {p.title}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setUseWebSearch((v) => !v)}
                className={`min-h-[40px] px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  useWebSearch
                    ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                    : 'bg-[#090B10] border-white/[0.1] text-slate-400 hover:text-white'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                Websuche {useWebSearch ? 'Ein' : 'Aus'}
              </button>
            </div>

            <button
              type="button"
              onClick={handleClearChat}
              className="min-h-[40px] px-3 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-white/[0.05] inline-flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Verlauf leeren
            </button>
          </div>

          {/* Messages */}
          <div className="p-4 sm:p-6 space-y-4 max-h-[52vh] min-h-[320px] overflow-y-auto">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[92%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-[#2563EB] text-white'
                      : 'bg-[#161B26] border border-white/[0.08] text-slate-100'
                  }`}
                >
                  {m.content}
                  {m.routingSteps && m.routingSteps.length > 0 && (
                    <div className="mt-3 pt-2.5 border-t border-white/[0.08] text-[11px] text-slate-400 font-mono space-y-0.5">
                      {m.routingSteps.map((step, idx) => (
                        <div key={idx}>{step}</div>
                      ))}
                    </div>
                  )}
                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-2.5 pt-2 border-t border-white/[0.08] flex flex-wrap gap-3">
                      {m.sources.map((src, i) => (
                        <a
                          key={i}
                          href={src.uri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-sky-400 hover:underline inline-flex items-center gap-1"
                        >
                          {src.title}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {chatError && (
            <div className="mx-4 mb-3 px-3.5 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {chatError}
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={handleSendChat}
            className="p-4 border-t border-white/[0.08] flex items-center gap-2.5"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Aufgabe an ZERO BRAIN stellen (z.B. Szenenplan, Drehbuch, Code, Analyse)..."
              className="flex-1 min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-4 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#2563EB]"
            />
            <button
              type="submit"
              disabled={chatLoading || !input.trim()}
              className="min-h-[44px] px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span className="hidden sm:inline">Senden</span>
            </button>
          </form>
        </div>
      )}

      {mode === 'web' && (
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-white">ZERO WEB INTELLIGENCE</h2>
            <p className="text-xs text-slate-400 mt-1">
              Echte Websuche über Gemini 2.5 Flash-Lite Free Tier mit belegten Quellenlinks; ZERO begrenzt Suchläufe zusätzlich auf 100 pro Tag.
            </p>
          </div>

          <form onSubmit={handleResearch} className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              placeholder="Recherchethema eingeben (z.B. Apple MLX Swift iOS 18 Performance oder Open-Source TTS Lizenzen)..."
              className="flex-1 min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-4 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#2563EB]"
            />
            <button
              type="submit"
              disabled={researchLoading || !researchQuery.trim()}
              className="min-h-[44px] px-5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              {researchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
              Recherchieren
            </button>
          </form>

          {researchError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {researchError}
            </div>
          )}

          {researchResult ? (
            <div className="space-y-4 pt-2 border-t border-white/[0.08]">
              <div className="text-xs text-slate-400 font-mono">
                {researchResult.modelUsed} · Kosten: 0,00 € · {researchResult.sources.length} Quellen
              </div>
              <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                {researchResult.report}
              </div>
              {researchResult.sources.length > 0 && (
                <div className="pt-3 border-t border-white/[0.08] space-y-2">
                  <h3 className="text-xs font-semibold text-slate-300">Verifizierte Quellenangaben</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {researchResult.sources.map((s, idx) => (
                      <a
                        key={idx}
                        href={s.uri}
                        target="_blank"
                        rel="noreferrer"
                        className="p-3 rounded-xl bg-[#090B10] border border-white/[0.08] hover:border-sky-500/40 text-xs text-sky-400 flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{s.title}</span>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-slate-500">
              Starte eine Recherche, um geprüfte Fakten und Quellenberichte zu generieren.
            </div>
          )}
        </div>
      )}

      {mode === 'automation' && (
        <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-white">ZERO AUTOMATION ENGINE</h2>
            <p className="text-xs text-slate-400 mt-1">
              Zerlegt komplexe Produktionsziele selbstständig in 0 € Arbeitsschritte. Kritische externe Aktionen erfordern ausdrückliche Bestätigung.
            </p>
          </div>

          <form onSubmit={handleStartAutomation} className="space-y-3">
            <textarea
              rows={2}
              value={autoGoal}
              onChange={(e) => setAutoGoal(e.target.value)}
              className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#2563EB]"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer min-h-[40px]">
                <input
                  type="checkbox"
                  checked={includeGate}
                  onChange={(e) => setIncludeGate(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B10]"
                />
                Externe Freigabe-Schranke (Safety Gate) einschließen
              </label>

              <button
                type="submit"
                disabled={autoLoading || !autoGoal.trim()}
                className="min-h-[44px] px-5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {autoLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Workflow ausführen
              </button>
            </div>
          </form>

          {autoError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {autoError}
            </div>
          )}

          <div className="space-y-4">
            {runs.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                Noch kein Automatisierungslauf gestartet.
              </p>
            ) : (
              runs.map((run) => (
                <div
                  key={run.id}
                  className="p-4 rounded-xl bg-[#090B10] border border-white/[0.08] space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white">{run.goal}</p>
                    <span className="text-xs font-mono text-sky-400">
                      {run.status === 'pausiert_bestätigung'
                        ? 'WARTET AUF FREIGABE'
                        : run.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {run.steps.map((st) => (
                      <div
                        key={st.id}
                        className="flex items-start justify-between gap-3 py-2 border-t border-white/[0.06] text-xs"
                      >
                        <div>
                          <p className="font-medium text-slate-200">
                            {st.title} <span className="text-slate-500">· {st.module}</span>
                          </p>
                          <p className="text-slate-400 mt-0.5">{st.outputSummary}</p>
                        </div>
                        {st.status === 'bestätigung_erforderlich' ? (
                          <button
                            onClick={() => handleConfirmGate(run.id)}
                            className="min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold inline-flex items-center gap-1.5 shrink-0"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            Freigabe erteilen
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-400 shrink-0 font-mono">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            OK
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

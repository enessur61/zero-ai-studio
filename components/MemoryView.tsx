import { useState } from 'react';
import { Database, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { getMemoryActionError } from '../lib/memoryActionError.ts';
import type { MemoryEntry, MemoryType } from '../types/zero.ts';

interface MemoryViewProps {
  memories: MemoryEntry[];
  onMemoryAdded: (entry: MemoryEntry) => void;
  onMemoryDeleted: (id: string) => void;
}

export function MemoryView({ memories, onMemoryAdded, onMemoryDeleted }: MemoryViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ memory: MemoryEntry; score: number }> | null>(
    null
  );
  const [semanticUsed, setSemanticUsed] = useState(false);
  const [embeddingNotice, setEmbeddingNotice] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<MemoryType>('knowledge');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setActionError(null);
    try {
      const data = await apiRequest<{
        results: Array<{ memory: MemoryEntry; score: number }>;
        semanticActive: boolean;
        embeddingNotice?: string;
      }>('/api/memory/search', {
        method: 'POST',
        body: JSON.stringify({ query: searchQuery }),
      });
      setSearchResults(data.results);
      setSemanticUsed(data.semanticActive);
      setEmbeddingNotice(data.embeddingNotice ?? null);
    } catch (error) {
      setActionError(getMemoryActionError(error, 'Memory-Suche fehlgeschlagen.'));
    } finally {
      setSearching(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      const data = await apiRequest<{ memory: MemoryEntry; embeddingNotice?: string }>('/api/memory', {
        method: 'POST',
        body: JSON.stringify({ title, content, type, tags }),
      });
      onMemoryAdded(data.memory);
      setEmbeddingNotice(data.embeddingNotice ?? null);
      setTitle('');
      setContent('');
      setTags('');
      setSearchResults(null);
    } catch (error) {
      setActionError(getMemoryActionError(error, 'Speichern der Erinnerung fehlgeschlagen.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setActionError(null);
    try {
      await apiRequest(`/api/memory/${id}`, { method: 'DELETE' });
      onMemoryDeleted(id);
      if (searchResults) {
        setSearchResults(searchResults.filter((r) => r.memory.id !== id));
      }
    } catch (error) {
      setActionError(getMemoryActionError(error, 'Löschen der Erinnerung fehlgeschlagen.'));
    }
  }

  const displayItems = searchResults
    ? searchResults
    : memories.map((m) => ({ memory: m, score: null as number | null }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">ZERO MEMORY</h1>
        <p className="text-xs text-slate-400 mt-1">
          Dauerhaftes Langzeitgedächtnis · Projekt- & Charakterwissen · Semantische Vektorsuche mit Gemini Embedding 2
        </p>
      </div>

      {actionError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleAdd}
          className="lg:col-span-4 bg-[#11151E] border border-white/[0.08] rounded-2xl p-5 space-y-3.5 h-fit"
        >
          <h2 className="text-base font-semibold text-white">Wissen / Erinnerung speichern</h2>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titel (z.B. Kamera-Preset Berlin)"
            className="w-full min-h-[44px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3.5 text-sm text-white"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as MemoryType)}
            className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
          >
            <option value="knowledge">Wissensdatenbank</option>
            <option value="project">Projektgedächtnis</option>
            <option value="character">Charakterwissen</option>
            <option value="preference">Benutzerpräferenz</option>
            <option value="production">Produktionshistorie</option>
          </select>
          <textarea
            rows={3}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Inhalt dauerhaft ablegen..."
            className="w-full bg-[#090B10] border border-white/[0.1] rounded-xl p-3 text-sm text-white"
          />
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Schlagwörter (kommagetrennt)"
            className="w-full min-h-[42px] bg-[#090B10] border border-white/[0.1] rounded-xl px-3 text-xs text-white"
          />
          <button
            type="submit"
            disabled={saving || !title.trim() || !content.trim()}
            className="w-full min-h-[44px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Im Gedächtnis sichern
          </button>
        </form>

        <div className="lg:col-span-8 space-y-4">
          <form onSubmit={handleSearch} className="flex gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Semantische Suche in allen Erinnerungen..."
                className="w-full min-h-[44px] bg-[#11151E] border border-white/[0.1] rounded-xl pl-10 pr-4 text-sm text-white"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="min-h-[44px] px-4 rounded-xl bg-[#2563EB] text-white text-sm font-medium inline-flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
              Suchen
            </button>
          </form>

          {searchResults && (
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>
                {searchResults.length} Treffer ·{' '}
                {semanticUsed ? 'Vektorsuche (gemini-embedding-2) aktiv' : 'Lokale Suche'}
              </span>
              <button
                onClick={() => {
                  setSearchResults(null);
                  setSearchQuery('');
                }}
                className="text-sky-400 hover:underline"
              >
                Zurücksetzen
              </button>
            </div>
          )}

          {embeddingNotice && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {embeddingNotice}
            </div>
          )}

          <div className="space-y-3">
            {displayItems.map(({ memory, score }) => (
              <div
                key={memory.id}
                className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 flex items-start justify-between gap-4"
              >
                <div className="space-y-1">
                  <p className="text-xs text-slate-400">
                    {memory.type.toUpperCase()}
                    {memory.tags.length > 0 && ` · ${memory.tags.join(', ')}`}
                    {score !== null && ` · Relevanz ${Math.round(score * 100)}%`}
                  </p>
                  <h3 className="text-sm font-semibold text-white">{memory.title}</h3>
                  <p className="text-xs text-slate-300 leading-relaxed">{memory.content}</p>
                </div>
                <button
                  onClick={() => handleDelete(memory.id)}
                  aria-label="Eintrag löschen"
                  className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-500 hover:text-rose-400 hover:bg-white/[0.05] shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Copy, Shuffle, MessageSquare, Sparkles, Loader2 } from 'lucide-react';
import { hydrateCommentsFromServer, saveCommentsToServer } from '../utils/appDataApi';
import { backendFetch } from '../services/backendOrigin';

interface CommentTemplate {
  id: string;
  text: string;
  category: string;
  usedCount: number;
}

export default function CommentTemplatesPage() {
  const [templates, setTemplates] = useState<CommentTemplate[]>(() => {
    try { const d = localStorage.getItem('mmb_comments'); return d ? JSON.parse(d) : []; } catch { return []; }
  });
  const [newComment, setNewComment] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [filterCategory, setFilterCategory] = useState('all');
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');
  // ── AI Generate ─────────────────────────────────────────────
  const [aiMode, setAiMode] = useState(false);
  const [aiCount, setAiCount] = useState(10);
  const [aiTopic, setAiTopic] = useState('');
  const [aiChannel, setAiChannel] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── Smart Comments (AI) on/off — controls aiCommentQualityEnabled setting ──
  const [smartComments, setSmartComments] = useState(true);

  useEffect(() => {
    void backendFetch('/api/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.settings) {
          const v = d.settings.aiCommentQualityEnabled;
          setSmartComments(v === undefined ? true : (v === true || v === 'true'));
        }
      })
      .catch(() => {});
  }, []);

  const toggleSmartComments = async (on: boolean) => {
    setSmartComments(on);
    try {
      await backendFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiCommentQualityEnabled: on }),
      });
    } catch { /* ignore — local state already set */ }
  };

  useEffect(() => {
    void hydrateCommentsFromServer().then(() => {
      try {
        const d = localStorage.getItem('mmb_comments');
        if (d) setTemplates(JSON.parse(d));
      } catch { /* ignore */ }
    });
  }, []);

  // Persist locally + server
  useEffect(() => {
    try { localStorage.setItem('mmb_comments', JSON.stringify(templates)); } catch {}
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      void saveCommentsToServer(templates);
    }, 800);
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [templates]);

  const categories = ['general', 'positive', 'question', 'engagement', 'custom'];
  const allCategories = ['all', ...categories];

  const addTemplate = () => {
    if (!newComment.trim()) return;
    setTemplates(prev => [...prev, { id: Date.now().toString(), text: newComment.trim(), category: newCategory, usedCount: 0 }]);
    setNewComment('');
  };

  const addBulk = () => {
    if (!bulkText.trim()) return;
    const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    const newTemplates = lines.map(text => ({ id: crypto.randomUUID(), text, category: newCategory, usedCount: 0 }));
    setTemplates(prev => [...prev, ...newTemplates]);
    setBulkText('');
    setBulkMode(false);
  };

  const generateAI = async () => {
    if (aiBusy) return;
    const count = Math.max(1, Math.min(50, aiCount));
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await backendFetch('/api/comments/ai-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count,
          topic: aiTopic.trim() || 'general YouTube video',
          channel: aiChannel.trim(),
          category: newCategory,
        }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok || !data.success) {
        const errMsg = (data.error as string) || 'AI generation failed';
        setAiError(errMsg);
        return;
      }
      const newTemplates = (data.templates as CommentTemplate[]) || [];
      if (newTemplates.length === 0) {
        setAiError('AI returned no usable comments — try again or change topic');
        return;
      }
      setTemplates(prev => [...prev, ...newTemplates]);
      setAiTopic('');
      setAiChannel('');
      setAiMode(false);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Network error — backend reachable?');
    } finally {
      setAiBusy(false);
    }
  };

  const deleteTemplate = (id: string) => setTemplates(prev => prev.filter(t => t.id !== id));

  const getRandomComment = () => {
    const filtered = filterCategory === 'all' ? templates : templates.filter(t => t.category === filterCategory);
    if (filtered.length === 0) return;
    const random = filtered[Math.floor(Math.random() * filtered.length)];
    navigator.clipboard.writeText(random.text).catch(() => {});
    setTemplates(prev => prev.map(t => t.id === random.id ? { ...t, usedCount: t.usedCount + 1 } : t));
  };

  const filtered = filterCategory === 'all' ? templates : templates.filter(t => t.category === filterCategory);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Comment Templates</h1>
            <p className="text-gray-500 text-sm mt-0.5">{templates.length} templates • Random pick for engagement</p>
          </div>
          <div className="flex gap-2">
            <button onClick={getRandomComment}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-600/20 border border-green-600/30 text-green-400 hover:bg-green-600/30 transition-all text-sm font-medium">
              <Shuffle size={15} /> Random Pick
            </button>
            <button onClick={() => { setAiMode(v => !v); setBulkMode(false); }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600/20 border border-purple-600/30 text-purple-400 hover:bg-purple-600/30 transition-all text-sm font-medium">
              <Sparkles size={15} /> AI Generate
            </button>
            <button onClick={() => { setBulkMode(v => !v); setAiMode(false); }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600/20 border border-blue-600/30 text-blue-400 hover:bg-blue-600/30 transition-all text-sm font-medium">
              <Plus size={15} /> Bulk Add
            </button>
          </div>
        </div>

        {/* Category Filter */}
        <div className="flex gap-2">
          {allCategories.map(c => (
            <button key={c} onClick={() => setFilterCategory(c)}
              className={`px-3 py-1 rounded-lg text-xs font-medium capitalize transition-all ${filterCategory === c ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {c} {c !== 'all' && `(${templates.filter(t => t.category === c).length})`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Smart Comments (AI) on/off */}
        <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3"
          style={{ background: 'var(--mmb-grad-soft)', border: '1px solid var(--mmb-border)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles size={16} className="text-purple-400 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--mmb-text)' }}>Smart Comments (AI)</div>
              <div className="text-xs" style={{ color: 'var(--mmb-muted)' }}>
                {smartComments
                  ? 'ON: video title + description + top-comments padh ke human-jaisa relevant comment'
                  : 'OFF: sirf ye templates use honge (no AI credit)'}
              </div>
            </div>
          </div>
          <label className="mmb-toggle flex-shrink-0">
            <input type="checkbox" checked={smartComments} onChange={(e) => void toggleSmartComments(e.target.checked)} />
            <span className="mmb-toggle-slider" />
          </label>
        </div>

        {/* Add Single */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex gap-2">
            <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none">
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="text" value={newComment} onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTemplate()}
              placeholder="Type a comment template..."
              className="flex-1 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:border-red-500" />
            <button onClick={addTemplate} disabled={!newComment.trim()}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all">Add</button>
          </div>
        </div>

        {/* AI Generate */}
        {aiMode && (
          <div className="bg-gray-900 border border-purple-800/40 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={14} className="text-purple-400" />
              <p className="text-xs text-purple-400 font-medium">AI Generate Comments (Claude)</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide block mb-1">How many?</label>
                <input
                  type="number" min={1} max={50} value={aiCount}
                  onChange={(e) => setAiCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide block mb-1">Video topic</label>
                <input
                  type="text" value={aiTopic} placeholder="e.g. credit card tips, gaming, finance"
                  onChange={(e) => setAiTopic(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:border-purple-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide block mb-1">Channel (optional)</label>
                <input
                  type="text" value={aiChannel} placeholder="Channel name"
                  onChange={(e) => setAiChannel(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => void generateAI()}
                disabled={aiBusy}
                className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-all"
              >
                {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {aiBusy ? 'Generating…' : `Generate ${aiCount} comments`}
              </button>
              <span className="text-[10px] text-gray-500">
                Saves to category: <span className="text-purple-300">{newCategory}</span> · Powered by Claude
              </span>
            </div>
            {aiError && (
              <p className="text-xs text-red-400 mt-2 flex items-center gap-1.5">⚠ {aiError}</p>
            )}
          </div>
        )}

        {/* Bulk Add */}
        {bulkMode && (
          <div className="bg-gray-900 border border-blue-800/40 rounded-xl p-4">
            <p className="text-xs text-blue-400 mb-2">One comment per line:</p>
            <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)}
              rows={5} placeholder="Great video!&#10;Very informative, thanks!&#10;Loved this content 🔥&#10;Keep it up!"
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none resize-none" />
            <button onClick={addBulk} className="mt-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all">Add All ({bulkText.split('\n').filter(l => l.trim()).length})</button>
          </div>
        )}

        {/* Templates List */}
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-600">
            <MessageSquare size={40} className="mx-auto mb-3 opacity-30" />
            <p>No comment templates yet. Add some above!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(t => (
              <div key={t.id} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 hover:border-gray-700 transition-all">
                <MessageSquare size={14} className="text-gray-600 flex-shrink-0" />
                <span className="flex-1 text-sm text-gray-200">{t.text}</span>
                <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded capitalize">{t.category}</span>
                <span className="text-xs text-gray-600">Used: {t.usedCount}</span>
                <button onClick={() => { navigator.clipboard.writeText(t.text).catch(() => {}); }}
                  className="text-gray-500 hover:text-blue-400 transition-all"><Copy size={13} /></button>
                <button onClick={() => deleteTemplate(t.id)}
                  className="text-gray-500 hover:text-red-400 transition-all"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

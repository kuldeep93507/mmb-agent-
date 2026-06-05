import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Copy, Shuffle, MessageSquare } from 'lucide-react';
import { hydrateCommentsFromServer, saveCommentsToServer } from '../utils/appDataApi';

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
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            <button onClick={() => setBulkMode(!bulkMode)}
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

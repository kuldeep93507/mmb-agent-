/** MMB Agent V2 Dashboard — shared JS utilities */

function showToast(message, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;
  const colors = type === 'error' ? 'bg-red-600' : 'bg-emerald-600';
  const div = document.createElement('div');
  div.className = `toast-enter ${colors} text-white px-4 py-2 rounded-lg mb-2 text-sm shadow-lg`;
  div.textContent = message;
  el.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function saveDraft(key, data) {
  try { localStorage.setItem(`mmb_draft_${key}`, JSON.stringify(data)); } catch (_) {}
}

function loadDraft(key) {
  try {
    const raw = localStorage.getItem(`mmb_draft_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    const s = document.getElementById('sidebar-search');
    if (s) s.focus();
  }
  if (e.ctrlKey && e.key === '/') {
    e.preventDefault();
    showToast('Shortcuts: Ctrl+K search | Ctrl+/ help | Emergency Stop in header', 'success');
  }
});

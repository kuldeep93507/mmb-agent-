import { MessageSquare } from 'lucide-react';

interface Template {
  id: string;
  text: string;
  category?: string;
}

function loadTemplates(): Template[] {
  try {
    const d = localStorage.getItem('mmb_comments');
    const parsed = d ? JSON.parse(d) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  readOnly?: boolean;
}

export default function CommentTemplatePicker({ value, onChange, readOnly }: Props) {
  const templates = loadTemplates();
  const selected = templates.find(t => t.id === value);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-3">
      <p className="text-[10px] uppercase text-gray-500 font-semibold flex items-center gap-1 mb-2">
        <MessageSquare size={12} /> Campaign comment template
      </p>
      <select disabled={readOnly} value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white">
        <option value="">— Koi template nahi —</option>
        {templates.map(t => (
          <option key={t.id} value={t.id}>
            [{t.category || 'general'}] {t.text.slice(0, 60)}{t.text.length > 60 ? '…' : ''}
          </option>
        ))}
      </select>
      {selected && (
        <p className="text-[10px] text-gray-500 mt-2 truncate" title={selected.text}>
          Preview: {selected.text}
        </p>
      )}
      {!templates.length && (
        <p className="text-[10px] text-amber-600/80 mt-1">Comment Templates page se pehle templates banao</p>
      )}
    </div>
  );
}

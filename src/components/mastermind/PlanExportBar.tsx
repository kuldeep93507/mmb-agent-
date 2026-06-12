import { useRef, useState } from 'react';
import { Download, Upload, Save, Cloud, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import type { DemoCampaignPlan } from '../../utils/mastermindDemoPlan';
import { downloadPlanCsv, downloadPlanJson, parseImportedPlanJson } from '../../utils/mastermindExport';
import { saveMastermindPlan } from '../../utils/mastermindApi';

interface Props {
  plan: DemoCampaignPlan;
  onImportPlan: (plan: DemoCampaignPlan) => void;
  serverSavedAt?: string | null;
}

export default function PlanExportBar({ plan, onImportPlan, serverSavedAt }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  const handleSaveServer = async () => {
    setSaving(true);
    setSaveMsg(null);
    const { ok, planId } = await saveMastermindPlan(plan, `Plan ${plan.dayKey} · ${plan.totalSlots} slots`);
    setSaving(false);
    setSaveMsg(ok ? `Server pe save ✓ (${planId?.slice(0, 8)}…)` : 'Server save fail — backend chalu hai?');
  };

  const handleImport = (file: File) => {
    setImportErr(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parseImportedPlanJson(String(reader.result));
        onImportPlan(imported);
      } catch (e) {
        setImportErr(e instanceof Error ? e.message : 'Invalid JSON');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="bg-gray-900/70 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-white mr-auto">Plan export / import</p>
        {serverSavedAt && (
          <span className="text-[10px] text-emerald-500 flex items-center gap-1">
            <Cloud size={12} /> Server: {new Date(serverSavedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => downloadPlanCsv(plan)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-900/40 border border-emerald-700/50 text-emerald-100 text-sm font-semibold hover:bg-emerald-900/60">
          <Download size={16} /> CSV (Excel)
        </button>
        <button type="button" onClick={() => downloadPlanJson(plan)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-900/40 border border-blue-700/50 text-blue-100 text-sm font-semibold hover:bg-blue-900/60">
          <Download size={16} /> JSON
        </button>
        <button type="button" onClick={() => fileRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-gray-800 border border-gray-600 text-gray-200 text-sm font-semibold hover:bg-gray-750">
          <Upload size={16} /> JSON import
        </button>
        <button type="button" onClick={handleSaveServer} disabled={saving}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-900/40 border border-amber-700/50 text-amber-100 text-sm font-bold hover:bg-amber-900/60 disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Server pe save
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ''; }} />
      </div>

      {saveMsg && (
        <p className={`text-xs flex items-center gap-1 ${saveMsg.includes('✓') ? 'text-emerald-400' : 'text-red-400'}`}>
          {saveMsg.includes('✓') ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {saveMsg}
        </p>
      )}
      {importErr && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle size={14} /> {importErr}
        </p>
      )}
      <p className="text-[10px] text-gray-600">
        CSV = Excel me kholo · JSON = dubara import ya team ko bhejo · Server save = backend file (run abhi bhi manual)
      </p>
    </div>
  );
}

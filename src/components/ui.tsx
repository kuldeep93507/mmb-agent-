/**
 * MMB Design System — shared UI primitives
 * All components use CSS variables (light + dark aware)
 */
import type { CSSProperties, ReactNode, ButtonHTMLAttributes } from 'react';

/* ── Page shell ──────────────────────────────────────────────────────────── */
export function PageShell({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      flex: 1, overflowY: 'auto', background: 'var(--mmb-bg)',
      padding: '20px 24px', ...style,
    }}>
      {children}
    </div>
  );
}

/* ── Page header ─────────────────────────────────────────────────────────── */
export function PageHeader({
  title, subtitle, actions,
}: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
      <div>
        <h1 style={{ fontSize:20, fontWeight:800, color:'var(--mmb-text)', margin:0, lineHeight:1.2 }}>{title}</h1>
        {subtitle && <p style={{ fontSize:12, color:'var(--mmb-muted)', marginTop:4, marginBottom:0 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>{actions}</div>}
    </div>
  );
}

/* ── Card ────────────────────────────────────────────────────────────────── */
export function Card({ children, style, padding }: { children: ReactNode; style?: CSSProperties; padding?: number | string }) {
  return (
    <div style={{
      background: 'var(--mmb-surface)',
      border: '1px solid var(--mmb-border)',
      borderRadius: 12,
      boxShadow: 'var(--mmb-shadow)',
      padding: padding ?? 0,
      ...style,
    }}>
      {children}
    </div>
  );
}

/* ── Card header ─────────────────────────────────────────────────────────── */
export function CardHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'14px 16px', borderBottom:'1px solid var(--mmb-border)',
    }}>
      <span style={{ fontSize:13, fontWeight:700, color:'var(--mmb-text)' }}>{title}</span>
      {action && <div style={{ display:'flex', gap:8, alignItems:'center' }}>{action}</div>}
    </div>
  );
}

/* ── Stat bar ─────────────────────────────────────────────────────────────── */
export function StatBar({ items }: { items: { label: string; value: string | number; color?: string }[] }) {
  return (
    <div style={{
      display:'flex', flexWrap:'wrap', gap:'6px 20px',
      padding:'10px 16px',
      borderBottom:'1px solid var(--mmb-border)',
      fontSize:12, color:'var(--mmb-muted)',
    }}>
      {items.map(({ label, value, color }) => (
        <span key={label}>
          {label}{' '}
          <strong style={{ color: color || 'var(--mmb-accent)' }}>{value}</strong>
        </span>
      ))}
    </div>
  );
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'success'; size?: 'sm' | 'md'; icon?: ReactNode };

export function Btn({ children, variant = 'ghost', size = 'md', icon, style, ...rest }: BtnProps) {
  const pad = size === 'sm' ? '5px 10px' : '7px 14px';
  const fontSize = size === 'sm' ? 11 : 12;

  const base: CSSProperties = {
    display:'flex', alignItems:'center', gap:5,
    padding:pad, borderRadius:8, fontSize, fontWeight:600,
    cursor: rest.disabled ? 'not-allowed' : 'pointer',
    opacity: rest.disabled ? .6 : 1,
    transition:'all .15s', flexShrink:0, border:'none',
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background:'var(--mmb-accent)', color:'#fff' },
    ghost:   { background:'var(--mmb-surface)', color:'var(--mmb-text2)', border:'1px solid var(--mmb-border)' },
    danger:  { background:'var(--mmb-red-bg)', color:'var(--mmb-red)', border:'1px solid var(--mmb-red)' },
    success: { background:'var(--mmb-green-bg)', color:'var(--mmb-green)', border:'1px solid var(--mmb-green)' },
  };
  return (
    <button style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {icon}{children}
    </button>
  );
}

/* ── Badge ───────────────────────────────────────────────────────────────── */
export function Badge({ children, color = 'accent' }: { children: ReactNode; color?: 'accent' | 'green' | 'red' | 'yellow' | 'blue' | 'gray' }) {
  const map: Record<string, CSSProperties> = {
    accent: { background:'var(--mmb-accent-bg)', color:'var(--mmb-accent-text)' },
    green:  { background:'var(--mmb-green-bg)',  color:'var(--mmb-green)'  },
    red:    { background:'var(--mmb-red-bg)',    color:'var(--mmb-red)'    },
    yellow: { background:'var(--mmb-yellow-bg)', color:'var(--mmb-yellow)' },
    blue:   { background:'var(--mmb-blue-bg)',   color:'var(--mmb-blue)'   },
    gray:   { background:'var(--mmb-surface2)',  color:'var(--mmb-muted)'  },
  };
  return (
    <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:99, ...map[color] }}>
      {children}
    </span>
  );
}

/* ── Toggle ──────────────────────────────────────────────────────────────── */
export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="mmb-toggle" style={{ opacity: disabled ? .5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="mmb-toggle-slider" />
    </label>
  );
}

/* ── Input ───────────────────────────────────────────────────────────────── */
export function Input({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      {label && <label style={{ fontSize:11, fontWeight:600, color:'var(--mmb-muted)', textTransform:'uppercase', letterSpacing:'.04em' }}>{label}</label>}
      <input className="mmb-input" {...props} />
    </div>
  );
}

/* ── Select ──────────────────────────────────────────────────────────────── */
export function Select({ label, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      {label && <label style={{ fontSize:11, fontWeight:600, color:'var(--mmb-muted)', textTransform:'uppercase', letterSpacing:'.04em' }}>{label}</label>}
      <select className="mmb-input" {...props}>{children}</select>
    </div>
  );
}

/* ── Textarea ────────────────────────────────────────────────────────────── */
export function Textarea({ label, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      {label && <label style={{ fontSize:11, fontWeight:600, color:'var(--mmb-muted)', textTransform:'uppercase', letterSpacing:'.04em' }}>{label}</label>}
      <textarea className="mmb-input" style={{ resize:'vertical', minHeight:80 }} {...props}/>
    </div>
  );
}

/* ── Status dot ──────────────────────────────────────────────────────────── */
export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span style={{
      display:'inline-block', width:7, height:7, borderRadius:'50%',
      background:color, flexShrink:0,
      boxShadow: pulse ? `0 0 0 0 ${color}` : 'none',
    }}/>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────────── */
export function Empty({ icon, text }: { icon?: string; text: string }) {
  return (
    <div style={{ textAlign:'center', padding:'40px 20px', color:'var(--mmb-muted)' }}>
      {icon && <div style={{ fontSize:32, marginBottom:8 }}>{icon}</div>}
      <div style={{ fontSize:13 }}>{text}</div>
    </div>
  );
}

/* ── Section label ───────────────────────────────────────────────────────── */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize:10, fontWeight:700, letterSpacing:'.08em',
      color:'var(--mmb-muted)', textTransform:'uppercase',
      padding:'8px 0 4px',
    }}>
      {children}
    </div>
  );
}

/* ── Grid ────────────────────────────────────────────────────────────────── */
export function Grid({ cols = 2, gap = 16, children, style }: { cols?: number; gap?: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:`repeat(${cols},1fr)`, gap, ...style }}>
      {children}
    </div>
  );
}

/* ── SettingRow ──────────────────────────────────────────────────────────── */
export function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0', borderBottom:'1px solid var(--mmb-border)' }}>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:13, fontWeight:600, color:'var(--mmb-text)' }}>{label}</div>
        {description && <div style={{ fontSize:11, color:'var(--mmb-muted)', marginTop:2 }}>{description}</div>}
      </div>
      <div style={{ flexShrink:0, marginLeft:16 }}>{children}</div>
    </div>
  );
}

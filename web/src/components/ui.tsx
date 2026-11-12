import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' };

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-dark',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
  large,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  large?: boolean;
  disabled?: boolean;
}) {
  const track = large ? 'h-10 w-[4.5rem]' : 'h-7 w-12';
  const knob = large ? 'h-8 w-8' : 'h-5 w-5';
  const shift = large ? 'translate-x-8' : 'translate-x-5';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 rounded-full p-1 transition disabled:opacity-50 ${track} ${checked ? 'bg-accent' : 'bg-slate-300'}`}
    >
      <span className={`block rounded-full bg-white shadow transition ${knob} ${checked ? shift : ''}`} />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/20';

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success'; children: ReactNode }) {
  const styles = {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[kind];
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${styles}`}>
      {children}
    </p>
  );
}

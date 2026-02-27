import type { ReactNode } from 'react';

interface FormFieldProps {
  label: string;
  error?: string;
  description?: string;
  children: ReactNode;
}

export function FormField({ label, error, description, children }: FormFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
        {label}
      </label>
      {description && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {description}
        </p>
      )}
      {children}
      {error && (
        <p className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

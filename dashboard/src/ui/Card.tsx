import type { ReactNode } from 'react';

interface CardProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  noPadding?: boolean;
  footer?: ReactNode;
}

export function Card({ title, action, children, className = '', noPadding, footer }: CardProps) {
  return (
    <div
      className={`rounded-lg border transition-colors duration-100 ${className}`}
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {(title || action) && (
        <div
          className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          {title && (
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h3>
          )}
          {action && <div>{action}</div>}
        </div>
      )}
      <div className={noPadding ? '' : 'p-5'}>{children}</div>
      {footer && (
        <div
          className="px-5 py-3.5 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

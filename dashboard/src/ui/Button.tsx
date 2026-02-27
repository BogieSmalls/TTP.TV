import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonProps) {
  const sizeClass = size === 'sm' ? 'px-2.5 py-1 text-xs gap-1.5' : 'px-3.5 py-2 text-sm gap-2';

  const variantStyle: Record<string, React.CSSProperties> = {
    primary: {
      background: 'var(--accent)',
      color: '#fff',
    },
    secondary: {
      background: 'var(--bg-elevated)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-secondary)',
    },
    danger: {
      background: 'var(--danger)',
      color: '#fff',
    },
  };

  return (
    <button
      className={`inline-flex items-center justify-center rounded-md font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${sizeClass} ${className}`}
      style={variantStyle[variant]}
      disabled={disabled || loading}
      onMouseEnter={(e) => {
        if (disabled || loading) return;
        if (variant === 'primary') {
          e.currentTarget.style.boxShadow = 'var(--shadow-glow-accent)';
          e.currentTarget.style.background = 'var(--accent-hover)';
        } else if (variant === 'ghost') {
          e.currentTarget.style.background = 'var(--bg-elevated)';
        } else if (variant === 'danger') {
          e.currentTarget.style.boxShadow = 'var(--shadow-glow-danger)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.background = variantStyle[variant].background as string;
      }}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

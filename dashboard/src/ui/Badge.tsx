interface BadgeProps {
  variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  label: string;
  pulse?: boolean;
}

const variantStyles: Record<BadgeProps['variant'], { bg: string; text: string; dot: string }> = {
  success: {
    bg: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(52,211,153,0.05))',
    text: 'var(--success)',
    dot: 'var(--success)',
  },
  danger: {
    bg: 'linear-gradient(135deg, rgba(248,113,113,0.15), rgba(248,113,113,0.05))',
    text: 'var(--danger)',
    dot: 'var(--danger)',
  },
  warning: {
    bg: 'linear-gradient(135deg, rgba(251,191,36,0.15), rgba(251,191,36,0.05))',
    text: 'var(--warning)',
    dot: 'var(--warning)',
  },
  info: {
    bg: 'linear-gradient(135deg, rgba(96,165,250,0.15), rgba(96,165,250,0.05))',
    text: 'var(--info)',
    dot: 'var(--info)',
  },
  neutral: {
    bg: 'var(--bg-elevated)',
    text: 'var(--text-secondary)',
    dot: 'var(--text-muted)',
  },
};

export function Badge({ variant, label, pulse }: BadgeProps) {
  const s = variantStyles[variant];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
      style={{ background: s.bg, color: s.text }}
    >
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: s.dot }}
          />
          <span
            className="relative inline-flex rounded-full h-2 w-2"
            style={{ background: s.dot }}
          />
        </span>
      )}
      {label}
    </span>
  );
}

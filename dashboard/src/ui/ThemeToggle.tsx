import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

const options = [
  { value: 'light' as const, icon: Sun, label: 'Light' },
  { value: 'dark' as const, icon: Moon, label: 'Dark' },
  { value: 'system' as const, icon: Monitor, label: 'System' },
];

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  if (compact) {
    const current = options.find((o) => o.value === theme) ?? options[2];
    const Icon = current.icon;
    const next = options[(options.indexOf(current) + 1) % options.length];
    return (
      <button
        onClick={() => setTheme(next.value)}
        className="p-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--bg-elevated)]"
        style={{ color: 'var(--text-secondary)' }}
        title={`Theme: ${current.label}`}
      >
        <Icon size={16} />
      </button>
    );
  }

  return (
    <div
      className="inline-flex rounded-md border p-0.5"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors ${
            theme === value ? 'bg-[var(--bg-surface)] shadow-sm' : 'hover:opacity-80'
          }`}
          style={{
            color: theme === value ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
          title={label}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

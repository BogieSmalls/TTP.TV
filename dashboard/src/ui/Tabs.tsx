import type { ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
            active === tab.id ? 'border-[var(--accent)]' : 'border-transparent'
          }`}
          style={{
            color: active === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
          }}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

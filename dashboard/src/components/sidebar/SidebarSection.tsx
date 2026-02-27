import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface SidebarSectionProps {
  title: string;
  defaultOpen?: boolean;
  collapsed?: boolean;
  children: ReactNode;
}

export function SidebarSection({ title, defaultOpen = true, collapsed, children }: SidebarSectionProps) {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(`ttp-sidebar-${title}`);
    return stored !== null ? stored === 'true' : defaultOpen;
  });

  function toggle() {
    const next = !open;
    setOpen(next);
    localStorage.setItem(`ttp-sidebar-${title}`, String(next));
  }

  if (collapsed) {
    return <div className="py-1 space-y-0.5">{children}</div>;
  }

  return (
    <div className="mb-1">
      <button
        onClick={toggle}
        className="flex items-center justify-between w-full px-4 py-2 text-[10px] font-semibold uppercase tracking-widest cursor-pointer transition-colors hover:opacity-80"
        style={{ color: 'var(--text-muted)' }}
      >
        {title}
        <ChevronDown
          size={12}
          className={`transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
        />
      </button>
      <div
        className="space-y-0.5 overflow-hidden transition-all duration-150"
        style={{ maxHeight: open ? 300 : 0, opacity: open ? 1 : 0 }}
      >
        {children}
      </div>
    </div>
  );
}

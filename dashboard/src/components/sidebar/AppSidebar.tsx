import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Radio,
  Calendar,
  Layers,
  Users,
  Scissors,
  MessageSquare,
  GraduationCap,
  BookOpen,
  Eye,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { SidebarSection } from './SidebarSection';
import { SidebarLink } from './SidebarLink';
import { ThemeToggle } from '../../ui/ThemeToggle';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

export default function AppSidebar() {
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const [pinned, setPinned] = useState(() => {
    const stored = localStorage.getItem('ttp-sidebar-pinned');
    return stored !== null ? stored === 'true' : true;
  });
  const [hovered, setHovered] = useState(false);

  const collapsed = isNarrow ? !hovered && !pinned : !pinned;
  const expanded = !collapsed;

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    localStorage.setItem('ttp-sidebar-pinned', String(next));
  }

  return (
    <nav
      className="shrink-0 flex flex-col border-r relative"
      style={{
        width: expanded ? 224 : 52,
        transition: 'width 150ms ease',
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        zIndex: collapsed ? 20 : undefined,
      }}
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Logo */}
      <div className="px-3 py-4 border-b flex items-center gap-2 min-h-[60px]" style={{ borderColor: 'var(--border)' }}>
        {expanded ? (
          <div className="overflow-hidden">
            <span
              className="font-zelda text-xl tracking-wide whitespace-nowrap"
              style={{
                color: 'var(--text-primary)',
                textShadow: '0 2px 4px rgba(0,0,0,0.4)',
              }}
            >
              TTP.TV
            </span>
            <p className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
              TriforceTriplePlay
            </p>
          </div>
        ) : (
          <span
            className="font-zelda text-sm"
            style={{
              color: 'var(--text-primary)',
              textShadow: '0 2px 4px rgba(0,0,0,0.4)',
            }}
          >
            TTP
          </span>
        )}
      </div>

      {/* Navigation */}
      <div className="flex-1 py-2 overflow-y-auto overflow-x-hidden">
        <SidebarSection title="Produce" collapsed={collapsed}>
          <SidebarLink to="/dashboard" icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} />
          <SidebarLink to="/broadcast" icon={Radio} label="Broadcast" collapsed={collapsed} />
          <SidebarLink to="/schedule" icon={Calendar} label="Schedule" collapsed={collapsed} />
        </SidebarSection>

        <SidebarSection title="Configure" collapsed={collapsed}>
          <SidebarLink to="/scene-builder" icon={Layers} label="Scene Builder" collapsed={collapsed} />
          <SidebarLink to="/racers" icon={Users} label="Racers" collapsed={collapsed} />
          <SidebarLink to="/crops" icon={Scissors} label="Crops" collapsed={collapsed} />
          <SidebarLink to="/commentary" icon={MessageSquare} label="Commentary" collapsed={collapsed} />
        </SidebarSection>

        <SidebarSection title="Train" collapsed={collapsed}>
          <SidebarLink to="/learn" icon={GraduationCap} label="Learn Mode" collapsed={collapsed} />
          <SidebarLink to="/knowledge" icon={BookOpen} label="Knowledge Base" collapsed={collapsed} />
          <SidebarLink to="/vision" icon={Eye} label="Vision Lab" collapsed={collapsed} />
        </SidebarSection>

        <SidebarSection title="System" collapsed={collapsed}>
          <SidebarLink to="/settings" icon={Settings} label="Settings" collapsed={collapsed} />
        </SidebarSection>
      </div>

      {/* Footer */}
      <div
        className="px-3 py-3 border-t flex items-center"
        style={{ borderColor: 'var(--border)', justifyContent: expanded ? 'space-between' : 'center' }}
      >
        {expanded ? (
          <>
            <ThemeToggle compact />
            <div className="flex items-center gap-2">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>v0.9</span>
              <button onClick={togglePin} className="p-1 rounded cursor-pointer transition-colors"
                style={{ color: 'var(--text-muted)' }} title={pinned ? 'Collapse sidebar' : 'Pin sidebar'}>
                <PanelLeftClose size={14} />
              </button>
            </div>
          </>
        ) : (
          <button onClick={togglePin} className="p-1 rounded cursor-pointer transition-colors"
            style={{ color: 'var(--text-muted)' }} title="Expand sidebar">
            <PanelLeftOpen size={16} />
          </button>
        )}
      </div>
    </nav>
  );
}

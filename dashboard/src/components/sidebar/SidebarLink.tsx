import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';

interface SidebarLinkProps {
  to: string;
  icon: LucideIcon;
  label: string;
  collapsed?: boolean;
}

export function SidebarLink({ to, icon: Icon, label, collapsed }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `flex items-center transition-all duration-100 rounded-md ${
          collapsed
            ? 'justify-center mx-1 p-2'
            : `gap-3 px-4 py-2 mx-2 text-sm border-l-2 ${isActive ? '' : 'border-transparent'}`
        }`
      }
      style={({ isActive }) => ({
        color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
        background: isActive ? 'var(--accent-subtle)' : undefined,
        borderLeftColor: !collapsed && isActive ? 'var(--accent)' : 'transparent',
        boxShadow: !collapsed && isActive ? 'inset 3px 0 12px -4px rgba(99,102,241,0.2)' : undefined,
      })}
      onMouseEnter={(e) => {
        if (e.currentTarget.getAttribute('aria-current') !== 'page') {
          e.currentTarget.style.background = 'var(--bg-elevated)';
        }
      }}
      onMouseLeave={(e) => {
        const isActive = e.currentTarget.getAttribute('aria-current') === 'page';
        e.currentTarget.style.background = isActive ? 'var(--accent-subtle)' : '';
      }}
    >
      <Icon size={collapsed ? 20 : 18} />
      {!collapsed && <span className="whitespace-nowrap overflow-hidden">{label}</span>}
    </NavLink>
  );
}

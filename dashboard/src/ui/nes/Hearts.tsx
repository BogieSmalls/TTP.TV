interface HeartsProps {
  current: number;
  max: number;
}

export function Hearts({ current, max }: HeartsProps) {
  return (
    <span className="inline-flex gap-0.5 font-pixel text-[10px] leading-none">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          style={{ color: i < current ? 'var(--danger)' : 'var(--text-muted)', opacity: i < current ? 1 : 0.3 }}
        >
          ♥
        </span>
      ))}
    </span>
  );
}

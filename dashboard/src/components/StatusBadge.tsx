interface Props {
  connected: boolean;
  label?: string;
}

export default function StatusBadge({ connected, label }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
        connected
          ? 'bg-success/15 text-success'
          : 'bg-danger/15 text-danger'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected ? 'bg-success animate-pulse' : 'bg-danger'
        }`}
      />
      {label ?? (connected ? 'Connected' : 'Disconnected')}
    </span>
  );
}

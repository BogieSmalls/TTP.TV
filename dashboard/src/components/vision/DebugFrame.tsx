import { useEffect, useRef, useState } from 'react';
import { useSocketEvent } from '../../hooks/useSocket.js';

interface Props {
  racerId: string | null;
}

export function DebugFrame({ racerId }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const prevSrcRef = useRef<string | null>(null);

  useSocketEvent<{ racerId: string; jpeg: string }>('vision:webgpu:frame', (data) => {
    if (data.racerId !== racerId) return;
    // Revoke previous object URL to avoid memory leak
    if (prevSrcRef.current) URL.revokeObjectURL(prevSrcRef.current);
    const bytes = Uint8Array.from(atob(data.jpeg), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    prevSrcRef.current = url;
    setSrc(url);
  });

  useEffect(() => {
    return () => {
      if (prevSrcRef.current) URL.revokeObjectURL(prevSrcRef.current);
    };
  }, []);

  if (!racerId) {
    return <div className="flex items-center justify-center h-full text-gray-500 text-sm">No racer selected</div>;
  }
  if (!src) {
    return <div className="flex items-center justify-center h-full text-gray-500 text-sm">Waiting for frames…</div>;
  }
  return <img src={src} alt="debug frame" className="w-full h-full object-contain" />;
}

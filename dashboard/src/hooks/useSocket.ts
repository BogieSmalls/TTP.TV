import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import type { Socket } from 'socket.io-client';

export function useSocket(): Socket {
  const socketRef = useRef(getSocket());
  return socketRef.current;
}

export function useSocketEvent<T = unknown>(event: string, handler: (data: T) => void) {
  const socket = useSocket();

  useEffect(() => {
    socket.on(event, handler);
    return () => { socket.off(event, handler); };
  }, [socket, event, handler]);
}

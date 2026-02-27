import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket!.emit('join', 'dashboard');
      socket!.emit('join', 'vision');
      socket!.emit('join', 'learn');
      socket!.emit('join', 'commentary');
    });
  }
  return socket;
}

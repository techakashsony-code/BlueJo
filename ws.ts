import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { dbStore } from './db.js';

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

const JWT_SECRET = process.env.JWT_SECRET || 'bluejo_jwt_secret_super_secure_key_2026';
const LEGACY_JWT_SECRET = 'bharatgram_jwt_secret_super_secure_key_2026';

function decodeSocketToken(token: string): { id: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { id: string };
  } catch {
    try {
      return jwt.verify(token, LEGACY_JWT_SECRET) as { id: string };
    } catch {
      return null;
    }
  }
}

class RealtimeServer {
  private wss: WebSocketServer | null = null;
  private userSockets: Map<string, Set<AuthenticatedSocket>> = new Map();

  public init(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: AuthenticatedSocket, req) => {
      ws.isAlive = true;

      // Extract token from URL query: /ws?token=...
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const token = url.searchParams.get('token');

      if (token) {
        const decoded = decodeSocketToken(token);
        if (decoded) {
          ws.userId = decoded.id;

          if (!this.userSockets.has(decoded.id)) {
            this.userSockets.set(decoded.id, new Set());
          }
          this.userSockets.get(decoded.id)!.add(ws);

          // Broadcast online status to others
          this.broadcastUserPresence(decoded.id, true);
        }
      }

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (messageRaw) => {
        try {
          const data = JSON.parse(messageRaw.toString());
          this.handleClientMessage(ws, data);
        } catch (err) {
          console.error('[WS] Error processing message:', err);
        }
      });

      ws.on('close', () => {
        if (ws.userId && this.userSockets.has(ws.userId)) {
          const sockets = this.userSockets.get(ws.userId)!;
          sockets.delete(ws);
          if (sockets.size === 0) {
            this.userSockets.delete(ws.userId);
            this.broadcastUserPresence(ws.userId, false);
          }
        }
      });
    });

    // Keepalive ping every 30s
    const interval = setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach((client) => {
        const socket = client as AuthenticatedSocket;
        if (socket.isAlive === false) return socket.terminate();
        socket.isAlive = false;
        socket.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(interval);
    });

    console.log('[WS] Realtime WebSocket server mounted on /ws');
  }

  private handleClientMessage(ws: AuthenticatedSocket, data: any) {
    if (!ws.userId) return;

    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      return;
    }

    if (data.type === 'typing') {
      const { receiverId, isTyping } = data;
      if (receiverId) {
        this.sendToUser(receiverId, {
          type: 'user_typing',
          senderId: ws.userId,
          isTyping
        });
      }
    }
  }

  public isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId) && (this.userSockets.get(userId)?.size ?? 0) > 0;
  }

  public getOnlineUserIds(): string[] {
    return Array.from(this.userSockets.keys());
  }

  public sendToUser(userId: string, payload: any) {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    const msg = JSON.stringify(payload);
    sockets.forEach((s) => {
      if (s.readyState === WebSocket.OPEN) {
        s.send(msg);
      }
    });
  }

  public broadcast(payload: any) {
    if (!this.wss) return;
    const msg = JSON.stringify(payload);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  private broadcastUserPresence(userId: string, isOnline: boolean) {
    this.broadcast({
      type: 'presence_change',
      userId,
      isOnline
    });
  }
}

export const realtimeServer = new RealtimeServer();

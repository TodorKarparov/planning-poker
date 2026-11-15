import { DurableObject } from 'cloudflare:workers';
import { apply, snapshot, createRoom, displayName, TTL, type Room } from './state';
interface Env { ROOMS: DurableObjectNamespace<PokerRoom>; ASSETS: Fetcher }
type ExpiredRoom = { expiredUntil: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const error = (message: string, status = 400) => json({ message }, status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid request.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1024) { await reader.cancel(); throw new Error('Request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid request.');
  return data;
}
function name(data: Record<string, unknown>) {
  if (Object.keys(data).some(k => k !== 'name')) throw new Error('Invalid join request.');
  return displayName(data.name);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.headers.get('Origin') !== url.origin) return error('Same-origin requests only.', 403);
    const cookieName = url.protocol === 'https:' ? '__Host-poker' : 'poker';
    const token = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const session = token && /^[0-9a-f]{64}$/.test(token) ? token : null;
    const route = /^\/api\/rooms\/([0-9a-f-]+)\/(join|socket)$/.exec(url.pathname);
    // shortcut: no global room-creation rate limit; add edge rate limiting before public exposure.
    const creating = url.pathname === '/api/rooms' && request.method === 'POST';
    if (!creating && (!route || !uuid.test(route[1]))) return error('Invalid or expired invite.', 404);
    if (route && request.method !== (route[2] === 'socket' ? 'GET' : 'POST')) return error('Method not allowed.', 405);
    const isSocket = route?.[2] === 'socket';
    if (isSocket && !session) return error('Join the room first.', 401);
    const identity = session ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    // Only the outer Worker supplies identity and the private creation route.
    const headers = new Headers(request.headers);
    headers.set('X-Session', identity);
    const id = creating ? crypto.randomUUID() : route![1];
    const internal = new URL(request.url);
    internal.pathname = creating ? '/create' : '/' + route![2];
    const response = await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(new Request(internal, { method: request.method, headers, body: request.method === 'POST' ? request.body : null }));
    if (isSocket) return response;
    const result = creating && response.ok ? json({ roomId: id }, 201) : new Response(response.body, response);
    if (!session && result.ok) result.headers.set('Set-Cookie', `${cookieName}=${identity}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${url.protocol === 'https:' ? '; Secure' : ''}`);
    return result;
  },
} satisfies ExportedHandler<Env>;

export class PokerRoom extends DurableObject<Env> {
  private async read() {
    const room = await this.ctx.storage.get<Room | ExpiredRoom>('room');
    if (room && 'expiredUntil' in room) {
      if (room.expiredUntil <= Date.now()) {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
      }
      return undefined;
    }
    if (room && room.expiresAt <= Date.now()) { await this.expire(room.expiresAt); return undefined; }
    // Older PoC rooms keep their seats and votes; their original start time is unknown.
    if (room) { room.teamName ??= 'Sprint Wizards'; room.startedAt ??= null; room.revealedAt ??= null; }
    return room;
  }
  private async save(room: Room) {
    room.expiresAt = Date.now() + TTL;
    await this.ctx.storage.put('room', room);
    await this.ctx.storage.setAlarm(room.expiresAt);
  }
  private broadcast(room: Room) {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(JSON.stringify(snapshot(room, socket.deserializeAttachment().participantId))); }
      catch { socket.close(1011, 'Reconnect to restore your seat.'); }
    }
  }
  async fetch(request: Request): Promise<Response> {
    // Serialize complete read/modify/write operations, including joins and commands.
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      const session = request.headers.get('X-Session')!;
      let room = await this.read();
      if (path !== '/create' && !room) {
        const marker = await this.ctx.storage.get<ExpiredRoom>('room');
        if (marker?.expiredUntil) return error('This room has expired. Ask the host for a new invite.', 410);
        return error('Invalid or expired invite. Ask the host for a new room.', 404);
      }
      if (path === '/socket') {
        const participant = room!.participants.find(p => p.session === session);
        if (!participant) return error('Join the room first.', 401);
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket required.', 426);
        if (this.ctx.getWebSockets().length >= 64) return error('Too many connections.', 429);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ participantId: participant.id });
        await this.save(room!);
        pair[1].send(JSON.stringify(snapshot(room!, participant.id)));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      try {
        if (path === '/create') {
          if (room) return error('Room already exists.', 409);
          room = createRoom(await body(request), session);
        } else if (path === '/join') {
          const data = await body(request);
          let participant = room!.participants.find(p => p.session === session);
          if (participant && Object.keys(data).length) name(data);
          if (!participant) {
            if (!Object.hasOwn(data, 'name')) return json({ message: 'Enter your name to join.', teamName: room!.teamName }, 401);
            const displayName = name(data);
            if (room!.participants.length >= 8) return error('This room is full (8 participants).', 409);
            participant = { id: crypto.randomUUID(), session, name: displayName };
            room!.participants.push(participant);
          }
        } else return error('Not found.', 404);
      } catch (e) { return error(e instanceof SyntaxError ? 'Invalid JSON.' : (e as Error).message); }
      await this.save(room!);
      this.broadcast(room!);
      return json({ joined: true });
    });
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.read();
      if (!room) { socket.close(4004, 'Room expired.'); return; }
      try {
        if (typeof message !== 'string' || message.length > 512) throw new Error('Invalid command.');
        apply(room, socket.deserializeAttachment().participantId, JSON.parse(message));
      } catch (e) {
        socket.send(JSON.stringify({ type: 'error', message: e instanceof SyntaxError ? 'Invalid JSON.' : (e as Error).message }));
        return;
      }
      await this.save(room);
      this.broadcast(room);
    });
  }
  webSocketClose(socket: WebSocket, code: number) { socket.close(code); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect to restore your seat.'); }
  private async expire(expiresAt: number) {
    const expiredUntil = expiresAt + 7 * TTL;
    if (expiredUntil > Date.now()) {
      // Replace the private state in one write; visits never extend marker retention.
      await this.ctx.storage.put('room', { expiredUntil } satisfies ExpiredRoom);
      await this.ctx.storage.setAlarm(expiredUntil);
    } else {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(4004, 'Room expired.');
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.read();
      if (room) await this.ctx.storage.setAlarm(room.expiresAt);
      else {
        const marker = await this.ctx.storage.get<ExpiredRoom>('room');
        if (marker?.expiredUntil) await this.ctx.storage.setAlarm(marker.expiredUntil);
      }
    });
  }
}

import { CARDS, type Card, type Snapshot, type Phase } from '../shared/protocol.ts';
export const TTL = 24 * 60 * 60 * 1000;
export interface Room {
  hostId: string; roundId: string; phase: Phase; expiresAt: number;
  teamName: string; startedAt: number | null; revealedAt: number | null;
  participants: { id: string; session: string; name: string; vote?: Card }[];
}
export function snapshot(room: Room, selfId: string): Snapshot {
  if (!room.participants.some(p => p.id === selfId)) throw new Error('Join the room first.');
  return {
    teamName: room.teamName, startedAt: room.startedAt, revealedAt: room.revealedAt, serverTime: Date.now(),
    type: 'snapshot', roundId: room.roundId, phase: room.phase, selfId, hostId: room.hostId,
    participants: room.participants.map(p => ({
      id: p.id, name: p.name, voted: p.vote !== undefined,
      ...((p.id === selfId || room.phase === 'revealed') && p.vote !== undefined ? { card: p.vote } : {}),
    })),
  };
}
export function apply(room: Room, participantId: string, input: unknown, now = Date.now()): void {
  const participant = room.participants.find(p => p.id === participantId);
  if (!participant) throw new Error('Join the room first.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid command.');
  const c = input as Record<string, unknown>;
  if (!['vote', 'start', 'reveal', 'next'].includes(c.type as string) ||
      Object.keys(c).some(k => !['type', 'roundId', ...(c.type === 'vote' ? ['card'] : [])].includes(k))) throw new Error('Invalid command.');
  if (c.roundId !== room.roundId) throw new Error('This round has ended. Your action was not accepted.');
  if (c.type === 'vote') {
    if (room.phase !== 'voting') throw new Error('Voting is closed.');
    if (!CARDS.includes(c.card as Card)) throw new Error('Invalid card.');
    participant.vote = c.card as Card;
  } else {
    if (participant.id !== room.hostId) throw new Error('Only the host can do that.');
    if (c.type === 'start') {
      if (room.phase !== 'waiting') throw new Error('Voting has already started.');
      if (room.participants.length < 2) throw new Error('Invite at least one guest before starting.');
      room.phase = 'voting';
      room.startedAt = now;
    } else if (c.type === 'reveal') {
      if (room.phase !== 'voting') throw new Error('Voting is not open.');
      if (!room.participants.some(p => p.vote !== undefined)) throw new Error('Wait for at least one vote before revealing.');
      room.phase = 'revealed';
      room.revealedAt = now;
    } else {
      if (room.phase !== 'revealed') throw new Error('Reveal the cards first.');
      room.phase = 'voting';
      room.roundId = crypto.randomUUID();
      room.startedAt = now;
      room.revealedAt = null;
      for (const p of room.participants) delete p.vote;
    }
  }
}

export function createRoom(input: Record<string, unknown>, session: string): Room {
  if (Object.keys(input).some(k => !['name', 'teamName'].includes(k))) throw new Error('Invalid room settings.');
  const name = displayName(input.name);
  const teamName = displayName(input.teamName === undefined ||
    (typeof input.teamName === 'string' && !input.teamName.trim()) ? 'Sprint Wizards' : input.teamName);
  const id = crypto.randomUUID();
  return { hostId: id, roundId: crypto.randomUUID(), phase: 'waiting', teamName,
    startedAt: null, revealedAt: null, expiresAt: 0, participants: [{ id, session, name }] };
}
export function displayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) throw new Error('Names must contain 1–40 characters.');
  return value.trim();
}

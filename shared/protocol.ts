export const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '34'] as const;
export type Card = typeof CARDS[number];
export type Phase = 'waiting' | 'voting' | 'revealed';
export type Command = { type: 'vote'; roundId: string; card: Card } | { type: 'start' | 'reveal' | 'next'; roundId: string };
export interface Snapshot {
  type: 'snapshot'; roundId: string; phase: Phase; selfId: string; hostId: string;
  teamName: string; startedAt: number | null; revealedAt: number | null; serverTime: number;
  participants: { id: string; name: string; voted: boolean; card?: Card }[];
}
export type ServerMessage = Snapshot | { type: 'error'; message: string };

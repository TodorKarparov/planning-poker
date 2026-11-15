import { CARDS, type Snapshot } from '../../shared/protocol.ts';
export function results(snapshot: Snapshot) {
  if (snapshot.phase !== 'revealed') return null;
  const votes = snapshot.participants.flatMap(p => p.card === undefined ? [] : [p.card]);
  return {
    count: votes.length,
    consensus: votes.length === snapshot.participants.length && new Set(votes).size === 1 ? votes[0] : null,
    average: votes.length ? Number((votes.reduce((sum, v) => sum + Number(v), 0) / votes.length).toFixed(2)) : null,
    distribution: CARDS.flatMap(card => {
      const count = votes.filter(v => v === card).length;
      return count ? [{ card, count, percent: Math.round(count / votes.length * 100) }] : [];
    }),
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, snapshot, createRoom, type Room } from '../worker/state.ts';
function room(): Room { return { hostId: 'h', roundId: 'r', phase: 'voting', teamName: 'Test team', startedAt: 1000, revealedAt: null, expiresAt: Date.now() + 10000, participants: [{ id: 'h', session: 'secret-host', name: 'Host', vote: '34' }, { id: 'g', session: 'secret-guest', name: 'Guest', vote: '3' }] }; }
test('snapshots omit other cards and all session credentials before reveal', () => {
  const r = room();
  for (const id of ['h', 'g']) {
    const s = snapshot(r, id);
    assert.ok(s.participants.every(p => p.id === id || !Object.hasOwn(p, 'card')));
    assert.ok(s.participants.every(p => !Object.hasOwn(p, 'session')));
    assert.equal(s.participants.find(p => p.id === id)?.card, id === 'h' ? '34' : '3');
    assert.ok(!JSON.stringify(s).includes('secret'));
  }
  apply(r, 'h', { type: 'reveal', roundId: 'r' });
  assert.deepEqual(snapshot(r, 'g').participants.map(p => p.card), ['34', '3']);
});
test('guests and nonmembers cannot exercise host authority', () => {
  const r = room();
  for (const id of ['g', 'outsider']) for (const type of ['reveal', 'next']) {
    const before = structuredClone(r);
    assert.throws(() => apply(r, id, { type, roundId: 'r' }));
    assert.deepEqual(r, before);
  }
  assert.throws(() => snapshot(r, 'outsider'));
  assert.throws(() => apply(r, 'g', { type: 'reveal', roundId: 'r', role: 'host' }));
});
test('next round clears votes, retains seats, and rejects delayed votes', () => {
  const r = room();
  apply(r, 'h', { type: 'reveal', roundId: 'r' });
  apply(r, 'h', { type: 'next', roundId: 'r' });
  assert.equal(r.participants.length, 2);
  assert.notEqual(r.roundId, 'r');
  assert.ok(r.participants.every(p => p.vote === undefined));
  assert.throws(() => apply(r, 'g', { type: 'vote', roundId: 'r', card: '5' }), /round has ended/);
  apply(r, 'g', { type: 'vote', roundId: r.roundId, card: '5' });
  apply(r, 'g', { type: 'vote', roundId: r.roundId, card: '8' });
  assert.equal(r.participants[1].vote, '8');
});
test('invalid shapes, cards, phases and identities do not mutate state', () => {
  const r = room();
  for (const value of [null, [], {}, { type: 'vote', roundId: 'r', card: '100' }, { type: 'vote', roundId: 'r', card: 5 }, { type: 'next', roundId: 'r' }, { type: 'vote', roundId: 'r', card: '5', participantId: 'g' }]) {
    const before = structuredClone(r);
    assert.throws(() => apply(r, 'h', value)); assert.deepEqual(r, before);
  }
  assert.throws(() => apply(r, 'outsider', { type: 'vote', roundId: 'r', card: '5' }));
  apply(r, 'h', { type: 'reveal', roundId: 'r' });
  assert.throws(() => apply(r, 'h', { type: 'vote', roundId: 'r', card: '5' }));
});

test('new rooms wait for the host; settings and identity stay authoritative', () => {
  const r = createRoom({ name: ' Host ', teamName: ' My team ' }, 'secret');
  assert.equal(r.phase, 'waiting');
  assert.equal(r.teamName, 'My team');
  assert.equal(r.participants[0].name, 'Host');
  const solo = structuredClone(r);
  assert.throws(() => apply(r, r.hostId, { type: 'start', roundId: r.roundId }), /at least one guest/);
  assert.deepEqual(r, solo);
  r.participants.push({ id: 'g', name: 'Guest', session: 'guest-secret' });
  assert.throws(() => apply(r, 'g', { type: 'start', roundId: r.roundId }), /Only the host/);
  assert.throws(() => apply(r, r.hostId, { type: 'vote', roundId: r.roundId, card: '0' }), /closed/);
  assert.throws(() => apply(r, r.hostId, { type: 'reveal', roundId: r.roundId }), /not open/);
  apply(r, r.hostId, { type: 'start', roundId: r.roundId }, 1000);
  assert.equal(r.startedAt, 1000);
  const emptyRound = structuredClone(r);
  assert.throws(() => apply(r, r.hostId, { type: 'reveal', roundId: r.roundId }), /at least one vote/);
  assert.deepEqual(r, emptyRound);
  assert.throws(() => apply(r, r.hostId, { type: 'start', roundId: r.roundId }), /already started/);
  // The countdown is advisory: only the host closes voting, even after five minutes.
  apply(r, 'g', { type: 'vote', roundId: r.roundId, card: '0' }, 302000);
  apply(r, r.hostId, { type: 'reveal', roundId: r.roundId }, 303000);
  assert.equal(r.revealedAt, 303000);
  apply(r, r.hostId, { type: 'next', roundId: r.roundId }, 304000);
  assert.equal(r.startedAt, 304000);
  assert.equal(r.revealedAt, null);
  assert.equal(r.teamName, 'My team');
  assert.throws(() => apply(r, r.hostId, { type: 'reveal', roundId: r.roundId }), /at least one vote/);
});
test('omitted, empty and whitespace-only team names use the default', () => {
  for (const teamName of [undefined, '', '  \t ']) {
    assert.equal(createRoom({ name: 'Host', teamName }, 'secret').teamName, 'Sprint Wizards');
  }
});
test('invalid room settings are rejected', () => {
  for (const input of [{ name: '' }, { name: 'Host', teamName: null }, { name: 'Host', teamName: 0 }, { name: 'Host', teamName: 'x'.repeat(41) }, { name: 'Host', role: 'host' }, { name: 'Host', deck: 'memes' }]) {
    assert.throws(() => createRoom(input, 'secret'));
  }
});

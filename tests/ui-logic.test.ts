import test from 'node:test';
import assert from 'node:assert/strict';
import { results } from '../src/scripts/results.ts';
import { inviteId } from '../src/scripts/invite.ts';
import { nameError } from '../src/scripts/forms.ts';
import { post } from '../src/scripts/http.ts';
import { snapshot, type Room } from '../worker/state.ts';
const room = (): Room => ({ hostId: 'h', roundId: 'r', phase: 'revealed', teamName: 'Team', startedAt: 1, revealedAt: 2, expiresAt: 3,
  participants: [{ id: 'h', name: 'Host', session: 'host', vote: '5' }, { id: 'g', name: 'Guest', session: 'guest', vote: '8' }] });
test('results use revealed votes, including zeros and abstentions', () => {
  const r = room();
  assert.deepEqual(results(snapshot(r, 'h')), { count: 2, consensus: null, average: 6.5, distribution: [{ card: '5', count: 1, percent: 50 }, { card: '8', count: 1, percent: 50 }] });
  r.phase = 'voting';
  assert.equal(results(snapshot(r, 'h')), null);
  r.phase = 'revealed';
  r.participants[0].vote = r.participants[1].vote = '0';
  assert.equal(results(snapshot(r, 'h'))?.consensus, '0');
  assert.equal(results(snapshot(r, 'h'))?.average, 0);
  delete r.participants[1].vote;
  assert.equal(results(snapshot(r, 'h'))?.consensus, null);
  delete r.participants[0].vote;
  assert.equal(results(snapshot(r, 'h'))?.average, null);
  assert.deepEqual(results(snapshot(r, 'h'))?.distribution, []);
});
test('join link parser accepts same-origin invites and rejects foreign or malformed links', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const origin = 'https://poker.example';
  assert.equal(inviteId(`${origin}/room?id=${id}`, origin), id);
  assert.equal(inviteId(`/room?id=${id}`, origin), id);
  for (const value of ['javascript:alert(1)', `https://evil.example/room?id=${id}`, '/room?id=bad', '/room', '/']) assert.throws(() => inviteId(value, origin));
});
test('invite errors distinguish missing, non-link, foreign and malformed input', () => {
  const origin = 'https://poker.example';
  assert.throws(() => inviteId(' ', origin), /Paste the invite/);
  assert.throws(() => inviteId('hello', origin), /does not look like a link/);
  assert.throws(() => inviteId('https://elsewhere.example/room', origin), /another site/);
  assert.throws(() => inviteId('/room?id=bad', origin), /incomplete or malformed/);
  assert.throws(() => inviteId('https://', origin), /incomplete or malformed/);
});
test('inline name validation matches server limits and optional team names', () => {
  assert.match(nameError(' '), /display name/);
  assert.equal(nameError(' ', true), '');
  assert.equal(nameError(' x '), '');
  assert.equal(nameError('x'.repeat(40)), '');
  assert.match(nameError('x'.repeat(41), true), /40 characters/);
});
test('HTTP failures provide recovery copy and preserve membership status', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(post('/api/rooms', {}), /Check your connection and try again/);
  fetch.mock.mockImplementation(async () => new Response('not JSON', { status: 502 }));
  await assert.rejects(post('/api/rooms', {}), /Cannot reach/);
  fetch.mock.mockImplementation(async () => Response.json({ message: 'Enter your name', teamName: 'Team' }, { status: 401 }));
  await assert.rejects(post('/api/rooms/id/join', {}), { message: 'Enter your name', status: 401, teamName: 'Team' });
});

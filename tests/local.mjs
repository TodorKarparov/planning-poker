// Run against `npm run dev`; two independent cookie jars exercise real HTTP and WS traffic.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.POKER_URL || 'http://localhost:8787';
class Browser {
  cookie = '';
  async post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: base, Cookie: this.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.headers.has('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  connect(id) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/api/rooms/${id}/socket`, { headers: { Origin: base, Cookie: this.cookie } });
    const queue = [];
    let waiter;
    let failure;
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      console.log('WIRE', this.label, JSON.stringify(message));
      queue.push(message);
      waiter?.();
    });
    ws.on('error', error => { failure = error; waiter?.(); });
    return {
      ws,
      send: value => ws.send(JSON.stringify(value)),
      async wait(predicate) {
        const deadline = Date.now() + 5000;
        while (true) {
          const index = queue.findIndex(predicate);
          if (index !== -1) return queue.splice(index, 1)[0];
          if (failure) throw failure;
          if (Date.now() >= deadline) throw new Error('Timed out waiting for WebSocket message');
          await new Promise(resolve => { const timer = setTimeout(resolve, 100); waiter = () => { clearTimeout(timer); resolve(); }; });
        }
      },
    };
  }
}
const host = new Browser(); host.label = 'host';
const guest = new Browser(); guest.label = 'guest';
const sockets = [];
try {
  const created = await host.post('/api/rooms', { name: 'Host', teamName: '  ' });
  assert.equal(created.status, 201);
  assert.ok(host.cookie);
  const id = created.body.roomId;
  const path = `/api/rooms/${id}`;
  assert.equal((await fetch(`${base}/room?id=${id}`)).status, 200, 'static invite must open directly');
  const h = host.connect(id); sockets.push(h.ws);
  const solo = await h.wait(m => m.type === 'snapshot');
  assert.equal(solo.teamName, 'Sprint Wizards');
  h.send({ type: 'start', roundId: solo.roundId });
  assert.match((await h.wait(m => m.type === 'error')).message, /at least one guest/);
  assert.equal((await guest.post(path + '/join', {})).status, 401);
  assert.equal((await guest.post(path + '/join', { name: 'Guest' })).status, 200);
  assert.notEqual(host.cookie, guest.cookie);
  let g = guest.connect(id); sockets.push(g.ws);
  const hs = await h.wait(m => m.type === 'snapshot' && m.participants.length === 2);
  const gs = await g.wait(m => m.type === 'snapshot');
  assert.equal(hs.hostId, hs.selfId);
  assert.notEqual(gs.selfId, gs.hostId);
  assert.equal(hs.phase, 'waiting');
  assert.equal(hs.teamName, 'Sprint Wizards');
  const roundId = hs.roundId;
  g.send({ type: 'start', roundId });
  assert.match((await g.wait(m => m.type === 'error')).message, /Only the host/);
  h.send({ type: 'vote', roundId, card: '5' });
  assert.match((await h.wait(m => m.type === 'error')).message, /closed/);
  h.send({ type: 'start', roundId });
  const started = await h.wait(m => m.type === 'snapshot' && m.phase === 'voting');
  assert.equal(typeof started.startedAt, 'number');
  await g.wait(m => m.type === 'snapshot' && m.phase === 'voting');
  h.send({ type: 'reveal', roundId });
  assert.match((await h.wait(m => m.type === 'error')).message, /at least one vote/);
  h.send({ type: 'vote', roundId, card: '34' });
  await h.wait(m => m.type === 'snapshot' && m.participants.find(p => p.id === hs.selfId)?.card === '34');
  const hidden = await g.wait(m => m.type === 'snapshot' && m.participants.find(p => p.id === hs.selfId)?.voted);
  assert.ok(!Object.hasOwn(hidden.participants.find(p => p.id === hs.selfId), 'card'));
  assert.ok(!JSON.stringify(hidden).includes('session'));
  g.send({ type: 'vote', roundId, card: '3' });
  await g.wait(m => m.type === 'snapshot' && m.participants.find(p => p.id === gs.selfId)?.card === '3');
  const hostView = await h.wait(m => m.type === 'snapshot' && m.participants.find(p => p.id === gs.selfId)?.voted);
  assert.ok(!Object.hasOwn(hostView.participants.find(p => p.id === gs.selfId), 'card'));
  g.send({ type: 'reveal', roundId });
  assert.match((await g.wait(m => m.type === 'error')).message, /Only the host/);
  g.send({ type: 'next', roundId });
  assert.match((await g.wait(m => m.type === 'error')).message, /Only the host/);
  g.ws.close();
  assert.equal((await guest.post(path + '/join', {})).status, 200);
  g = guest.connect(id); sockets.push(g.ws);
  const restored = await g.wait(m => m.type === 'snapshot');
  assert.equal(restored.selfId, gs.selfId);
  assert.equal(restored.roundId, roundId);
  assert.equal(restored.startedAt, started.startedAt);
  assert.equal(restored.teamName, 'Sprint Wizards');
  assert.equal(restored.participants.length, 2);
  assert.equal(restored.participants.find(p => p.id === gs.selfId).card, '3');
  assert.ok(!Object.hasOwn(restored.participants.find(p => p.id === hs.selfId), 'card'));
  g.send({ type: 'vote', roundId, card: '8' });
  await g.wait(m => m.type === 'snapshot' && m.participants.find(p => p.id === gs.selfId)?.card === '8');
  h.send({ type: 'reveal', roundId });
  const revealed = await g.wait(m => m.type === 'snapshot' && m.phase === 'revealed');
  assert.deepEqual(revealed.participants.map(p => p.card), ['34', '8']);
  h.send({ type: 'next', roundId });
  const next = await g.wait(m => m.type === 'snapshot' && m.roundId !== roundId);
  assert.ok(next.participants.every(p => !p.voted && !Object.hasOwn(p, 'card')));
  h.send({ type: 'reveal', roundId: next.roundId });
  assert.match((await h.wait(m => m.type === 'error')).message, /at least one vote/);
  g.send({ type: 'vote', roundId, card: '21' });
  assert.match((await g.wait(m => m.type === 'error')).message, /round has ended/);
  assert.equal((await guest.post('/api/rooms/00000000-0000-4000-8000-000000000000/join', {})).status, 404);
  const crossOrigin = await fetch(base + '/api/rooms', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bad' }) });
  assert.equal(crossOrigin.status, 403);
  console.log('PASS: solo start and empty reveal rejected, optional team name, waiting/start permissions, persisted timer, two cookie jars, direct invite, private payloads, host authorization, reconnect, changed vote, reveal, next round, stale vote, invalid invite and origin checks.');
} finally { for (const socket of sockets) socket.terminate(); }

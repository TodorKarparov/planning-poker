import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as state from '../worker/state.ts';

// Run the real object handlers with an in-memory storage boundary and a controllable clock.
const code = ts.transpileModule(readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness() {
  let now = 1000;
  let alarm: number | undefined;
  const data = new Map();
  const closed: number[] = [];
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    deleteAll: async () => { data.clear(); },
    setAlarm: async (time: number) => { alarm = time; },
    deleteAlarm: async () => { alarm = undefined; },
  };
  const exports: Record<string, any> = {};
  runInNewContext(code, {
    exports, URL, Response, TextDecoder, crypto,
    Date: class extends Date { static now() { return now; } },
    require: (name: string) => name === './state' ? state : {
      DurableObject: class { ctx: unknown; constructor(ctx: unknown) { this.ctx = ctx; } },
    },
  });
  const room = new exports.PokerRoom({ storage,
    blockConcurrencyWhile: (run: () => unknown) => run(),
    getWebSockets: () => [{ close: (code: number) => closed.push(code), send() {}, deserializeAttachment: () => ({ participantId: 'unused' }) }],
  });
  return { room, data, closed, alarm: () => alarm, time: (value: number) => { now = value; },
    post: (path: string, body = {}) => room.fetch(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'X-Session': 'private-session' }, body: JSON.stringify(body),
    })),
  };
}

test('expiry erases private state, distinguishes fresh visits, and deletes its marker after seven days', async () => {
  const h = harness();
  assert.equal((await h.post('/join')).status, 404);
  assert.equal((await h.post('/create', { name: 'Host', teamName: 'Private team' })).status, 200);
  const expiresAt = h.data.get('room').expiresAt;
  h.time(expiresAt);
  await h.room.alarm();
  assert.deepEqual(h.data.get('room'), { expiredUntil: expiresAt + 7 * state.TTL });
  assert.equal(h.alarm(), expiresAt + 7 * state.TTL);
  assert.ok(h.closed.includes(4004));
  const freshVisit = await h.post('/join');
  assert.equal(freshVisit.status, 410);
  assert.match((await freshVisit.json()).message, /room has expired/);
  h.time(expiresAt + 6 * state.TTL);
  assert.equal((await h.post('/join')).status, 410);
  assert.equal(h.alarm(), expiresAt + 7 * state.TTL, 'visits must not extend retention');
  h.time(expiresAt + 7 * state.TTL);
  await h.room.alarm();
  assert.equal(h.data.size, 0);
  assert.equal(h.alarm(), undefined);
  assert.equal((await h.post('/join')).status, 404);
});

test('request-time expiry works without an alarm and late alarms cannot extend retention', async () => {
  const h = harness();
  await h.post('/create', { name: 'Host' });
  const expiresAt = h.data.get('room').expiresAt;
  h.time(expiresAt + 1);
  assert.equal((await h.post('/join')).status, 410);
  h.time(expiresAt + 8 * state.TTL);
  assert.equal((await h.post('/join')).status, 404);
  assert.equal(h.data.size, 0);
  assert.equal(h.alarm(), undefined);
  await h.room.alarm();
  assert.equal(h.data.size, 0);

  const late = harness();
  await late.post('/create', { name: 'Host' });
  late.time(late.data.get('room').expiresAt + 8 * state.TTL);
  await late.room.alarm();
  assert.equal(late.data.size, 0, 'a delayed first cleanup must not start a new seven-day window');
  assert.equal(late.alarm(), undefined);
});

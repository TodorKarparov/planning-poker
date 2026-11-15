import type { Card, Command, ServerMessage, Snapshot } from '../../shared/protocol';
import { post } from './http';
import { results } from './results';
import { validateNames } from './forms';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const roomId = new URLSearchParams(location.search).get('id');
const endpoint = `/api/rooms/${roomId}`;
const deck = el<HTMLFieldSetElement>('deck');
const own = el<HTMLButtonElement>('own');
const hostAction = el<HTMLButtonElement>('host-action');
const recovery = el<HTMLDialogElement>('recovery');
let socket: WebSocket | undefined;
let state: Snapshot | undefined;
let ready = false;
let stopped = false;
let resuming = false;
let retry = 0;
let pending: Command | undefined;
let acknowledgement: ReturnType<typeof setTimeout> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let snapshotReceivedAt = performance.now();
let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
let actionFocus = false;
function focusCard() {
  (deck.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? deck.querySelector<HTMLButtonElement>('button'))?.focus();
}
function showRecovery(failed = false) {
  ready = false; controls();
  el('guidance').textContent = 'Connection lost. Reconnect before changing your vote.';
  el('recovery-title').textContent = failed ? 'Unable to reconnect' : 'Connection lost';
  el('recovery-copy').textContent = failed ? 'Your saved seat and vote will be restored when you reconnect. Check your connection and try again.' : 'Reconnecting to restore your seat and saved vote. Votes cannot be sent yet.';
  el('retry').hidden = !failed;
  const art = el<HTMLImageElement>('recovery-art');
  art.src = `/assets/${failed ? 'warning-icon' : 'loading-spinner'}.png`;
  art.classList.toggle('spinner', !failed);
  if (!recovery.open) {
    recovery.showModal(); el('recovery-title').focus();
  }
}
function closeRecovery() {
  if (!recovery.open) return;
  recovery.close();
  // Disabling controls can leave body focused before the dialog opens.
  // Always return to a stable, focusable heading in the restored snapshot.
  el('summary').focus();
}
function controls() {
  deck.disabled = own.disabled = !ready || state?.phase !== 'voting';
  hostAction.disabled = !ready || Boolean(pending && pending.type !== 'vote') ||
    (state?.phase === 'waiting' && state.participants.length < 2) ||
    (state?.phase === 'voting' && !state.participants.some(p => p.voted));
}
function showDeck(open: boolean) {
  deck.hidden = !open;
  own.setAttribute('aria-expanded', String(open));
}
function tick() {
  if (!state || state.startedAt === null) return;
  const now = state.revealedAt ?? state.serverTime + performance.now() - snapshotReceivedAt;
  const seconds = Math.max(0, 300 - Math.floor((now - state.startedAt) / 1000));
  if (ready && !seconds && state.phase === 'voting') el('guidance').textContent = 'Time’s up. Voting stays open until the host reveals the cards.';
  el('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
setInterval(tick, 1000);
function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const confetti = el('confetti');
  confetti.replaceChildren();
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', `${i * 5.8}%`);
    piece.style.setProperty('--delay', `${(i % 5) * 70}ms`);
    piece.style.setProperty('--turn', `${i * 43}deg`);
    confetti.append(piece);
  }
  setTimeout(() => confetti.replaceChildren(), 2200);
}
function render(next: Snapshot) {
  const previous = state;
  state = next;
  snapshotReceivedAt = performance.now();
  ready = true; retry = 0;
  clearTimeout(connectionTimeout);
  el('connection').textContent = 'Connected';
  el('message').textContent = '';
  el('join').hidden = true;
  el('room-header').hidden = el('game').hidden = false;
  el('team-name').textContent = next.teamName;
  const host = next.hostId === next.selfId;
  const self = next.participants.find(p => p.id === next.selfId)!;
  el<HTMLImageElement>('own-art').src = self.card === undefined ? '/assets/card-unselected.png' : `/assets/card-${self.card}.svg`;
  own.setAttribute('aria-label', self.card === undefined ? 'Choose your card' : `Your card: ${self.card}${next.phase === 'voting' ? '. Change your vote' : ''}`);
  if (pending && (pending.roundId !== next.roundId ||
      (pending.type === 'vote' ? pending.card === self.card || next.phase !== 'voting' :
       pending.type === 'start' ? next.phase === 'voting' : pending.type === 'reveal' && next.phase === 'revealed'))) {
    pending = undefined; clearTimeout(acknowledgement);
  }
  el('vote-status').textContent = pending?.type === 'vote' ? 'Sending vote…' : next.phase === 'waiting' ? 'Available once voting starts' : self.card ? `Vote ${self.card} accepted` : next.phase === 'revealed' ? 'You did not vote' : 'Choose a card';
  for (const button of deck.querySelectorAll<HTMLButtonElement>('[data-card]')) button.setAttribute('aria-pressed', String(button.dataset.card === self.card));
  if (next.phase !== 'voting') showDeck(false);
  else if (!previous || previous.roundId !== next.roundId || previous.phase !== 'voting') showDeck(!self.card);
  const rows = el('participants').children;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HTMLElement;
    const p = next.participants[i];
    row.className = !p ? 'empty' : `${p.id === next.selfId ? 'self' : ''} ${p.id === next.hostId ? 'host' : ''} ${p.voted ? 'voted' : ''}`;
    row.setAttribute('aria-hidden', String(!p));
    if (!p) continue;
    row.children[0].textContent = next.phase === 'revealed' ? p.card ?? '—' : p.name.slice(0, 1).toUpperCase();
    row.children[1].textContent = `${p.name}${p.id === next.selfId ? ' (you)' : ''}`;
    (row.children[1] as HTMLElement).title = p.name;
    row.children[2].textContent = `${p.id === next.hostId ? 'Host · ' : ''}${p.voted ? 'Voted ✓' : next.phase === 'waiting' ? 'Ready' : 'Not voted'}`;
  }
  const total = next.participants.length;
  const voted = next.participants.filter(p => p.voted).length;
  el('round').textContent = next.phase === 'waiting' ? `${total} of 8 seats taken` : `${voted} of ${total} voted`;
  el('timer').hidden = next.phase !== 'voting' || next.startedAt === null;
  el('table-share').hidden = !(host && next.phase === 'waiting' && total === 1);
  hostAction.hidden = !host || (next.phase === 'waiting' && total < 2);
  hostAction.textContent = next.phase === 'waiting' ? 'Start voting' : next.phase === 'voting' ? 'Reveal cards' : 'Vote again';
  el('summary').textContent = next.phase === 'waiting' ? host ? total === 1 ? 'Invite your team' : 'Ready to start?' : 'Waiting for voting to start' : !self.card ? 'Pick your card' : host ? 'Ready to reveal?' : 'Waiting for reveal';
  el('guidance').textContent = next.phase === 'waiting' ? host ? 'Share the link, then start when your team is ready.' : 'Your host will start the round.' : next.phase === 'voting' ? 'You can change your card until reveal.' : host ? 'Discuss the estimates, then vote again.' : 'Waiting for the host to start the next round.';
  const result = results(next);
  el('game').dataset.phase = next.phase;
  el('summary').classList.toggle('waiting-label', !host && next.phase === 'waiting');
  el('results').hidden = true;
  el('table-icon').hidden = !(host && next.phase === 'waiting' && total === 1);
  el<HTMLImageElement>('table-art').src = '/assets/invite-icon.png';
  if (result) {
    if (result.consensus !== null) {
      el('summary').textContent = `Everyone voted ${result.consensus}!`;
      el('table-icon').hidden = false;
      el<HTMLImageElement>('table-art').src = '/assets/consensus.png';
      if (previous?.roundId === next.roundId && previous.phase === 'voting') celebrate();
    } else if (result.count) {
      el('summary').textContent = 'Let’s discuss the estimates';
      el('results').hidden = false;
      el('average').textContent = String(result.average);
      el('distribution').replaceChildren(...result.distribution.map(bin => {
        const li = document.createElement('li');
        li.setAttribute('aria-label', `${bin.card}: ${bin.count} votes, ${bin.percent}%`);
        const percent = document.createElement('span'); percent.textContent = `${bin.percent}%`;
        const track = document.createElement('span'); track.className = 'bar-track';
        const fill = document.createElement('span'); fill.className = 'bar-fill'; fill.style.height = `${bin.percent}%`;
        track.append(fill);
        const card = document.createElement('b'); card.textContent = bin.card;
        li.append(percent, track, card); return li;
      }));
    } else el('summary').textContent = 'No votes this round';
  }
  tick();
  controls();
  closeRecovery();
  if (actionFocus && !pending) {
    actionFocus = false;
    if (next.phase === 'voting' && !deck.hidden) focusCard();
    else el('summary').focus();
  }
}
function unavailable(message: string, expired = false) {
  stopped = true; ready = false; controls();
  clearTimeout(reconnect); clearTimeout(acknowledgement); clearTimeout(connectionTimeout);
  socket?.close(); recovery.close();
  el('game').hidden = el('join').hidden = el('share').hidden = el('room-header').hidden = true;
  el('message').textContent = '';
  el('unavailable').hidden = false;
  el('unavailable-reason').textContent = message;
  el('unavailable-title').textContent = expired ? 'Room expired' : 'Room unavailable';
  el('unavailable-title').focus();
}
function scheduleReconnect() {
  clearTimeout(reconnect);
  if (stopped) return;
  showRecovery(retry >= 3);
  if (retry < 3) reconnect = setTimeout(() => void resume(), 1000 * 2 ** retry++);
}
function connect() {
  if (stopped) return;
  ready = false; controls();
  el('connection').textContent = 'Connecting…';
  const current = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${endpoint}/socket`);
  socket = current;
  clearTimeout(connectionTimeout);
  connectionTimeout = setTimeout(() => current.close(), 8000);
  current.onmessage = event => {
    if (socket !== current) return;
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === 'snapshot') render(message);
    else {
      pending = undefined; clearTimeout(acknowledgement); controls();
      el('message').textContent = message.message; el('vote-status').textContent = 'Action rejected. Choose again.';
      if (actionFocus) { actionFocus = false; el('summary').focus(); }
    }
  };
  current.onclose = event => {
    if (socket !== current || stopped) return;
    clearTimeout(connectionTimeout);
    ready = false; pending = undefined; clearTimeout(acknowledgement); controls();
    el('connection').textContent = 'Disconnected — votes cannot be sent';
    el('vote-status').textContent = 'Reconnect to confirm your saved vote.';
    if (event.code === 4004) unavailable('This room has expired. Ask the host for a new invite.', true);
    else scheduleReconnect();
  };
  current.onerror = () => current.close();
}
function send(command: Command) {
  if (!ready || socket?.readyState !== WebSocket.OPEN) return;
  if (command.type !== 'vote' && document.activeElement === hostAction) {
    actionFocus = true;
    el('summary').focus();
  }
  el('message').textContent = '';
  pending = command; controls();
  socket.send(JSON.stringify(command));
  clearTimeout(acknowledgement);
  acknowledgement = setTimeout(() => {
    el('message').textContent = 'No confirmation received. Reconnecting to check the saved state.';
    socket?.close();
  }, 5000);
}
deck.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-card]');
  if (!button || !state || !ready) return;
  el('vote-status').textContent = 'Sending vote…';
  send({ type: 'vote', roundId: state.roundId, card: button.dataset.card as Card });
  showDeck(false); own.focus();
});
own.onclick = () => { showDeck(deck.hidden); if (!deck.hidden) focusCard(); };
hostAction.onclick = () => { if (state) send({ type: state.phase === 'waiting' ? 'start' : state.phase === 'voting' ? 'reveal' : 'next', roundId: state.roundId }); };
const form = el<HTMLFormElement>('name-form');
form.onsubmit = async event => {
  event.preventDefault();
  if (!validateNames(form)) return;
  const button = form.querySelector('button')!;
  button.disabled = true; el('form-error').textContent = '';
  try { await post(endpoint + '/join', { name: new FormData(form).get('name') }); connect(); }
  catch (error) {
    const failure = error as Error & { status?: number };
    if (failure.status === 404 || failure.status === 410) unavailable(failure.message, failure.status === 410);
    else el('form-error').textContent = `Unable to join. ${failure.message}`;
  }
  finally { button.disabled = false; }
};
async function resume() {
  if (resuming || stopped) return;
  resuming = true; clearTimeout(reconnect);
  try { await post(endpoint + '/join', {}); connect(); }
  catch (error) {
    const failure = error as Error & { status?: number; teamName?: string };
    if (failure.status === 401) {
      closeRecovery(); retry = 0;
      el('join').hidden = false; el('message').textContent = '';
      el('name-label').textContent = `Join ${failure.teamName ?? 'the room'} as:`;
      el<HTMLInputElement>('name').focus();
    } else if ([404, 409, 410].includes(failure.status ?? 0)) unavailable(failure.message, failure.status === 410);
    else { el('message').textContent = 'Cannot connect to the room.'; scheduleReconnect(); }
  } finally { resuming = false; }
}
function showShare(open: boolean) {
  el('share').hidden = !open; el('invite').setAttribute('aria-expanded', String(open));
  if (open) el<HTMLInputElement>('link').focus();
  else el('invite').focus();
}
el('invite').onclick = () => showShare(el('share').hidden);
el('close-share').onclick = () => showShare(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !el('share').hidden) showShare(false); });
for (const id of ['link', 'table-link']) el<HTMLInputElement>(id).value = `${location.origin}/room?id=${roomId}`;
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) button.onclick = async () => {
  const input = el<HTMLInputElement>(button.dataset.copy!);
  try { await navigator.clipboard.writeText(input.value); button.textContent = 'Copied!'; setTimeout(() => button.textContent = 'Copy link', 2000); }
  catch { input.focus(); input.select(); el('message').textContent = 'Copy the selected link.'; }
};
addEventListener('offline', () => {
  if (stopped) return;
  showRecovery(); el('connection').textContent = 'Offline — votes cannot be sent'; socket?.close();
});
el('retry').onclick = () => { retry = 0; showRecovery(); void resume(); };
recovery.addEventListener('cancel', event => event.preventDefault());
addEventListener('online', () => { if (!ready && !stopped) { retry = 0; showRecovery(); void resume(); } });
if (!roomId || !/^[0-9a-f-]{36}$/.test(roomId)) unavailable('This invite is invalid. Ask the host for a new link.');
else void resume();

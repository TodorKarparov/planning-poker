# Planning poker PoC

Two Astro static pages, a native WebSocket browser script, and one SQLite-backed Durable Object per room. No accounts, client router, hydrated framework, history, or external database. One npm package and one Wrangler configuration.

## Setup and local use

Use Node 22.22+ (Node 24 recommended) and npm. Astro 7.4 raises the Node 22 minimum; see the [release notes](https://astro.build/blog/astro-740/#updated-minimum-nodejs-version).

```sh
git init                    # if this directory is not already a Git repository
npm ci                      # installs the versions in package-lock.json
npm run dev                 # builds Astro, then serves the whole app through Wrangler
```

Open `http://localhost:8787`. Choose Create room, edit the prefilled player/team names if desired, and create the room. Copy its invite and open it in a private browser window to join as a second participant. The host then selects Start voting. A normal tab shares the same seat. Restart `npm run dev` after frontend edits. Wrangler persists local room data under `.wrangler/`.

`/` and `/room` are built once. `/room?id=<uuid>` loads directly, including after refresh. Room creation only writes Durable Object storage; it never rebuilds Astro. Workers Static Assets serves `dist/` asset-first; unmatched `/api/` requests reach the Worker on the same origin.

## Verification

With Wrangler running in another terminal:

```sh
npm test
npm run check
npm run build
npm run test:local
```

`npm test` uses Node's test runner with no test framework. Its fourteen checks cover snapshot privacy, guest/nonmember authorization, waiting/start transitions, phase/card/shape validation, stale rounds, room settings, result calculations, specific invite errors, inline name validation, HTTP failure recovery messages and expiry-marker cleanup. Expiry checks execute the actual object handlers with in-memory storage and a controlled clock. `npm run test:local` uses two separate cookie jars against real HTTP and WebSocket endpoints. It prints actual snapshots and checks private values are absent, guest start/reveal/next are rejected, reconnection restores the same seat, team, round start time and vote, vote changes work, reveal exposes values, next clears votes, stale votes fail, and invalid invites and cross-origin requests fail. `ws` is used only by this Node integration check, never shipped to browsers.

Manual browser checks: tab through name entry, cards, reveal and invite controls; vote using Space/Enter; refresh with a saved vote; disconnect the network and confirm controls disable/reconnection feedback appears. The selected card changes only when a server snapshot confirms it. A five-second missing acknowledgement triggers reconnection to recover authoritative state. A modal dims the room during recovery and prevents sending votes. After three automatic retries it offers Try again or Leave room. HTTP requests time out after ten seconds; sockets that never send their initial snapshot time out after eight. No commands are queued for later rounds. Leaving returns to the homepage and preserves the seat for a later visit.

After a successful build, measure all emitted browser JS (raw bytes; this is an upper bound for the room page if the entry page has a separate bundle):

```sh
find dist -name '*.js' -exec wc -c {} +
```

For the exact room payload, inspect `dist/room.html` for its module script and follow any imports to shared chunks; count those files once. Do not compare framework sizes without an equivalent build.

## Code map and trust boundaries

- `src/pages`, `src/components`, `src/styles`: static Astro markup and CSS.
- `src/scripts`: browser HTTP bootstrap, native WebSocket connection and snapshot rendering.
- `shared/protocol.ts`: public card values and wire types only.
- `worker/state.ts`: private durable state, command validation and explicit per-recipient snapshot construction.
- `worker/index.ts`: same-origin HTTP routes, cookie issuance, Durable Object persistence, sockets and expiry.
- `tests`: dependency-free state checks and the two-cookie-jar integration script.
- `tsconfig.json` checks browser/Astro code; `worker/tsconfig.json` checks the backend with Cloudflare types, keeping Worker globals out of browser code.

Each browser receives a random 256-bit HttpOnly, SameSite=Strict cookie. HTTPS uses a Secure `__Host-` cookie. The room maps this secret to a separate public participant ID. Only the participant recorded as the creator is host. The invite grants permission to join, not host authority. Names and client role fields do not confer privileges. Clearing the host's cookie loses its seat; host transfer/recovery is outside this PoC.

The Durable Object stores one `room` record through its storage API on the SQLite backend. It stores membership, host, team name, current round, phase, votes, round start/reveal timestamps and expiration. Complete read/modify/write handlers are serialized using `blockConcurrencyWhile`; accepted changes are persisted before snapshots are broadcast. Hibernating WebSockets use `acceptWebSocket` and serialized participant attachments. Handlers reload the record from storage and require no surviving in-memory state. Every outgoing snapshot is explicitly constructed, with other people's card fields entirely omitted before reveal. Session secrets never appear in snapshots.

Rooms support eight participants, matching the reference's table, and at most 64 sockets (multiple tabs share a seat). Disconnected members retain their seat and vote. Votes, joins and successful connections extend inactivity expiry to 24 hours. Merely leaving a socket open does not extend it. At expiry, an alarm replaces the private room record with a single expiry deadline and closes sockets. No participants, session tokens, team name or votes remain. The marker lasts seven days from the original expiry, then another alarm deletes it. Every subsequent operation also checks expiry, so delayed alarms cannot revive rooms or extend marker retention. Expired room IDs cannot be recreated through the public API.

## Screens and round behavior

The entry page contains the welcome screen, Create room form and Join existing room form. Player/team names are prefilled and editable. Team name is optional; an omitted, empty or whitespace-only value uses Sprint Wizards. Player names remain required. A pasted invite must point to this origin's room page. Guests see the team name before joining; returning members recover their seat directly.

New rooms begin in a waiting phase. The host sees Invite your team when alone; Start voting appears after at least one guest joins. The server rejects starting with fewer than two participants; guests see Waiting for voting to start. Starting opens the card picker for everyone. Reveal cards is disabled until at least one participant has voted, and the server rejects empty reveals in every round. Choosing a card closes the picker; clicking Your card opens it again. Selection changes are confirmed by server snapshots. Eight table seats, the host crown, voted status and invitation popover follow the Figma layouts, with a wrapping layout on small screens.

The five-minute countdown is based on the server's persisted round start time. It survives refresh/reconnect and requires no server-side ticking, preserving WebSocket hibernation. At zero, it displays a time-up message; voting remains open until the host manually reveals. Vote again immediately opens a new round and resets the countdown and cards. Older rooms keep their votes and seats; their unknown start time is shown without a timer until their next round.

Revealed unanimous votes show a consensus message and a short CSS confetti animation (disabled for reduced-motion preferences). Mixed votes show their average and percentage distribution. Percentages use submitted votes; participants who did not vote remain visible and do not contribute to the average. A no-vote round has its own message. Results never inspect private server state: they use only revealed snapshots.

The default deck is `0, 1, 2, 3, 5, 8, 13, 21, 34`. The 19 supplied Figma exports in `public/assets/` are used for card faces, home decorations, team/invite/host/consensus icons and recovery states. The unselected-card export contains labels, so its displayed image is clipped to the card while HTML provides the current accessible labels. **Memes remains disabled by the owner's choice**, with its exported preview shown. The spinner uses CSS rotation; consensus uses CSS confetti and respects reduced motion.

Poppins, Lobster and Alfa Slab One currently load from Google Fonts with `display=swap`, as approved by the owner. A TODO in `Layout.astro` calls for downloading licensed WOFF2 files and switching to local hosting. Fonts fall back gracefully if the external requests fail. Primary buttons use white text on a darker purple for contrast.

Forms use inline required/length errors instead of browser tooltips. Invite errors distinguish empty, non-link, foreign-site and malformed input. Request failures preserve entered values and offer readable retry guidance. Missing rooms offer Join another room, which opens the invite form directly. For seven days after expiry, fresh visits receive HTTP 410 and a Room expired screen. Unknown rooms, rooms whose markers have been deleted, and rooms deleted before markers were implemented receive HTTP 404 with the combined invalid-or-expired message. Live expiry socket closes also identify an expired room.

Keyboard activation moves focus from Start/Vote again to the first card, and from Reveal to the results heading. Reopening the picker focuses the selected card. On phones, the table and card controls appear before the participant list so every voting option is immediately reachable. Long participant names are visually truncated with full accessible text and hover titles.

Manual acceptance: create a named team, paste its invite through Join room, join as a guest, try voting before Start, start as host, choose/change a card, refresh, reveal differing votes, vote again with matching votes, and check consensus. Check keyboard navigation, invite copy/Escape, a narrow viewport, and offline/reconnect feedback. At five minutes the timer stops without automatically revealing.

## Deployment (owner only)

Sign in to a Cloudflare account with Workers enabled. The Workers Free plan supports this SQLite-backed Durable Object configuration. From the repository root, authenticate and verify the selected account before deploying:

```sh
npx wrangler login
npx wrangler whoami
npm test
npm run check
npm run deploy
```

`npm run deploy` builds Astro and deploys the Worker plus `dist/` assets. The first deployment provisions the `PokerRoom` namespace through migration `v1` and connects the `ROOMS` binding automatically. Room instances and their SQLite storage are created on demand. No D1 database, KV namespace, Pages project, cron job or application secrets are needed. Keep the existing migration tag on subsequent deployments.

Use the HTTPS `workers.dev` URL printed by Wrangler. If this is your first Worker, complete the account's `workers.dev` subdomain setup when prompted. Check create/join/vote/reveal with a normal and private browser window; local rooms are not copied into production. A custom domain and GitHub-triggered deployments can be configured later. Pushing this repository alone does not deploy it.

References: [Cloudflare CLI setup](https://developers.cloudflare.com/workers/get-started/guide/) and [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

The single Worker config includes `new_sqlite_classes: ["PokerRoom"]`, compatible with SQLite Durable Objects on Workers Free. Deployment creates the namespace/migration; there is no separate database to provision. Review Cloudflare quotas before public use. This PoC has room/socket/body limits, but no account-based abuse controls or global creation rate limit.

The compatibility date is `2026-07-15`, supported by the runtime bundled with the pinned Wrangler 4.110.0. A compatibility date selects runtime behavior; it does not need to match today's date. Update it only alongside a runtime that supports it.

## Verification status in this workspace

Astro **7.4.12** is installed and locked. The current report fixes pass:

```sh
npm test
ASTRO_TELEMETRY_DISABLED=1 npm run check
ASTRO_TELEMETRY_DISABLED=1 npm run build
```

All fourteen tests pass; type checks have zero errors/warnings; both static pages build. The room module plus imported shared chunks total **10,667 raw JavaScript bytes**, or **4,315 bytes summed gzip**, counting each file once. This excludes CSS, fonts and images. No framework size comparison is claimed.

The Worker dry run also passed without deployment:

```sh
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/poker-wrangler-check.log npx wrangler deploy --dry-run --outdir /tmp/poker-worker-check
```

The external desktop validation report confirmed all nine tests from the previous revision and the live HTTP/WebSocket suite, including solo-start and empty-reveal rejection, optional team naming, private votes, host authorization and reconnect recovery. The agent's latest `npm run test:local` attempt remains blocked by sandbox localhost `EPERM`. The new expiry handling is covered by automated handler tests, but has not been exercised against real Wrangler alarms.

The agent visually exercised this revision in Safari using normal and private windows: create and join, two independent seats, changed votes, mixed results (8 and 5 → 6.5), next round and refresh restoring the saved 8. Reopening the picker and pressing Enter kept 8 selected; keyboard Reveal moved focus to the results heading. Required-name and empty/non-link invite errors and the missing-room → Join another room path were checked. The Google fonts and exported artwork rendered. At 1440 × 900 the complete results card and saved-vote label fit; all nine voting cards fit without scrolling at 320 × 568 and 390 × 844. Participants may require scrolling on the shortest phone viewport. Final small changes to error-alert styling and accessible labels were build/type checked after that visual pass.

The latest Safari pass at 1280 × 720 confirmed the full expanded deck, selected card and acceptance message fit without scrolling, as does the results screen. A height-specific desktop rule reduces avatars, card sizes and spacing while preserving the wider desktop and phone layouts. Reconnect now explicitly focuses the restored room heading after closing its dialog, instead of attempting to restore a previously disabled control or the document body.

The recovery dialog's forced-outage/manual-retry flow still needs a browser retest: available native Safari controls did not provide a usable tab-scoped outage simulation. HTTP failure copy is covered by automated checks. Exact animation timing, physical phones, screen-reader speech, forced Durable Object hibernation and real alarm delivery remain unverified. The elapsed countdown was observed at 0:00 with manual reveal still available; precise five-minute timing was not measured. Exact Figma pixel fidelity is not claimed.

A local Git repository exists on `main`. The intended remote is [TodorKarparov/planning-poker](https://github.com/TodorKarparov/planning-poker). Publishing remains pending: this workspace blocks local Git writes, and the GitHub connector write was cancelled. Nothing was deployed to Cloudflare by the agent.

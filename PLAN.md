# TS6 Manager — Bot Improvements Roadmap

A living plan for improving the music/voice bot and the automation engine.
This is **intentionally free of private/operational details** (no server
hostnames, IPs, credentials, channel IDs, or domain names) so it can live in
the public repo. Where a feature needs runtime configuration, the variable
names are documented but real values are left to the operator.

---

## Status legend

- **[ ]** not started
- **[~]** in progress
- **[x]** done
- **[x+]** done and deployed in a live setup

---

## 1. Auto-stop playback when the channel is empty (sinusbot-style)

**Goal:** When the bot is playing and the channel has no real listeners for a
configurable grace period, stop playback automatically. Query clients and the
bot itself do not count as listeners.

**Status:** [x+] implemented (`ba8871a`).

### Implementation

- `Ts3Client` now tracks channel membership from the voice connection's
  `notifycliententerview` / `notifyclientleftview` / `notifyclientmoved`
  events. It keeps two sets:
  - `channelMembers` — real users (client_type 0) in the bot's current channel
  - `queryMembers` — ServerQuery clients (client_type 1), excluded from the count
  - Exposes `getChannelUserCount()` = real users present.
- `VoiceBot` starts a poll timer when playback begins. Every 5s it checks the
  count; if the channel has been empty for `autoStopEmptySeconds`, it calls
  `stopAudio()` and emits `autoStop`.

### Configuration

- Env var: `BOT_AUTO_STOP_EMPTY_SECONDS` (seconds, default `300` = 5 min,
  `0` = disabled). Read in `VoiceBotManager` and applied to every bot's
  `VoiceBotConfig.autoStopEmptySeconds`.

### Pitfalls (learned the hard way)

1. **The bot's own connection is the source of truth for occupancy**, not the
   WebQuery API. The voice client subscribes to its channel and sees
   enter/left/moved events natively — no polling of `clientlist` needed.
2. **A regular voice client only sees events for its own (subscribed)
   channel.** If the bot is moved via the flow engine (WebQuery `clientmove`),
   the bot's connection emits `notifyclientmoved` for itself — the handler
   MUST update `currentChannelId` and reset both member sets, or the count
   goes stale after a flow-driven move.
3. **`client_type` matters.** ServerQuery clients and the bot's own voice
   connection are `client_type=1`; real users are `client_type=0`. Count only
   `0`, and always exclude the bot's own `clid`.
4. **Do not let a poll failure take down playback.** The 5s interval wraps its
   body in try/catch so a transient error can't crash the audio pipeline.

---

## 2. Fix fatal-error handling — 2568 is NOT fatal

**Goal:** Stop the bot being permanently killed by a permission hiccup.

**Status:** [x+] implemented (`ba8871a`).

### The bug

`TS3 error 2568` is **"insufficient client permissions"** — an operation-level
error (e.g. moving into a channel the bot lacks power for). The code treated
it as fatal (alongside the comment claiming it was "invalid password"),
calling `fatalError`, setting status to `error`, and **refusing to reconnect**.
Any transient permission issue permanently killed the bot.

### The fix

Only genuinely fatal, non-recoverable errors stop the bot:

- `3329` — banned
- `1796` — max clients reached

`2568` is now surfaced as a normal error and the bot may reconnect. Fixed in
two places (must stay in sync):
- `packages/backend/src/voice/tslib/client.ts` — the low-level client must not
  `disconnect()` on 2568.
- `packages/backend/src/voice/voice-bot.ts` — must not emit `fatalError` on
  2568.

### Pitfalls

1. **The comment was wrong and misled debugging for a long time.** Verify the
   meaning of a TS3 error code before classifying it as fatal. Error 2568 is
   permissions, not password.
2. **The same classification exists in two files** (the voice client and the
   bot wrapper). If you change one, change the other — a mismatch leaves a
   path where the client still tears down the socket.

---

## 3. Bot group permissions — joining channels

**Goal:** The bot must be able to join its configured default channel (and
channels users listen in) on connect, and be movable by normal users.

**Status:** [x+] resolved operationally.

### What the bot needs (server group permissions)

- `b_channel_join_permanent = 1`
- `b_channel_join_semi_permanent = 1`
- `b_channel_join_temporary = 1`
- `i_channel_join_power` (e.g. 50)
- `i_client_move_power` (e.g. 10) + `i_client_needed_move_power` (0) so it can
  move itself, and so a normal user (with higher move power) can move it
- `i_client_talk_power` (e.g. 50)
- `b_client_channel_textmessage_send = 1` so it can reply in channel

### Pitfalls (the big one)

1. **`i_channel_join_power` alone is NOT enough to join a permanent channel.**
   TeamSpeak also requires the matching `b_channel_join_permanent` boolean. A
   bot with join power but no `b_channel_join_*` flag silently fails to join
   the channel and falls back to the server default channel on connect. This
   is exactly why "the bot doesn't move to its channel anymore" happened — the
   group had `i_channel_join_power` but not `b_channel_join_permanent`.
2. **"Why doesn't the bot join its default channel?"** Check, in order:
   - the group has `b_channel_join_*` for the channel's type,
   - the channel doesn't require a password the bot doesn't have,
   - the bot's `defaultChannel` is set in the DB/UI,
   - the auto-move in `handleChannelListFinished` actually fires (see below).
3. **`i_channel_needed_*_power` vs `i_client_*_power`:** the effective value is
   the max across all the client's groups. A low value in one group can be
   rescued by a higher value in another, and vice-versa — check the *effective*
   result, not a single group's value.

---

## 4. Auto-move to default channel on (re)connect

**Goal:** The bot should land in its configured channel whenever it connects
or reconnects.

**Status:** [x+] works once group join permissions are correct.

### How it works

- `clientinit` sends `client_default_channel` (server may honor it directly).
- `handleChannelListFinished()` in the voice client also issues a `clientmove`
  to the default channel once the channel list arrives. This is the reliable
  path.

### Pitfalls

1. **This only fires once per connect, after the channel list arrives.** If the
   connection is flapping (timeouts) or the bot never reaches
   `channellistfinished`, the auto-move never happens.
2. **A flow-engine cron job can override it.** If a "bot mover" flow moves the
   bot on a timer, it will override `defaultChannel` after connect. Decide
   which mechanism owns the bot's position — don't have both fighting.
3. **Diagnosing a "doesn't move" report:** first rule out permissions (§3),
   then confirm the connection is stable enough to reach `channellistfinished`.

---

## 5. Grace period before moving idle bots (BotMover flow)

**Goal:** An idle bot should not be yanked around too eagerly; give it (and
the channel) a grace period before a mover flow relocates it.

**Status:** [~] configured via flow, not code.

### Approach

The flow engine's `afkMover` action has an `idleThresholdSeconds` field. Set
it to the desired grace (e.g. 300 = 5 min). Use `exemptGroupIds` to prevent
the mover from relocating users who shouldn't be moved (e.g. the operator's
group), so it only targets the bot.

### Pitfalls

1. **A cron flow has no event data.** The old template wired a condition on
   `event.client_nickname` after a cron trigger — that condition is always
   false (cron passes `{}`), so the action never ran. Remove the condition and
   connect the cron trigger straight to the action, or use a real event
   trigger.
2. **`afkMover` moves everyone idle past the threshold**, not just the bot.
   Use `exemptGroupIds` for humans, or it will relocate users too.
3. **`idleThresholdSeconds` is per-action**, not global — set it on each mover
   action.

---

## 6. Dependency / CI health (pnpm audit gate)

**Goal:** CI passes the `pnpm audit --audit-level high` gate without shipping
known-vulnerable build-time deps.

**Status:** [x] resolved (`506f0dd`, `f88bb41`).

### What was wrong

- `nanoid@3.3.17` (pulled by postcss, a Vite build dep) — high advisory.
- `deepmerge-ts` (pulled by prisma) — high advisory.

### Fixes

1. `nanoid`: bumped the lockfile entry to the patched `3.3.18` (satisfies
   postcss's `^3.3.4`; the backend's direct `nanoid@^5` is untouched).
2. `deepmerge-ts`: added its GHSA to `pnpm.auditConfig.ignoreGhsas` (it's a
   build-time dep not shipped to production).

### Pitfalls

1. **A `package.json` `overrides` entry must exactly match the lockfile.**
   Adding an override without regenerating the lockfile causes
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on a `--frozen-lockfile` install.
2. **The lockfile also has an `overrides:` section that mirrors package.json.**
   If you add/remove an override, update BOTH or the frozen install fails.
3. **Scoped nested overrides** (`"postcss@^8": { "nanoid": "..." }`) throw
   `pref.startsWith is not a function` on some pnpm versions — use a plain
   global override keyed by package name instead.
4. **`auditConfig.ignoreGhsas` only affects audit, not install** — safe to
   change without touching the lockfile. This is the preferred place to silence
   build-time-only advisories.
5. **Don't try to regenerate the lockfile on a box without the project's
   toolchain.** It needs Node 22+ and pnpm 9, plus native build tools for
   `ssh2`/`prisma` (node-gyp needs `make`). If the environment lacks these,
   hand-edit the lockfile carefully instead.

---

## 7. (Idea) Invalid-command resilience

**Goal:** A malformed command (e.g. `!play` with garbage that isn't a URL)
should reply with a friendly error, never take down the bot.

**Status:** [ ] not yet a dedicated change.

### Notes

- `handlePlay` already guards non-URL input and wraps `downloadAndEnqueue` in
  try/catch, so the *reply* path is safe.
- The historical "crash" was actually §2 (2568 misclassification), not the
  command parsing. Re-verify after §2 is deployed before assuming more work is
  needed.

### Pitfalls

- yt-dlp failures surface as rejects; always catch around any `runYtDlp`
  caller. Check `lastErrorLine` in `audio/youtube.ts` — the actionable message
  is on the ERROR line, usually the last one.

---

## 8. (Idea) Frontend setting for auto-stop

**Goal:** Expose `autoStopEmptySeconds` in the Music Bot UI instead of an env
var only.

**Status:** [ ] not started.

### Approach

Add a per-bot DB field (e.g. `autoStopEmptySeconds`) + a number input on the
Music Bot settings page, wired through `VoiceBotConfig`. Fall back to the env
var / default when unset.

### Pitfalls

- The MusicBot model and the create/update API must both carry the new field.
- Keep the env-var default as the fallback so existing bots don't change
  behaviour until the operator opts in.

---

## Notes for contributors / agents

- Read `AGENTS.md` for the repo conventions before editing.
- The two files that classify fatal TS3 errors MUST be edited together
  (§2).
- Occupancy/auto-stop state lives in `Ts3Client` and is consumed by `VoiceBot`
  (§1).
- Keep this file free of private/operational values (hostnames, IPs,
  credentials, channel IDs, domains).

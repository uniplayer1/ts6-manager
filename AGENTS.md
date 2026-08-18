# AGENTS.md — conventions for AI agents working on this repo

Guidance for coding agents (and humans) making changes to the TS6 Manager
codebase. This is intentionally free of private/operational values — no server
hostnames, IPs, credentials, channel IDs, or domain names. Where a runtime
value is needed, the variable name is documented; the operator supplies the
value.

Cross-reference: `PLAN.md` (bot-improvement roadmap + pitfalls), `README.md`
(product overview), `docs/` (per-area documentation).

---

## Project shape

- Monorepo: `packages/common`, `packages/backend`, `packages/frontend`,
  `packages/sidecar` (Go).
- Package manager: **pnpm 9** (workspaces). Node **>=22**.
- Backend: TypeScript, Express, Prisma (SQLite), a custom TeamSpeak 3 voice
  client (`packages/backend/src/voice/tslib/`).
- Frontend: React + Vite.
- Sidecar: Go (WebRTC video relay).
- CI (`.github/workflows/ci.yml`): lint/typecheck/test/build, Go sidecar
  vet+build, and Docker image build+push for `backend`/`frontend`/`sidecar`.

---

## Build / test commands

```bash
pnpm install --frozen-lockfile   # install (CI uses frozen)
pnpm build                       # build all packages
pnpm lint                        # eslint
pnpm typecheck                   # tsc
pnpm test                        # vitest
```

> Building locally requires Node 22+ and pnpm 9, plus native build tools for
> `ssh2`/`prisma` (node-gyp needs `make`). See `PLAN.md` §6 for lockfile
> pitfalls if the toolchain is missing.

---

## Conventions

1. **TypeScript strict.** Follow existing patterns; add types; avoid `any`
   unless the surrounding code does.
2. **Tests** for pure logic (parsers, permission helpers, crypto). Not every
   change needs a test, but behavioural changes to bot state should be.
3. **Keep this repo free of private/operational data.** Never commit:
   hostnames, IPs, credentials, channel IDs, server names, or domain names.
   Runtime values belong in environment variables / config, referenced by name
   only.
4. **Fatal TS3 error classification lives in TWO files** that must be edited
   together:
   - `packages/backend/src/voice/tslib/client.ts` (low-level client)
   - `packages/backend/src/voice/voice-bot.ts` (bot wrapper)
   See `PLAN.md` §2. Only truly fatal codes (banned, max-clients) should
   disconnect/stop the bot; operation-level errors (e.g. insufficient
   permissions) must not.
5. **Voice occupancy / auto-stop state** lives in `Ts3Client`
   (`channelMembers`/`queryMembers`, `getChannelUserCount()`) and is consumed
   by `VoiceBot`. When the bot is moved by the flow engine, the client's
   `notifyclientmoved` handler updates `currentChannelId` and resets the
   member sets — keep that in sync. See `PLAN.md` §1.
6. **Environment-driven bot settings** default through `VoiceBotConfig`; the
   operator sets the value via env var (e.g. `BOT_AUTO_STOP_EMPTY_SECONDS`).
   Keep a sensible default so behaviour doesn't change unless opted in.

---

## Common pitfalls (short list)

- `pnpm-lock.yaml` has an `overrides:` section that must mirror `package.json`.
  Change both or the frozen install fails (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`).
- A `package.json` `overrides` entry without a matching lockfile update breaks
  CI. Prefer `pnpm.auditConfig.ignoreGhsas` for build-time-only advisories.
- `i_channel_join_power` is not enough to join a permanent channel — the client
  also needs `b_channel_join_permanent`. See `PLAN.md` §3.
- Cron-triggered flows receive no event data — don't write conditions on
  `event.*` after a cron trigger.

---

## Verifying changes

- Run `pnpm lint && pnpm typecheck && pnpm test` before pushing.
- CI builds and pushes Docker images on `main`. If you only changed docs, the
  audit/install steps still run — keep the lockfile and overrides consistent.
- For bot runtime changes, confirm the bot connects, joins its channel, plays,
  and the auto-stop behaves before declaring done.

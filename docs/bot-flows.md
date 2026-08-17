# TS6 Manager — Bot Flows (automation)

Bot Flows are the built-in automation engine of the TS6 Manager. They let you
react to TeamSpeak events, a schedule, a webhook, or a chat command by running
a chain of actions (kick/ban/move/message/HTTP/webquery/voice, …).

> This is the full reference for the **Bot Editor** UI (Bots → edit a flow). It
> covers every node type, the available variables, the expression language, and
> each action's fields. If something here doesn't match the UI, the UI is the
> source of truth for *labels*; this reflects the backend logic.

---

## 1. Concepts

A flow is a **graph of nodes and edges**:

- **Nodes**: `trigger`, `action`, `condition`, `delay`, `variable`, `log`.
- **Edges**: connect node A → node B. Condition nodes have two outputs
  (`true` / `false`).
- When a trigger fires, execution starts at that trigger node and walks the
  graph. **Loop protection**: a flow may visit at most **100 nodes** per
  execution before it aborts with `Max node visits exceeded`.

Every execution is recorded (status `running / completed / failed`), and each
step is logged to the execution log (viewable in the UI; the container logs
show the backend side).

---

## 2. Triggers (how a flow starts)

### 2.1 Event — `event`
React to a TeamSpeak ServerQuery notification.

| Event name | Meaning |
|---|---|
| `notifycliententerview` | Client connected |
| `notifyclientleftview` | Client disconnected |
| `notifyclientmoved` | Client moved channel |
| `notifyserveredited` | Server edited |
| `notifychanneledited` | Channel edited |
| `notifychanneldescriptionchanged` | Channel description changed |
| `notifychannelcreated` | Channel created |
| `notifychanneldeleted` | Channel deleted |
| `notifychannelmoved` | Channel moved |
| `notifychannelpasswordchanged` | Channel password changed |
| `notifytextmessage` | Text message received |
| `notifytokenused` | Privilege key used |

**Filters** (optional): key/value pairs that must match the event data, e.g.
filter on `client_type = 0` so the flow only fires for real users (not the
query bot).

### 2.2 Cron — `cron`
Runs on a schedule (standard 5-field cron, e.g. `* * * * *` = every minute).
Optionally set a **timezone** (default `UTC`); the `time.*` variables then
reflect that timezone.

### 2.3 Webhook — `webhook`
Expose an HTTP endpoint that external systems can call to trigger the flow.

- **Path**: anything after `/api/bots/webhook/` (see §8 for the URL).
- **Method**: `GET` or `POST`.
- **Secret**: **required.** Requests must pass it via the `x-webhook-secret`
  header or a `?secret=` query param. Missing/wrong secret → 404 (deliberate,
  to avoid endpoint enumeration).
- Exposed event variables: `event.webhook_path`, `event.webhook_method`,
  `event.webhook_body` (JSON string), `event.webhook_query` (JSON string).

### 2.4 Command — `command`
Trigger when someone types a chat command (e.g. `!support`).

- `commandPrefix` — default `!`.
- `commandName` — e.g. `support` → the user types `!support`.
- `channelId` — optional. If set, the flow only fires when the command is
  typed in that channel (a dedicated query bot is moved there to hear it). If
  unset, it reacts to server-wide events.
- Extra event vars: `event.command_args` (everything after the command, e.g.
  `!rank @user` → `@user`), `event.command_name`, `event.command_channel_id`.

### 2.5 Discord message — `discordMessage`
Triggers on a message in a linked Discord channel (`channelId`); optional
`prefix` to only fire when the message starts with it.

---

## 3. Variables (the templating system)

You insert `{{...}}` placeholders into any text field (messages, channel
names, HTTP bodies, command params). They are resolved at runtime.

### 3.1 Namespaces

| Prefix | Meaning | Persistence |
|---|---|---|
| `{{event.*}}` | Data from the triggering event | per-execution |
| `{{var.*}}` | **Persisted flow variables** (DB) | survives restarts |
| `{{temp.*}}` | Temporary vars set during this execution | per-execution |
| `{{time.*}}` | Current date/time | runtime |
| `{{exec.*}}` | Flow/execution metadata | per-execution |

**Nested dot access** works: `{{event.webhook_body.test}}` parses the JSON
body and reads `.test`; `{{temp.server.virtualserver_clientsonline}}` reads a
nested field of a stored object. `temp.*` values that are objects are
serialized to JSON when referenced as a whole.

### 3.2 `event.*` — available keys

Raw TeamSpeak query fields are passed through. Common ones (client events):
`clid`, `client_database_id`, `client_type`, `client_nickname`, `cid`
(channel), plus everything the ServerQuery notification carries. Command /
webhook triggers add the extra keys listed in §2.3/§2.4.

### 3.3 `time.*`

`hours`, `minutes`, `seconds`, `time` (`HH:MM`), `date` (`DD.MM.YYYY`),
`timestamp` (Unix seconds), `day`, `month`, `year`, `dayOfWeek` (0=Sunday).
Honors the cron trigger's timezone if set, else UTC.

### 3.4 `exec.*`

`flowId`, `executionId`, `configId`, `sid`, `triggerType`.

### 3.5 Filters (pipe)

Append `|filter` to a placeholder: `{{temp.server.virtualserver_uptime|uptime}}`.

| Filter | Effect |
|---|---|
| `uptime` | Seconds → `Xd Xh Xm` |
| `round` | Round a number |
| `floor` | Floor a number |

---

## 4. Expression language (conditions)

Condition nodes use a safe expression evaluator (replaces the vulnerable
`expr-eval`). Grammar:

- **Literals**: numbers, `'single'` / `"double"` strings, `true`, `false`.
- **Scope lookups with dot access**: `event.client_type == 0`,
  `var.counter > 5`, `temp.api.status == "ok"`.
- **Operators** (precedence low→high):
  `or` → `and` → `not` → `== != < <= > >=` → `+ -` → `* / %` → unary `-` → `^`.
- **Functions**:

| Function | Example |
|---|---|
| `contains(a, b)` | `contains(event.client_nickname, "admin")` |
| `startsWith(a, b)` | `startsWith(event.msg, "!")` |
| `endsWith(a, b)` | `endsWith(event.msg, "?")` |
| `lower(s)` | `lower(event.msg) == "hi"` |
| `upper(s)` | — |
| `length(s)` | `length(event.msg) > 10` |
| `split(s, sep, i)` | `split(event.command_args, " ", 0)` |

Notes: `==`/`!=` are strict; `and`/`or`/`not` coerce to boolean; unknown
top-level identifiers throw (a condition that errors evaluates to `false`).

---

## 5. Node types

| Node | What it does |
|---|---|
| `trigger` | §2. Always starts the flow. |
| `condition` | Evaluates `expression`; continues on the `true` or `false` edge. |
| `delay` | Waits `delayMs` (max **300 000 ms = 5 min**). |
| `variable` | Manipulate a persisted flow variable: `set`, `increment`, `append`. Fields: `variableName`, `value`, `operation`. |
| `log` | Write a message to the execution log. Level: `debug / info / warn / error`. |
| `action` | One of the actions in §6. |

---

## 6. Actions (the `action` node's `actionType`)

### 6.1 TeamSpeak client / server actions

| actionType | Fields | Effect |
|---|---|---|
| `kick` | `reasonId` (4=kick, 5=ban&kick), `reasonMsg` | Kick the triggering client. |
| `ban` | `duration` (0=permanent), `reason` | Ban the triggering client. |
| `move` | `channelId` | Move the triggering client to a channel. |
| `message` | `targetMode` (1=client, 2=channel, 3=server), `target`, `message` | Send a text message. For channel mode it temporarily moves the query bot. |
| `poke` | `message` | Poke the triggering client. |
| `channelCreate` | `params` (map, e.g. `channel_name`, `channel_topic`, `channel_flag_temporary=1`, …) | Create a channel. Sets `temp.lastCreatedChannelId`. |
| `channelEdit` | `channelId`, `params` | Edit a channel. |
| `channelDelete` | `channelId`, `force` | Delete a channel. |
| `groupAddClient` | `groupId` | Add the triggering client to a server group. |
| `groupRemoveClient` | `groupId` | Remove the triggering client from a group. |
| `pokeGroup` | `groupId`, `message` | Poke all online members of a group. Sets `temp.pokedCount`. |
| `afkMover` | `afkChannelId`, `idleThresholdSeconds` (default 300), `exemptGroupIds` (comma list) | Move idle clients to the AFK channel. Sets `temp.afkMovedCount`. |
| `idleKicker` | `idleThresholdSeconds` (default 1800), `reason`, `exemptGroupIds` | Kick idle clients. Sets `temp.idleKickedCount`. |
| `rankCheck` | `ranks` (JSON) | Auto-promote based on online time. Ranks: `[{"hours":10,"groupId":"7"},{"hours":50,"groupId":"8"}]`. Reads `var.onlinetime_<cldbid>` (accumulate via cron). Sets `temp.rankPromotedCount`. |
| `tempChannelCleanup` | `parentChannelId`, `protectedChannelIds` (comma list) | Delete empty temp channels under a parent. Sets `temp.tempChannelsDeleted`. |

### 6.2 WebQuery (raw ServerQuery)

| actionType | Fields | Effect |
|---|---|---|
| `webquery` | `command`, `params`, `storeAs` | Run a **whitelisted** ServerQuery command; store the response in `temp.<storeAs>`. Supports inline params in the command string, e.g. `clientinfo clid={{event.clid}}`. |

**Allowed commands** (everything else is rejected): `serverinfo`, `serverlist`,
`servergrouplist`, `servergroupsbyclientid`, `channellist`, `channelinfo`,
`channelfind`, `channelcreate`, `channeledit`, `channeldelete`,
`channelmove`, `clientlist`, `clientinfo`, `clientfind`, `clientgetids`,
`clientgetdbidfromuid`, `clientgetnamefromuid`, `clientgetnamefromdbid`,
`clientmove`, `clientkick`, `clientpoke`, `clientdblist`, `clientdbinfo`,
`sendtextmessage`, `messageadd`, `messagelist`, `messagedel`, `messageget`,
`servergroupaddclient`, `servergroupdelclient`, `servergroupclientlist`,
`channelgrouplist`, `channelgroupclientlist`, `setclientchannelgroup`,
`banclient`, `banlist`, `bandel`, `banadd`, `tokenadd`, `tokenlist`,
`tokendelete`, `complainlist`, `complaindel`, `complainadd`, `logview`,
`whoami`, `version`, `hostinfo`, `connectioninfo`.
> Destructive commands (serverstop, permissionreset, …) are **intentionally
> excluded** for security.

### 6.3 HTTP / webhook (outbound)

| actionType | Fields | Effect |
|---|---|---|
| `httpRequest` | `url`, `method`, `headers`, `body` (JSON), `storeAs` | Call an external API (SSRF-protected, no redirects). Response stored in `temp.<storeAs>` (auto-parsed if JSON). |
| `webhook` | `url`, `method`, `headers`, `body`, `storeAs` | Same as httpRequest but via the webhook action. |
| `discordSend` | `channelId`, `message` | Send a message to a Discord channel (via the Discord bridge). |

### 6.4 Voice (music bot control)

| actionType | Fields | Effect |
|---|---|---|
| `voicePlay` | `botId`, `playlistId` **or** `songId` | Queue + play on a music bot. |
| `voiceStop` | `botId` | Stop the bot. |
| `voiceJoinChannel` | `botId`, `channelId`, `channelPassword` | Move the bot to a channel (restarts it). |
| `voiceLeaveChannel` | `botId` | Leave (stops the bot). |
| `voiceVolume` | `botId`, `volume` (0–100) | Set volume. |
| `voicePauseResume` | `botId`, `action` (`pause`/`resume`/`toggle`) | Pause/resume. |
| `voiceSkip` | `botId`, `direction` (`next`/`previous`) | Skip track. |
| `voiceSeek` | `botId`, `position` | Seek to seconds. |
| `voiceTts` | `text`, `language` | **Placeholder — not implemented yet** (logs only). |

### 6.5 Other

| actionType | Fields | Effect |
|---|---|---|
| `generateCode` | `length` (1–12), `storeAs`, `numericOnly` | Generate a code/password, stored in `temp.<storeAs>`. |
| `animatedChannel` | `channelId`, `text`, `style`, `intervalSeconds`, `prefix` | Animate a channel name (scroll/typewriter/bounce/blink/wave/alternateCase). Lifecycle is managed by the engine. |

---

## 7. Built-in templates

The editor ships ready-made templates (Bots → New → gallery): **Clock Channel**,
**Online Counter**, **Server Stats**, **Animated Channel Name**, **Welcome
Message**, **Support System**, **Temp Channel Creator**, **Auto-Rank**,
**Last-Seen Tracker**, **AFK Mover**, **Idle Kicker**, **Bad Name Checker**,
**Group Protector**, **Webhook → Server Message**, **Webhook → Assign Group**,
**Webhook → Update Channel**, **Anti-VPN**.

They are a good starting point for understanding the syntax (e.g. Server Stats
shows `{{temp.server.virtualserver_clientsonline}}`, `{{time.time}}`,
`{{...|uptime}}`).

---

## 8. Webhook URL

The webhook trigger is exposed at:

```
POST/GET <your-manager-URL>/api/bots/webhook/<your-path>
```

with the secret as either:

```
x-webhook-secret: <secret>          # header
?secret=<secret>                    # query param
```

The webhook route (`/api/bots/webhook/*`) is **unauthenticated** — external
systems call it directly. It still requires the per-flow `secret`, so an
arbitrary caller can't trigger it.

---

## 9. Examples

**Welcome message when a user joins**
```
trigger: event notifycliententerview (filter client_type=0)
  → action message { targetMode: 1, message: "Welcome {{event.client_nickname}}!" }
  → action poke { message: "Type !support for help" }
```

**Auto-rank by online time (via cron)**
```
trigger: cron * * * * * (Europe/Berlin)
  → action rankCheck { ranks: '[{"hours":10,"groupId":"7"},{"hours":50,"groupId":"8"}]' }
  → log "Promoted {{temp.rankPromotedCount}} clients"
```
(Accumulate online time with a `Last-Seen Tracker` flow writing
`var.onlinetime_<cldbid>`.)

**Broadcast from an external webhook**
```
trigger: webhook path=announce method=POST secret=xxx
  → action message { targetMode: 3, message: "[Announcement] {{event.webhook_body.text}}" }
```

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Flow never runs | Check the trigger config: event name must match exactly; cron valid; webhook needs a secret; command needs the right prefix. |
| `Max node visits exceeded` | Infinite loop in the graph — add a `delay`/`condition` to break it. |
| `Condition ... → false` unexpectedly | Expression errored (e.g. undefined top-level var). The backend logs show the eval warning. |
| WebQuery action rejected | Command not in the whitelist (§6.2). Use a whitelisted command or combine with an HTTP action. |
| Webhook 404 | Wrong path, wrong method, or wrong/missing secret. |
| `storeAs` empty | The action didn't run or the response wasn't stored; check the execution log for that node. |
| Voice TTS does nothing | `voiceTts` is a placeholder, not implemented. |

See the main `README.md` for music-bot/yt-dlp specifics; this doc covers only
the flow engine.

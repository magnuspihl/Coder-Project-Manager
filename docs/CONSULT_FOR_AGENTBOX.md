# CPM Feature Consultation for agent-box

Authored: 2026-06-26. Read-only audit of the CPM codebase for the agent-box team.

---

## 1. Voice Chat

### Architecture overview

Voice has three independent layers that compose but do not depend on each other:

1. **STT** — two paths wired in parallel; the client picks based on what the user activates
2. **TTS** — three backends managed by a single hook with a fallback chain
3. **Session integration** — none; voice is 100% client-side presentation. The transcript just fills the text input and submits like a typed message.

### STT paths

**Path A — Continuous (Web Speech API)**  
`client/src/hooks/useVoiceMode.ts`

Uses `window.SpeechRecognition` / `window.webkitSpeechRecognition` (Chrome/Edge only). Keeps the mic open continuously, accumulates interim + final results, and calls `onSilenceTimeout(text)` after a configurable silence window (default 2000ms). Handles reconnection with up to 3 retries. This is the "voice mode" UX — hands-free, auto-submits on silence.

Fragile: Chrome-only; the `onend` reconnect loop can misfire on service errors; the `no-such-grammar`/`aborted`-vs-`not-allowed` error taxonomy is browser-dependent.

**Path B — Push-to-talk (in-browser Whisper)**  
`client/src/hooks/useVoiceRecorder.ts` + `client/src/utils/whisperSTT.ts` + `client/src/workers/whisperWorker.ts`

- Records via `MediaRecorder` with `audio/webm;codecs=opus`, 250ms timeslices
- On stop: assembles blob → `decodeAndResample()` (AudioContext → OfflineAudioContext, resamples to mono 16kHz Float32)
- Sends Float32Array to a Web Worker via `postMessage` with Transferable
- Worker loads `Xenova/whisper-tiny.en` from HuggingFace Hub via `@huggingface/transformers`
- Worker tries WebGPU with `dtype: 'fp32'` first (fp16/q4f16 produce NaN due to softmax overflow on some GPUs — hard-won lesson); falls back to `dtype: 'q8'` WASM
- Returns transcript text; worker is a singleton, model loaded once per page

Model is ~150MB, loaded on component mount (not on first click). Progress exposed via `onWhisperProgress()` pub/sub.

**Path C — Server-side Wyoming (optional)**  
`server/routes/stt.ts`

POST `/api/stt/transcribe` — accepts any audio file (via multer in-memory), converts to PCM 16kHz/16-bit/mono via ffmpeg (spawned as child process), then sends to a Wyoming protocol server over raw TCP socket. Wyoming is the Home Assistant STT protocol: JSON framing, `audio-start` / `audio-chunk` / `audio-stop` / `transcript` / `{text}` messages. Configured via `WHISPER_HOST` + `WHISPER_PORT` env vars. Disabled when not configured.

Fragile: requires ffmpeg on the CPM server, requires a Wyoming-protocol Whisper server (not the OpenAI API). The JSON parse loop is character-stream-based and can mis-frame on large payloads.

### TTS backends

`client/src/hooks/useTTSVoice.ts` manages all backends. Voice IDs are namespaced strings:

| Prefix | Backend | Mechanism |
|--------|---------|-----------|
| `kokoro:` | In-browser Kokoro TTS | Web Worker + WebAudio |
| `el:` | ElevenLabs cloud | `POST /api/tts/speak` → proxy |
| `qwen:` | Self-hosted Qwen3-TTS | `POST /api/tts/qwen/speak` → proxy |
| `br:` | Browser native | `SpeechSynthesisUtterance` |

**Kokoro** (`client/src/utils/kokoroTTS.ts`, `client/src/workers/kokoroWorker.ts`):  
Web Worker singleton. `getKokoroPipeline()` returns a `KokoroHandle` that streams `{ audio: Float32Array, samplingRate }` chunks back via worker messages. The hook buffers all chunks, then schedules them as `AudioBufferSourceNode`s on an `AudioContext` with gapless timing (`nextStart += buf.duration`). Same fp32 WebGPU patch as Whisper to avoid NaN. The AudioContext is tied to a ref so `stopCurrent()` can close it mid-playback.

**ElevenLabs** (`server/routes/tts.ts:90`):  
Server proxy. Calls `https://api.elevenlabs.io/v1/text-to-speech/<id>`, returns `audio/mpeg`. Client plays via `new Audio(objectURL)`. Text capped at 5000 chars.

**Qwen3-TTS** (`server/routes/tts.ts:186`):  
Server proxy to self-hosted container (env: `QWEN_TTS_URL`). Contract: `GET /voices`, `POST /warmup`, `POST /speak {text, voice_id, language}`. Returns `audio/wav`. Client pre-warms on voice mode enable via `POST /api/tts/qwen/warmup`. Cold-start timeout is 60s (model loads on demand on the remote box).

**`speakAs(text, msgId, voiceIds[])`**:  
Accepts a priority-ordered list of voice IDs and falls through to the next on error. Always appends the user's global `selectedId` as the final fallback. Used by workspace-level voice assignment features.

### What's reusable vs CPM-specific

- The **three-backend TTS hook** pattern (namespaced IDs, fallback chain) is directly portable.
- The **Web Worker Whisper** (paths A + B) is generic browser code; zero CPM coupling.
- The **Wyoming STT server** requires deploying a Wyoming-compatible STT service. Not trivially portable.
- Session integration is the simplest thing: transcript → text field → normal submit. Nothing to replicate.

---

## 2. File Uploads

### Flow

```
UI (drag/drop or picker)
  → POST /api/uploads  (multer disk storage)
  → returns: [{ id, filename, original_name, mime_type, size, task_id: null }]
  → UI stores attachment IDs in local state

User submits task/reply with attachmentIds[]
  → POST /api/workspaces/:ws/tasks   { prompt, attachmentIds: ["uuid1", ...] }
  → or POST /api/tasks/:id/reply     { message, attachmentIds: ["uuid1", ...] }
  → server calls linkAttachmentsToTask(ids, taskId)
       → UPDATE attachments SET task_id = ? WHERE id = ? AND task_id IS NULL

At task launch (claude.ts:1031):
  → getAttachmentsByTask(taskId)
  → transferFilesToWorkspace(workspaceName, attachments, /tmp/cpm-attachments-<taskId>)
  → for each file: coder ssh <ws> -- head -c <size> > <remotePath>
  → prompt += "\n\nReference files have been provided...\n- /tmp/path1\n- /tmp/path2"
  → claude CLI receives the absolute remote paths in the prompt text
```

### Key code locations

- Upload endpoint + `linkAttachmentsToTask()`: `server/routes/uploads.ts:35`
- File transfer + prompt injection: `server/services/claude.ts:1031–1048`
- `transferFilesToWorkspace()`: `server/services/claude.ts:733`
- Schema: `server/db/schema.sql` → `attachments` table

### Schema

```sql
attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT,              -- NULL until linked; FK to tasks
  filename TEXT NOT NULL,    -- uuid + ext (on CPM server)
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL -- absolute path on CPM server: data/uploads/<uuid>.<ext>
)
```

### Important details

- Files live in two places: CPM server (`data/uploads/`) and the workspace (`/tmp/cpm-attachments-<taskId>/`). No cleanup happens on either side until the task is hard-deleted (cascades in SQLite; workspace `/tmp` is ephemeral on container restarts).
- `task_id IS NULL` guard prevents re-linking if the same attachment ID is submitted twice.
- Transfer uses `head -c <size>` not `cat` — `coder ssh` does not propagate stdin EOF reliably, causing indefinite hangs. This was a fragile bug that cost time to diagnose.
- Files are re-transferred on every resume (not just first launch) because `getAttachmentsByTask` is called unconditionally. This is harmless (idempotent overwrite) but wasteful for large files across many resumes.
- The UI uploads before task creation, so the task's prompt text doesn't contain filenames — the paths are injected dynamically at launch time. This means searching the `messages` table for file paths won't find them.

### What's reusable

The pattern is generic: upload → persist on app server → transfer to agent environment at launch time → inject paths into prompt. The `head -c <size>` trick for SSH stdin is the one non-obvious piece worth carrying over.

---

## 3. Inter-participant / Multi-agent Conversations

This is the most architecturally interesting feature. The full implementation spans `server/db/schema.sql`, `server/services/tasks.ts:567–721`, and `server/services/claude.ts:2663–2728`.

### Data model

**Single shared message log.** All speakers — the host task agent and every invited participant — write to the same `messages` table. Speaker identity is encoded on each row:

```sql
-- Core columns defined in server/db/schema.sql (messages table)
-- participant_id added via ALTER TABLE migration: server/db/index.ts:118
messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,           -- FK to tasks
  role TEXT CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  participant_id TEXT,             -- NULL = host; UUID = task_participants.id for guests
                                   -- (added by migration, not in schema.sql)
  username TEXT,                   -- display name
  cost REAL,
  turn_id TEXT,                    -- FK to task_turns (auto-review only)
  created_at TEXT
)
```

**Participant registry:**

```sql
task_participants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,           -- FK to tasks
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  claude_session_id TEXT,          -- each participant's own session UUID
  project_dir TEXT,                -- working directory detected on first launch
  status TEXT CHECK (status IN ('active', 'removed'))
)
```

Every participant gets its own `claude_session_id` assigned at `addTaskParticipant()` time (`tasks.ts:570`). The host task's session lives on `tasks.claude_session_id`.

### Session continuity per agent

Each participant maintains independent Claude session state:

- **First launch**: `--session-id <participant.claude_session_id>` (creates fresh session on the participant workspace under `~/.claude/projects/`)
- **Subsequent launches**: `--resume <participant.claude_session_id>` (after verifying the `.jsonl` file exists on the workspace via `find ~/.claude/projects/`)
- The session UUID is permanent for the participant's lifetime (no reset mechanism).

The host uses the same logic as regular tasks (`session_initialized` flag, existence check, worktree-path session copy).

### How speakers are tracked

Every `addMessage()` call carries an optional `participantId`. In the UI and API, messages with `participant_id IS NULL` are attributed to the host; messages with a non-null `participant_id` are attributed to that participant's `workspace_name`.

The `messages.username` column is the denormalized display name (populated from `participant.workspace_name` at write time in the polling loop, `claude.ts:2888`).

### Turn/speaker sequencing — event-driven, not locked

There is **no round-robin or mutex-based turn order**. The system uses a mention-based event propagation:

1. Any agent (host or participant) emits `[MENTION:workspace_name]` anywhere in its response text.
2. `parseTaskMentions(task, text, sourceParticipantId)` (`claude.ts:2675`) is called on every message written to the log.
3. It resolves the mention to either the host or a participant and fires `triggerTaskHostCatchUp()` or `triggerTaskParticipantCatchUp()`.
4. Catch-up fires only if the target agent is **idle** (not currently running) and has **unseen context** (the context builder returns non-empty).

This means multiple agents can be running concurrently — there is no global lock on who speaks. Deadlocks don't happen because the catch-up trigger checks `isTaskParticipantRunning()` / `task.status !== 'awaiting_feedback'` before firing.

### Catch-up context building

`buildTaskParticipantContext(taskId, participantId)` (`tasks.ts:606`) is the core function. It computes a delta of conversation messages the target agent hasn't seen yet:

```
floor = max(agent's join time, last own assistant message time)
msgs  = all messages WHERE created_at > floor
      → filter out agent's own assistant messages (already in its Claude session)
      → drop the last user message directed at this agent (will be the -p prompt)
```

The context is formatted as a fenced block:
```
[TASK CONTEXT: ...role-specific header...]
[User]: <content>
[HostWorkspaceName]: <content>
[ParticipantWorkspaceName]: <content>
[END CONTEXT]
Agents in this task: host, p1, p2. To direct a message to another agent, include [MENTION:workspace_name]...
```

This block is **prepended to the `-p` prompt text**, not sent as a system message or injected via `--append-system-prompt`. The Claude CLI receives it as the first part of the user-turn text.

### 3A. Turn-taking / speaker selection — what actually exists

> **Correction:** CPM's turn-taking is simpler (and less automatic) than described in the brief. There is no `@mention` syntax, no "redirect message to participant X" targeting primitive, and no end-of-conversation broadcast pass. Here is what the code actually does.

#### The one mechanism: `[MENTION:workspace_name]`

Every agent response is scanned for `[MENTION:workspace_name]` tags immediately after the message is written to the log. This is the only automatic turn-passing mechanism.

```
agent emits text containing [MENTION:some-workspace]
  ↓
parseTaskMentions(task, text, sourceParticipantId)   // claude.ts:2675
  ↓ for each mentioned name:
  if name == task.workspace_name and source is a participant
    → triggerTaskHostCatchUp(task.id, TASK_MENTION_NUDGE)    // claude.ts:2707
  else if name matches a task_participants row
    → triggerTaskParticipantCatchUp(task.id, target.id, TASK_MENTION_NUDGE)  // claude.ts:2720
```

`TASK_MENTION_NUDGE = '[You were mentioned by another agent in this task. Review the conversation above and respond.]'` (`claude.ts:2668`)

`TASK_CATCHUP_NUDGE = '[Catch up on the task conversation above. Other agents may have responded, or the user may want your input. Continue the discussion or task as appropriate.]'` (`claude.ts:2665`)

The catch-up trigger prepends `buildTaskParticipantContext()` to the nudge string and passes that as the `-p` prompt for the next Claude invocation — so the agent receives the full conversation delta as text before the nudge instruction.

`parseTaskMentions()` is called in two places:
- After each `assistant` turn event during host task polling: `claude.ts:1721` (sourceParticipantId = `null`)
- After each `assistant` block and `result` event during participant polling: `claude.ts:2891`, `2910` (sourceParticipantId = the participant's UUID)

#### "Direct targeting" of a specific participant

Agents direct messages at each other purely through the `[MENTION:]` tag in their response text. The system tells every agent at the end of their catch-up context block: `"To direct a message to another agent, include [MENTION:workspace_name] at the end of your response"` (`tasks.ts:700`). There is no API-level "send message to participant X" primitive from one agent to another — only the human user has that (via `POST /tasks/:taskId/participants/:participantId/message`, `tasks.ts:652`).

When the user uses that API endpoint, the message is stored in `messages` with `participant_id` set to the target participant's ID (`tasks.ts:679`), then `launchTaskParticipant()` is called for that specific participant. The host is not notified.

#### "End-of-conversation everyone reacts" pass — does not exist

**There is no broadcast at conversation end.** When a host turn completes and the task transitions to `awaiting_feedback`, nothing automatically wakes up all participants. The only events that trigger participant catch-ups are:

1. An explicit `[MENTION:workspace_name]` tag in a message.
2. A human-initiated nudge via `POST /tasks/:taskId/participants/:participantId/catchup` (or the host equivalent `POST /tasks/:taskId/catchup`).

If the host's final turn contains no `[MENTION:]` tags, participants receive no automatic notification. They only speak again if the user explicitly nudges them or if someone mentions them.

#### Concurrency guard

`triggerTaskParticipantCatchUp()` skips the launch if `isTaskParticipantRunning(participantId)` returns true (`claude.ts:2725`). Multiple participants can run simultaneously; there is no global lock between participants. The host is gated separately — `triggerTaskHostCatchUp()` only fires if `task.status === 'awaiting_feedback'` (`claude.ts:2710`), preventing a participant from re-triggering the host while it is still working.

---

### 3B. Model-agnostic participants — what actually exists

> **Correction:** CPM does not currently support per-participant model configuration. All participants use the same Claude CLI backend. There is no provider abstraction for participants.

#### What the data model stores

The `task_participants` table (`schema.sql:163`) has these columns:

```
id, task_id, workspace_id, workspace_name,
claude_session_id, project_dir, status, created_at
```

**No `model` column. No `provider` column.** The `model TEXT` column exists on `tasks` (schema.sql:27, migration `db/index.ts:101`) and on the legacy `discussions` table (migration `db/index.ts:110`), but it was never added to `task_participants`.

#### What participants actually use

`launchTaskParticipant()` (`claude.ts:2740–2835`) always builds a `claude` CLI command:

```ts
const claudeParts: string[] = ['claude'];
claudeParts.push('-p', shellEscape(prompt));
// --resume or --session-id based on prior session existence
claudeParts.push('--output-format', 'stream-json', '--verbose');
claudeParts.push('--allowedTools', ...);
claudeParts.push('--max-turns', MAX_TURNS);
```

No model flag is passed — the participant inherits whatever the `claude` CLI's default model is on the participant workspace. The `tasks.model` field (used by the host to pass `--model` to its own invocation) has no equivalent for participants.

#### Implications for agent-box

CPM's participant system is a uniform "all Claude CLI" design. If agent-box needs heterogeneous backends (one participant uses Gemini, another uses GPT-4), you would need to:

1. Add a `model TEXT` and/or `provider TEXT` column to whatever participant table you create.
2. Branch in the launch function based on `provider` to invoke a different binary/API.
3. Ensure the output format is normalized so the polling loop can consume it regardless of provider.

CPM's current polling loop (`startTaskParticipantPolling`, `claude.ts:2858`) is tightly coupled to the Claude `stream-json` format — it looks for `event.type === 'assistant'`, `event.type === 'result'`, `event.type === 'rate_limit_event'`. A different backend would need to emit the same JSON schema or you'd need a translation layer.

---

### What's reusable vs CPM-specific

**Directly reusable:**
- Single shared message log with `participant_id` discriminator column — cleanest part of the model.
- Per-participant `claude_session_id` field — assign UUID at invite time, pass `--session-id` first time, `--resume` after.
- Delta-context builder (messages since own last message, excluding self) — generic, no CPM dependencies.
- `[MENTION:]` convention — any parseable token works; this one is readable.

**CPM-specific / requires adaptation:**
- `triggerTaskHostCatchUp()` routes through `resumeTask()` which holds the workspace lock and respects `max_concurrent`. agent-box needs equivalent queue machinery.
- Participant processes run as `coder ssh <workspace>` child processes. Transport is SSH-to-Coder.
- The participant polling loop (`startTaskParticipantPolling`) is coupled to the Claude `stream-json` format.
- The `discussion_participants` / `discussions` tables are a legacy predecessor — migrated into `task_participants` / `tasks`. Ignore the `discussion_*` tables.

### Key file:line pointers

| What | Where |
|------|-------|
| `task_participants` schema | `server/db/schema.sql:163` |
| `messages.participant_id` migration | `server/db/index.ts:118` (ALTER TABLE; column not in schema.sql) |
| `addTaskParticipant()` | `server/services/tasks.ts:569` |
| `buildTaskParticipantContext()` | `server/services/tasks.ts:606` |
| `buildTaskMentionInstruction()` | `server/services/tasks.ts:710` |
| `parseTaskMentions()` | `server/services/claude.ts:2675` |
| `TASK_CATCHUP_NUDGE` / `TASK_MENTION_NUDGE` | `server/services/claude.ts:2665`, `2668` |
| `triggerTaskHostCatchUp()` | `server/services/claude.ts:2707` |
| `triggerTaskParticipantCatchUp()` | `server/services/claude.ts:2720` |
| `launchTaskParticipant()` | `server/services/claude.ts:2740` |
| Host catch-up injection at launch | `server/services/claude.ts:1005–1013` |
| `parseTaskMentions` called (host) | `server/services/claude.ts:1721`, `1737` |
| `parseTaskMentions` called (participant) | `server/services/claude.ts:2891`, `2910` |
| Participant invite API | `server/routes/tasks.ts:595` |
| User-to-participant message API | `server/routes/tasks.ts:652` |
| Participant message written to log | `server/services/claude.ts:2888` |
| `task_participants` — no model column | `server/db/schema.sql:163–175` |
| `tasks.model` column (host only) | `server/db/index.ts:101` |

---

## Appendix: Auto-review turns (for completeness)

CPM also has a `task_turns` table for the host's own implementer/reviewer loop (not multi-agent — both turns run on the same workspace). Each turn has its own `claude_session_id`, `role` (`implementer`|`reviewer`), and outcome fields. Messages are tagged with `turn_id` to scope deletion on reconnect. This is separate from the participant system and unlikely relevant to agent-box, but mentioned because it adds a third `claude_session_id` concept alongside the task's and each participant's.

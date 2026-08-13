[Back to DESIGN.md](../../DESIGN.md)

# Kun — DESIGN.md

> 单一权威设计文档。所有屏幕、所有组件、所有视觉决策,都从这里出。

---

## 0. How to read this file

This file has two layers, on purpose:

- **YAML frontmatter (`---` block at the top)** — machine-readable design
  tokens (exact hex values, font stacks, spacing scale, radius scale,
  shadows, motion timings, component recipes). Design agents (Stitch,
  Figma plugins, future codegen tools) read this and apply it verbatim.
  When you change a value, change it here **and** in
  `src/renderer/src/styles/*.css` / `src/renderer/src/index.css` so the running
  app and this file stay in sync.
- **Markdown body** — the human-readable *why*. Design intent,
  principles, anti-patterns, and per-screen rules. This is what a
  contributor reads when they're deciding whether a new screen is
  on-brand.

Treat the frontmatter as the source of truth for values and the
markdown as the source of truth for judgment. If they ever conflict,
the frontmatter wins, and the markdown needs an update.

---

## 1. Project at a glance

Kun (formerly DeepSeek GUI) is a local desktop workbench built
around its namesake **Kun** runtime. The desktop shell is Electron; the runtime is a TypeScript
package that speaks HTTP/SSE; the renderer is React 19 + Zustand 5;
the visual system is TailwindCSS 3 with a hand-built token layer on
top.

The product is **not** another chat shell. It exists to let a real
agent do real work in a real project on a real machine, with the
human staying in the loop on every mutating call.

**Three workspaces plus connected entry points, one runtime:**

| Surface | Job to be done |
| --- | --- |
| **Code** | Bound to a local repo, drives the agent through tool calls, file changes, commands, and review. |
| **Design** | Generates and iterates UI drafts, interactive HTML prototypes, design graphs, and a shared design system that can hand off to Code. |
| **Work** | An office workspace for Markdown and other documents, with FIM completion and a selection-scoped inline agent. |
| **Connect phone** | Background automation: Feishu / Lark channels, webhook / relay, scheduled tasks. Internal route and storage names still use `claw` for compatibility. |

All product surfaces share the same Kun HTTP/SSE boundary, the same
settings (API key, base URL, model), and the same visual system.

---

## 2. Design principles

These six rules are not aspirations — they are how the product is
already built. New screens must follow them, not re-interpret them.

1. **One runtime, one boundary.** Code (including Design tasks), Work, and Connect phone all call
   `kun serve` over `127.0.0.1:port`. The renderer never
   embeds an agent loop and never speaks a second protocol. This
   keeps upgrades and debugging boring.
2. **Local-first, observable, controllable.** Settings, sessions,
   and runtime state live on disk under the OS app-data folder.
   Every tool call, file change, and reasoning step is shown in
   the UI. The user can interrupt, approve, deny, or revert at any
   point.
3. **No agent switcher, no runtime console.** The product
   intentionally does not surface runtime diagnostics, provider
   selection, or model-control panels. If a runtime detail is
   important, it goes in Settings, not in the main canvas.
4. **The renderer maps HTTP, it does not implement agent logic.**
   Approvals, steering, compaction, fork, resume, usage — all
   come from Kun endpoints, never re-implemented in React.
5. **Stable visual identity, not visual novelty.** A new screen
   should look like a sibling of an existing one, not a fresh
   experiment. New components earn their place by replacing
   multiple existing ones, not by adding a new style.
6. **Calm by default.** The default surface is a near-white (or
   near-black) canvas with restrained surfaces, no chroma in the
   chrome, and a single accent that only appears on actionable
   elements. Status, danger, and skill are the only other colors
   you may reach for.

---

## 3. How the project should look and feel

> **This section is the editorial companion to the YAML frontmatter
> above.** Values in the frontmatter are the contract; values here
> are the *why* and the *when*.

### 3.1 The "feel" in one paragraph

A near-paper canvas (light) or near-charcoal canvas (dark), a single
**blue accent** that only lights up when the user can act on
something, pill-shaped chrome on a desktop title bar, generous
whitespace, layered translucent surfaces that read as "glass", and
text that is dense but never crowded. The product feels like a
**calm professional tool** — closer to a code editor than to a
chat app. It must not feel like a marketing site.

### 3.2 Canvas, surface, elevation

The renderer paints two layers behind the chrome:

- **Base canvas** (`--ds-bg-canvas`, `#ffffff` light / `#181818` dark)
  is the central work area. The chat timeline, the writing editor,
  and the file tree all live on this canvas.
- **Surrounding surface** (`--ds-bg-main`, `#f5f7fa` light / `#101010`
  dark) is the app shell. Sidebars, topbar, and inspectors
  rest on it. The contrast between canvas and surface is
  intentionally small — about 4% — so the eye reads them as one
  workspace, not two zones.

On top of those, three translucent glass surfaces stack:

- `ds-card` / `ds-surface-card` — cards, list rows, popover triggers.
- `ds-elevated` / `ds-surface-elevated` — dialogs, dropdowns, the
  composer shell, anything that must lift off the page.
- `ds-subtle` / `ds-surface-subtle` — quiet secondary surfaces
  (e.g. settings tabs that are not currently active).

Glass effect is achieved with `backdrop-blur-xl` (24px) plus a faint
`inset 0 1px 0 rgba(255,255,255,0.45)` highlight on chips, and the
topbar carries a 3-stop vertical gradient
(`topbar_gradient_light` / `topbar_gradient_dark`) so the title bar
reads as a soft glass strip.

A subtle body glaze (`body_glaze_light` / `body_glaze_dark`)
sits on `body::after` to add a soft directional light without ever
introducing a new color.

### 3.3 Color, when to use it

The accent is **electric blue** (`#0088ff` light / `#339cff` dark).
Use it for *exactly* these things:

- The primary action button ("Send", "Allow", "Save").
- A focused form control's border + ring.
- Status dots that mean "this is live and doing something".
- Hyperlink-style chip labels (e.g. a feature flag toggle).
- Selection background (`--ds-selection`).

Do **not** use accent for:

- Decorative background fills larger than a chip.
- Body text or headings.
- Disabled state — disabled elements are *opacity 0.45*, not
  recolored.

Other named colors are reserved for their semantic:

- `--ds-success` / `--ds-success-soft` — completed tools, cached
  read, OK health pings.
- `--ds-danger` / `--ds-danger-soft` — failed tools, denied
  approvals, errors, retry badges.
- `--ds-skill` / `--ds-skill-soft` — anything related to a user-loaded
  Skill (purple is the "this came from a plugin" hue).
- `--ds-diff-added` / `--ds-diff-removed` — file change diff blocks.
  These are the **only** colors that may sit side-by-side on a code
  block.
- `--ds-warning-soft` — non-fatal warnings (e.g. token cache
  missing, retry-pending).

Everything else — text, borders, the canvas itself, the sidebar —
stays in the neutral palette. If a screen needs more than accent
plus these named semantic colors, it is probably a sign the
information architecture should change first.

### 3.4 Typography

Three families, and only three:

- **Sans (body)**: SF Pro Text → PingFang SC → Noto Sans SC → Helvetica
  Neue → Arial. The product is bilingual (zh + en), so the cascade
  covers macOS, Windows, and Linux. Set as
  `body { font-family: ... }` in `index.css`.
- **Display (hero, welcome)**: SF Pro Display, same CJK fallback.
  Used sparingly — only in welcome cards and modal hero copy.
- **Mono**: SF Mono → JetBrains Mono → IBM Plex Mono. Used for code
  blocks, inline code, kbd hints, command lines, model ids,
  and tool result detail.

The size rhythm in `typography.size_rhythm` is the only allowed
ladder. If you find yourself reaching for `text-[15.5px]` you're
probably between two rungs — pick the closer one or restructure.

Default `leading` is `leading-relaxed` for body prose, `leading-5`
or `leading-6` for compact UI lists, and tight (`leading-tight`)
only for hero headings. Never `leading-none` except in chips.

`tracking-wide` is reserved for the small uppercase section labels
(`text-[11px] font-semibold uppercase tracking-wide text-ds-faint`)
that appear above settings groups. Nothing else uses letter-spacing.

### 3.5 Spacing & rhythm

The product uses Tailwind's default 4-px scale. Three rules:

1. **Card padding is `px-3 py-2` (tight) or `px-4 py-3` (normal).**
   `px-5 py-4` is reserved for hero cards and full-screen modals.
2. **Inline element gap is `gap-1` to `gap-3`.** Beyond `gap-4`,
   you're starting a new region; use vertical margin instead.
3. **Section spacing is `mt-3` to `mt-6`.** Anything tighter than
   `mt-3` should be `gap-*` on a flex parent; anything wider than
   `mt-6` should probably be a new card or a divider.

The fixed three-pane layout sizes are part of the design system,
not an accident. Don't let a new screen override the sidebar
defaults — that's what `--ds-layout-left-sidebar-width` is for.

### 3.6 Radius, shape, and "softness"

The product reads as **soft but not round**. Pill controls (`rounded-full`)
on the title bar, large `rounded-xl` / `rounded-2xl` cards in the
body, and a single oversized `rounded-[28px]` shell for the
composer. Smaller radii (`rounded-md`, `rounded-lg`) appear on
inline code, kbd, and icon-only buttons.

Two hard rules:

- **No square corners on a clickable surface.** Minimum 6px.
- **No fully-rounded corners on a card surface.** Cards are
  `rounded-xl` to `rounded-3xl`, never pill-shaped.

### 3.7 Elevation & shadow

Three elevation tiers, in increasing depth:

1. **Card soft** — list rows, side panels, in-page popovers.
   Subtle, single shadow.
2. **Card strong / panel** — modals, dropdowns, the composer.
   Deeper shadow + `backdrop-blur-xl` to read as "lifted glass".
3. **Shell** — the main app shell, the welcome screen, the
   settings root. Largest shadow, used sparingly.

Chips and pill buttons get an *inset* highlight
(`inset 0 1px 0 rgba(255,255,255,0.78)` light) so they look pressed
out of a glass surface, not painted onto one.

Never use a colored shadow. All shadows are black or near-black
with low alpha.

### 3.8 Motion

Motion is **functional, not decorative**. It exists to:

- Confirm a click (button press, focus ring swap) — 140 ms.
- Reveal a hover state (card lift, chip background) — 150 ms.
- Smooth a route or panel change — 200-300 ms.
- Indicate liveness (status dot, streaming shimmer) — looped, 1.8-2.4 s.

Two looped animations exist in the system:

- `pulse` on status dots and the work logo.
- `ds-shiny-text` on streaming assistant text (a 2.4s linear
  shimmer, not a typewriter).

Everything else is one-shot. Do not animate entry/exit of dialogs
beyond a 200ms opacity+scale. Do not animate hover on rows
containing many cells. Do not animate the composer.

### 3.9 Layout grammar

Every screen in Kun follows the same macro-grammar:

- **Topbar**: a translucent strip with the back button, session
  title, mode switcher, and right-side action cluster. The topbar
  is *always* draggable for window move; interactive elements
  inside it must opt out with `.ds-no-drag`.
- **Left sidebar**: workspace roots (Code) / channels (Connect phone,
  internal `claw`) /
  spaces (Work). Collapsible, drag-resizable, 268 px default.
- **Center column**: the work surface — message timeline (Code /
  Connect phone) or editor (Work). Never bleed into the sidebars.
- **Right inspector**: optional, context-driven — Changes,
  Todo, Browser, Plan, File, Work Assistant, and SDD Assistant.
  Drag-resizable, 360 px default. The Work assistant and SDD
  assistant both use this slot.

A new screen should fit into this grammar. If it can't, that is a
signal the grammar needs to grow — and the change goes in this file
first.

### 3.10 Voice and copy

- The product is bilingual. Strings live under
  `src/renderer/src/locales/{zh,en}/` and are loaded through
  `react-i18next`. New strings ship in both locales at the same
  time.
- Tone is direct, helpful, and slightly opinionated. First-person
  plural when describing the product ("we ship", "we ship Code,
  Work, and Connect phone"), second person for the user. No emoji. No
  marketing language. Error messages are full sentences ending in
  punctuation; never a raw stack trace.
- The product name is "Kun" (formerly "DeepSeek GUI"). The bundled
  runtime shares the name; say "Kun runtime" when the distinction matters.
  The main workbenches are "Code" and "Work"; the phone/IM surface is
  "Connect phone" in English and "连接手机" in zh copy. Internal code may
  still say `claw`, but production copy should not expose it as the product name.

### 3.11 Theme switching

Three modes: `system`, `light`, `dark`. The choice is in Settings →
General. `system` listens to `prefers-color-scheme` and updates
live. The theme is applied as `data-theme` on `<html>`; Tailwind
`dark:` variants and CSS custom properties both pick it up. UI
font scale is independent (small / medium / large) and is applied
as a CSS `--ds-ui-scale` zoom factor.

Every new screen must work in both themes without per-screen
overrides. The token system is the contract.

### 3.12 What "on-brand" looks like — quick test

Before shipping a new screen, run this checklist:

- [ ] Sits in the standard three-pane + topbar grammar (or
      explicitly extends it in this file).
- [ ] Uses only the four families of color (neutral, accent,
      status, skill/diff).
- [ ] Uses only the three font families and the size rhythm.
- [ ] Uses the radius ladder (no square clickables, no round cards).
- [ ] Uses elevation tiers, not custom shadows.
- [ ] All interactive elements have a focus ring (`ring-1
      ring-accent/30`).
- [ ] Strings exist in both `zh` and `en` locale files.
- [ ] No emoji, no marketing copy, no extra runtime surface.
- [ ] No agent switcher, no runtime diagnostics, no legacy
      CodeWhale/Reasonix import.

If any box is unchecked, fix it before merging.

---

## 4. Top-level architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React 19 + Zustand 5)                             │
│  AppShell  →  Workbench  →  (Code with Design tasks | Work | Connect phone) UI│
│       │                                                      │
│       │ window.kunGui.runtimeRequest / startSse             │
│       ▼                                                      │
│ Preload (contextBridge, contextIsolated)                    │
│  kunGui.* IPC surface                                        │
│       │                                                      │
│       ▼                                                      │
│ Main process (Node)                                          │
│  RuntimeHost  →  kunRuntimeAdapter                    │
│  Settings / Connect phone runtime / Terminal / Updater / Logger│
│       │                                                      │
│       │ spawn child process + HTTP/SSE                       │
│       ▼                                                      │
│ Kun (TypeScript package)                              │
│  serve --host 127.0.0.1 --port 18899                          │
│  /health · /v1/* · SSE /v1/threads/{id}/events              │
│  cache-first AgentLoop · ports & adapters · append-only log  │
│       │                                                      │
│       │ HTTPS to model API                                   │
│       ▼                                                      │
│ DeepSeek (or OpenAI-compatible) chat/completions             │
└─────────────────────────────────────────────────────────────┘
```

Three lessons baked into this shape:

1. The renderer **does not know** which runtime it talks to
   beyond "kun". Switching providers is not a product
   surface; it's a main-process concern.
2. The main process **does not implement agent logic**. It
   spawns the child, forwards HTTP, and forwards SSE. It also
   owns GUI-only services (settings, updater, Connect phone runtime,
   workspace
   files, external editors, and Work export/completion) that the
   renderer can ask for.
3. Kun **is** the agent. Loop, tool host, stores, model
   client, server — all in one process, behind one HTTP/SSE
   boundary.

---

## 5. Core runtime: Kun

The Kun package (`kun/`) is the single active agent
runtime. It is a TypeScript ESM package that ships its own HTTP
server and is built before the Electron app.

### 5.1 Module layout

```text
kun/src/
  cli/             # Command-line entrypoints (serve)
  contracts/       # Zod schemas and inferred types for HTTP/SSE
  domain/          # Thread, Turn, Item, Event, Approval, Usage entities
  ports/           # ModelClient, ToolHost, ThreadStore, SessionStore,
                   # ApprovalGate, EventBus, WorkspaceInspector, Clock
  adapters/        # DeepSeek-compatible model client, local tool host,
                   # in-memory and file-backed stores, workspace inspector
  services/        # Thread and turn orchestration services
  loop/            # Cache-first AgentLoop, InflightTracker,
                   # SteeringQueue, ContextCompactor
  cache/           # ImmutablePrefix, LRU cache, TTL-LRU cache
  telemetry/       # Usage counter, cache telemetry
  server/          # HTTP server, router, auth, SSE, response helpers,
                   # runtime-factory, route handlers
  prompt/          # System prompt for the Kun identity
  shared/          # Shared types with the GUI
```

### 5.2 Hexagonal shape

Kun is structured as **ports & adapters**:

- `contracts/` — the boundary. Zod schemas describe every HTTP/SSE
  DTO. This is what the GUI imports indirectly through its mapper
  (`src/renderer/src/agent/kun-contract.ts`).
- `domain/` — entities. Thread, Turn, Item, Event, Approval, Usage.
  No I/O.
- `ports/` — interfaces. The agent loop only knows about
  `ModelClient`, `ToolHost`, `ThreadStore`, `SessionStore`,
  `ApprovalGate`, `EventBus`, `WorkspaceInspector`, `Clock`,
  `IdGenerator`. These are intentionally small.
- `adapters/` — concrete implementations. The default
  `CompatModelClient` speaks the
  `POST {baseUrl}/v1/chat/completions` shape; the default
  `LocalToolHost` runs tools in-process with approval gating.
- `services/` — orchestration. `ThreadService` and `TurnService`
  own the lifecycle of a thread and a turn; they wire stores,
  models, and tools together.
- `loop/` — the agent loop. Pure orchestration over the ports.
- `server/` — the thin HTTP transport that exposes everything.

A new capability should land as a new port + adapter, never as a
new server handler that reaches into the loop directly. The
boundary is the test.

### 5.3 Cache-first agent loop

The loop is built around DeepSeek's native cache hit/miss
telemetry. The principles:

- **Immutable prompt prefix** with a sha256 fingerprint. The
  system prompt, tool schemas, pinned constraints, and few-shots
  form the prefix; mutation goes through `setSystemPrompt`,
  `setTools`, `setPinnedConstraints`, `setFewShots`, which
  invalidate the fingerprint. `verifyImmutablePrefix` is called
  at the start of every model step — a drift throws immediately.
- **Append-only session log.** Every turn is a JSONL stream;
  the next replay skips malformed lines but keeps the rest.
  Indexes are atomic JSON writes.
- **Bounded TTL/LRU caches.** Tools, model responses, and
  computed fingerprints are cached with explicit eviction.
- **Inflight tracking with guaranteed cleanup.** `InflightTracker`
  is the authoritative source for SSE event pairs.
  `run(record, work)` registers an id, runs the work, and
  removes the id in a `finally` — even on abort.
- **Mid-turn steering.** `SteeringQueue` collects user messages
  posted while a turn is running and injects them as user inputs
  at the next safe loop boundary.
- **Context compaction.** `ContextCompactor` folds long histories
  into a single `compaction` item, always preserving the
  pinned constraints from the immutable prefix. Soft threshold
  16k tokens, hard threshold 24k tokens.
- **Tool pair healing.** Before sending history to the model,
  Kun drops orphan `tool_result`s and tool calls with
  missing results, to avoid 400/retry storms.

Cache hit rate is reported as `hit / (hit + miss)` using
DeepSeek's native `prompt_cache_hit_tokens` /
`prompt_cache_miss_tokens` fields. Compat fields
(`cached_tokens`, `cache_read_input_tokens`) are fallback only.

A healthy warm thread should hold ≥ 90% cache hit rate.
Verified on 2026-06-02: 12 short turns warm ran 94.7% hit; 24
short turns on the same warm prefix ran 95.2% overall, 98.1% on
the latest turn.

### 5.4 HTTP/SSE surface

The HTTP server is built on a hand-rolled `Router` that supports
`:id` params. Bearer-token auth via
`Authorization: Bearer <runtime-token>`, or `--insecure` for
local dev only. The routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | unauthenticated health probe |
| GET | `/v1/workspace/status?path=…` | git/branch status for a workspace |
| GET | `/v1/threads?include=side` | list threads (most recent first; `side` hidden by default) |
| POST | `/v1/threads` | create a thread |
| GET | `/v1/threads/{id}` | read thread + turns |
| PATCH | `/v1/threads/{id}` | update title/status/approval/sandbox/relation |
| DELETE | `/v1/threads/{id}` | delete a thread |
| POST | `/v1/threads/{id}/fork` | fork (relation: `fork` default, or `side`) |
| POST | `/v1/threads/{id}/turns` | start a turn |
| GET | `/v1/threads/{id}/turns/{turnId}` | read a turn |
| POST | `/v1/threads/{id}/turns/{turnId}/steer` | queue steering text |
| POST | `/v1/threads/{id}/turns/{turnId}/interrupt` | abort a turn |
| POST | `/v1/threads/{id}/compact` | fold old history |
| GET | `/v1/threads/{id}/events?since_seq=N` | SSE backlog + live |
| POST | `/v1/approvals/{id}` | allow / deny |
| POST | `/v1/user-inputs/{id}` and `/v1/user-input/{id}` | submit / cancel user input answers |
| POST | `/v1/sessions/{id}/resume-thread` | resume a session into a thread |
| GET | `/v1/usage` | cumulative token / cache / turn counters |

SSE frames use `id: <seq>`, `event: <kind>`, and JSON `data:`. A
late-joining client passes `since_seq` (or `Last-Event-ID`) and
receives the backlog before live events. A heartbeat is sent
every 15 s to keep idle proxies alive.

### 5.5 Thread record & relation

Every thread persisted under `{data-dir}/threads/{id}/thread.json`
carries `relation` metadata:

- `primary` — top-level thread (default).
- `fork` — manual fork that switches the user away.
- `side` — "by-the-way" side conversation inherited from a
  parent snapshot. Excluded from the default thread listing; pass
  `?include=side` to opt in. Has `parentThreadId` set;
  promoting back to `primary` clears it.

The `fork` and `side` lineage also store `forkedFromThreadId`,
`forkedFromTitle`, `forkedAt`, and message/turn counts at fork
time. The GUI surfaces these in the sidebar.

### 5.6 Approval & sandbox

`ToolHostContext` carries `approvalPolicy` and the tool host
gates at two layers: `policy: 'never'` blocks up front;
`on-request` / `suggest` / `untrusted` always prompt unless
the call is in the `allowList`. Tools that need to be scoped
to a specific mode (e.g. `create_plan` only inside a `plan`
thread) declare a `shouldAdvertise(ctx)` predicate that filters
both the listing and the execution.

`SandboxMode` (`read-only` / `workspace-write` /
`danger-full-access` / `external-sandbox`) is enforced by the
workspace inspector and the file/tool adapters.

### 5.7 Persistence

`--data-dir` is the on-disk root for everything the runtime
owns:

```text
{data-dir}/
  threads/
    index.json
    {threadId}/
      thread.json     # ThreadRecord
      messages.jsonl  # TurnItem append-only
      events.jsonl    # RuntimeEvent append-only
      session.json    # latest AgentSession projection
```

Atomic JSON writes for `index.json`, `thread.json`, and
`session.json`. JSONL streams tolerate malformed lines (the
next replay skips them).

---

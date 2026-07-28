## Context

Kun currently creates one Electron `Tray` in `src/main/index.ts`. Both left and right click call `popUpContextMenu`, whose native menu contains recent sessions plus New Chat, Open Kun, and Exit. Provider quota already exists as a normalized main-process service and a scrollable workbench right-panel component, but the native tray menu cannot host the richer provider switcher and metric presentation shown by CodexBar.

The popover is a trusted product surface, but it has a much smaller purpose than the workbench. The existing preload intentionally exposes a broad API and the existing `provider:quota:list` handler accepts only the main workbench frame. The tray surface therefore needs a separate entry and capability boundary.

## Goals / Non-Goals

**Goals:**

- Open a CodexBar-inspired quota popover from a normal tray click.
- Retain the current session/action menu on right click.
- Let users switch between an overview and every configured provider.
- Present only normalized quota data already returned by the provider-quota service.
- Keep content usable on short displays through a fixed switcher/footer and an independent scroll owner.
- Position the window safely under or above the tray icon on any display.
- Expose only quota-list, dashboard-open, refresh notification, and small tray actions to the renderer.

**Non-Goals:**

- Reimplementing CodexBar's spend estimates, token history chart, pace projection, warning thresholds, or background polling.
- Importing browser cookies, adding new credential fields, or persisting quota snapshots.
- Replacing the existing workbench quota panel.
- Removing the native session menu or changing its contents.
- Supporting arbitrary navigation or third-party content inside the popover.

## Decisions

### Use a dedicated frameless BrowserWindow

Electron main will lazily create one small, frameless, shadowed `BrowserWindow` with a transparent/rounded renderer shell. It is retained while hidden so the selected provider survives repeated opens. A normal tray click toggles this window; right click hides it and opens the existing native menu.

Using a custom window instead of trying to place React inside Electron's native `Menu` gives reliable scrolling, progress bars, responsive layout, and keyboard interaction. Replacing the entire tray with only the custom window was rejected because the existing recent-session menu remains useful.

### Anchor with a pure display-aware geometry helper

A helper will receive tray bounds, popover size, and display work area. It centers the popover on the tray icon, prefers placement below the icon when space exists, otherwise places it above, then clamps both axes inside the work area with a small margin. The main process recalculates this position on every show so menu-bar movement and multiple displays remain correct.

The geometry helper is pure and unit-tested independently of Electron.

### Build a separate renderer and preload entry

`tray-quota.html` and a dedicated React entry will be added to the renderer build. A dedicated preload will expose `window.kunTrayQuota` with:

- `list()` for normalized quota results;
- `action('close' | 'new-chat' | 'open-app')`;
- `openExternal(url)` for HTTPS provider dashboards;
- `context()` for locale;
- `onRefresh(handler)` for a refresh signal whenever the retained window is reopened.

Main-process IPC handlers will verify the sender is the tray popover's main frame. Navigation and window opening are denied. Reusing `window.kunGui` was rejected because it exposes unrelated settings, filesystem, terminal, migration, and runtime operations.

### Reuse the normalized provider-quota contract

The popover calls the existing Electron main `listProviderQuotas` service. No credential, provider settings object, raw response, or Kun `/v1/usage` record crosses the IPC boundary.

The UI includes:

- a sticky, wrapping provider switcher with an Overview item;
- status and a small usage indicator per provider;
- a selected-provider header with summary and dashboard action;
- one section per returned metric with progress, remaining/used/limit values, and relative reset text;
- explicit unsupported, missing-credential, request-error, loading, refresh-error, and empty states;
- a fixed footer with refresh, New Chat, and Open Kun.

Overview summarizes every provider without inventing a cross-provider percentage or balance total. Cost history and projected exhaustion from the CodexBar reference are omitted because the current contract does not supply authoritative data for them.

### Keep workbench provider cards collapsed by default

The workbench quota sidebar uses a compact accordion list instead of rendering
every provider's complete metric collection at once. Each row keeps the provider
identity, status, one truthful primary quota or error summary, and dashboard
action visible. All detail regions start collapsed and expand independently when
their disclosure control is activated. Expanded content reuses the existing
metric, source, and update-time presentation without changing the normalized
quota contract.

The dashboard action remains a separate button so opening it cannot accidentally
toggle the row. Native disclosure semantics (`aria-expanded` and
`aria-controls`) keep the interaction keyboard and screen-reader accessible.

### Group workbench providers that cannot currently show quota

The workbench keeps providers with `available` quota visible as ordinary compact
rows. Providers in `missing_credentials`, `error`, or `unsupported` states are
partitioned into separate status disclosure groups. Each group starts collapsed,
shows its localized status and provider count, and is omitted when empty.

Opening a status group reveals its provider rows without automatically expanding
their details. This preserves access to the provider-specific explanation,
source, update time, and dashboard action while keeping the common high-volume
failure and unsupported states from dominating the sidebar. The groups use
native disclosure semantics and do not change the normalized quota contract.

### Match CodexBar's read-only subscription sources

The quota service recognizes the actual preset profile shape, where ordinary HTTP
subscription presets may omit `kind`. ChatGPT/Codex reads configured OAuth state or
the Codex CLI `auth.json` (including `CODEX_HOME`) and calls the fixed
`/backend-api/wham/usage` endpoint. Kimi Code calls the fixed official
`/coding/v1/usages` endpoint with the API key already stored for that provider.

Grok calls the same fixed grok.com billing gRPC-web endpoint used by CodexBar with
an existing Kun or Grok CLI OAuth bearer. Kun does not silently import browser
cookies. If xAI rejects bearer-only billing, the provider remains recognized and
returns an actionable request/authentication error instead of an inaccurate
unsupported state.

OpenCode Go has no API-key quota endpoint. Kun follows CodexBar's safe local-first
path by opening the existing OpenCode SQLite database read-only and deriving the
5-hour, weekly, and monthly plan windows from `opencode-go` assistant costs. The
source is labeled as a local estimate, supports XDG/macOS/Linux locations plus the
Windows user-profile `.local/share` location, and never imports browser cookies or mutates the
OpenCode database.

### Refresh on every show while retaining stale data

The main process emits a refresh event after showing an already-loaded popover. The renderer also loads on mount and supports manual refresh. A refresh failure leaves the previous result visible with an inline error. Duplicate refreshes are coalesced in the component.

### Hide like a popover

The window hides on blur, Escape, a second tray click, or when an action opens the main window. It is destroyed when the tray is disabled or the application quits. The window never appears in the taskbar or Dock window list.

### Use a Windows-specific solid Fluent fallback

The context bridge reports the host platform in addition to locale and color mode. On Windows, the renderer uses a tighter Fluent-style radius, a solid surface color, and a platform-specific shadow instead of depending on compositor backdrop blur. Forced-colors mode removes decorative gradients and exposes native system colors and outlines.

Windows normally reports the notification-area icon at the bottom edge of a display, so the same geometry helper places the popover above it. Main resolves the display from the tray rectangle rather than only its center point, which is safer for negative-origin and mixed-DPI secondary displays. If Electron returns an empty tray rectangle, the current pointer position becomes a bounded fallback anchor. macOS keeps the translucent menu-bar presentation.

## Risks / Trade-offs

- [Transparent frameless windows vary across desktop environments] → Use platform-appropriate background color, keep the layout functional without blur, and test positioning separately from visual effects.
- [Windows can report an empty or edge-adjacent tray rectangle] → Fall back to a small pointer-centered anchor and resolve the display by rectangle before clamping to its work area.
- [A blur event can fire while opening a provider dashboard] → Treat this as expected popover behavior and launch the dashboard through main-process IPC.
- [Many providers can overflow the switcher] → Allow the switcher to wrap to a bounded grid and keep the detail region independently scrollable.
- [Collapsed rows can hide important failures] → Keep status and a truncated actionable error summary visible even while details are collapsed.
- [Collapsed status groups can conceal which providers need attention] → Keep the localized status and provider count visible, and preserve each provider's actionable summary after the group is opened.
- [Provider names may be long or contain unsafe text] → Truncate visual labels, preserve accessible titles, and rely on React escaping plus the normalized bounded contract.
- [Retained windows can show stale data] → Refresh on every show and retain old data only as an explicit fallback on error.
- [The same quota service may perform several provider requests] → Keep the existing bounded concurrency and request timeouts; do not introduce background polling.
- [Grok billing may require a grok.com browser session] → Reuse only existing OAuth
  state in this phase and report the upstream authentication limitation explicitly;
  do not read browser cookies without a separate opt-in design.
- [OpenCode Go local costs are not an authoritative server snapshot] → Label the
  source and summary as a local estimate, keep the database read-only, and report
  missing local history instead of inventing usage.

## Migration Plan

The change is additive and requires no settings migration. On rollback, remove the tray window, dedicated renderer/preload entries, and scoped IPC handlers, then restore left click to `showTrayMenu`; the existing right-click menu and workbench quota panel remain intact throughout.

## Open Questions

- A later phase can add opt-in background quota warnings or historical usage only after those values have an authoritative cross-provider contract.

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
- Adding new provider probes, credentials, settings, or persisted quota snapshots.
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

### Refresh on every show while retaining stale data

The main process emits a refresh event after showing an already-loaded popover. The renderer also loads on mount and supports manual refresh. A refresh failure leaves the previous result visible with an inline error. Duplicate refreshes are coalesced in the component.

### Hide like a popover

The window hides on blur, Escape, a second tray click, or when an action opens the main window. It is destroyed when the tray is disabled or the application quits. The window never appears in the taskbar or Dock window list.

## Risks / Trade-offs

- [Transparent frameless windows vary across desktop environments] → Use platform-appropriate background color, keep the layout functional without blur, and test positioning separately from visual effects.
- [A blur event can fire while opening a provider dashboard] → Treat this as expected popover behavior and launch the dashboard through main-process IPC.
- [Many providers can overflow the switcher] → Allow the switcher to wrap to a bounded grid and keep the detail region independently scrollable.
- [Provider names may be long or contain unsafe text] → Truncate visual labels, preserve accessible titles, and rely on React escaping plus the normalized bounded contract.
- [Retained windows can show stale data] → Refresh on every show and retain old data only as an explicit fallback on error.
- [The same quota service may perform several provider requests] → Keep the existing bounded concurrency and request timeouts; do not introduce background polling.

## Migration Plan

The change is additive and requires no settings migration. On rollback, remove the tray window, dedicated renderer/preload entries, and scoped IPC handlers, then restore left click to `showTrayMenu`; the existing right-click menu and workbench quota panel remain intact throughout.

## Open Questions

- A later phase can add opt-in background quota warnings or historical usage only after those values have an authoritative cross-provider contract.

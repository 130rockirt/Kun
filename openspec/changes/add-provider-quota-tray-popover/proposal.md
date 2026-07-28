## Why

Kun's menu-bar icon currently opens a plain session/action menu, so provider allowance is only visible after opening the full workbench and navigating to its quota sidebar. A compact CodexBar-style popover would make the already-supported provider balances and subscription limits available at a glance without interrupting the user's current app.

## What Changes

- Make a normal click on the Kun tray icon toggle a compact provider-quota popover anchored to the icon.
- Keep the existing session and application menu available from a right click.
- Add a provider switcher with an overview and one tab per configured provider.
- Show provider status, reported balance or rate-window metrics, progress, reset time, data source, and provider dashboard action.
- Add manual refresh plus New Chat and Open Kun actions inside the popover.
- Hide the popover on blur or Escape, constrain it to the active display, and keep long quota content independently scrollable.
- Adapt the shell and anchor calculation for Windows taskbars, multi-monitor work areas, high-contrast mode, and environments without compositor blur.
- Use a dedicated renderer entry, preload bridge, and narrowly scoped IPC surface so the popover does not receive the full workbench API.

## Capabilities

### New Capabilities

- `provider-quota-tray-popover`: Display and navigate configured provider quota from an anchored, secure menu-bar popover.

### Modified Capabilities

None.

## Impact

- Electron main gains a lazily created tray popover window, display-aware positioning, toggle/hide lifecycle, and scoped IPC handlers.
- The preload and renderer builds gain dedicated tray-quota entry points.
- The renderer gains a compact provider switcher and detailed quota view that reuse the existing normalized provider-quota contract.
- The existing `provider:quota:list` workbench IPC and right-sidebar quota surface remain unchanged.
- The existing tray session menu is retained on right click; no settings migration or new dependency is required.

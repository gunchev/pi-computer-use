# pi-computer-use

[Pi](https://github.com/badlogic/pi-mono) extension for GUI computer-use on macOS and Linux/Wayland. Gives your agent eyes and hands — it can see the screen, find UI elements, and interact with any app through native mouse/keyboard events.

Useful for launching, testing, and debugging GUI applications from pi.

## How it works

1. **Screenshot** — captures the screen or app window (macOS `screencapture`; Linux `spectacle`)
2. **Grounding** — sends the screenshot + a target description (e.g. `'button labeled "Save"'`) to a vision model to get pixel coordinates
3. **Action** — dispatches native input events (macOS: compiled Swift helper; Linux: the `RemoteDesktop` portal)

On macOS the Swift binary is compiled on first use and cached. No manual build step needed.

On Linux, input goes through `org.freedesktop.portal.RemoteDesktop` rather than raw `uinput`. See [Linux](#linux) for why.

## Install

```bash
pi install git:github.com/swairshah/pi-computer-use
```

The extension uses a Swift native helper for mouse/keyboard events, compiled automatically on first use. You'll need:

- **Xcode Command Line Tools** — `xcode-select --install` if you don't have them
- **Accessibility** permission for your terminal (System Settings → Privacy & Security → Accessibility)
- **Screen Recording** permission for your terminal (System Settings → Privacy & Security → Screen Recording)

For Linux requirements see [Linux](#linux).

## Linux

Supported: **KDE Plasma 6 on Wayland** (verified on Plasma 6.7.5 / xdg-desktop-portal 1.22.1).
GNOME and wlroots compositors should work with the same portal calls but are untested.

### Requirements

```bash
# Fedora
sudo dnf install spectacle python3-dbus python3-gobject kscreen
# Debian / Ubuntu
sudo apt install spectacle python3-dbus python3-gi kde-config-screen
dnf install ImageMagick   # or apt install imagemagick — used to downsize screenshots
```

Plus a running `xdg-desktop-portal` with the KDE backend (`xdg-desktop-portal-kde`).

### First run

The first action pops **KDE consent dialogs** asking to share the screen and to allow
keyboard/pointer control. Approve them (tick *remember* where offered) — the session
then persists. `pi` deliberately does **not** contact the portal at session start, so
you are never prompted implicitly.

A long-lived daemon owns the portal session, because portal sessions are killed when
the D-Bus connection that created them exits. It is started on demand and listens on
`$XDG_RUNTIME_DIR/pi-compuse-portal.sock`.

```bash
# inspect / restart the input daemon
python3 $XDG_RUNTIME_DIR/../tmp/pi-compuse-linux/pi-compuse-portal-*.py --help
rm -f $XDG_RUNTIME_DIR/pi-compuse-portal.sock   # forces a fresh daemon + consent
```

### Why the portal and not `uinput`

A raw `uinput` tablet (`BTN_TOOL_PEN` + `ABS_X/Y`) or touchscreen
(`ABS_MT_*` + `BTN_TOUCH`) delivers events that reach libinput **pixel-exact** — but
KDE Plasma ignores synthetic tablet/touch input for UI interaction; that path
exists for drawing tablets feeding apps such as Krita. Portal-created input is
made by the compositor itself and is treated as real.

### Known limitations

- **No absolute pointer API.** `NotifyPointerMotionAbsolute` returns
  `Invalid position` for every coordinate, stream and options combination. Root
  cause is upstream in `xdg-desktop-portal-kde`: `RemoteDesktopSession`'s
  `screenSharingEnabled` flag is never set, so `RemoteDesktop.Start` omits the
  `streams` key, so the portal frontend's stream list is empty and
  `check_position()` rejects unconditionally. See
  [`docs/upstream-reports/`](upstream-reports/) for the full analysis.
  Absolute targeting is emulated with *park-and-count* relative motion: drive the
  pointer far off-screen to clamp it to `(0,0)`, then move by the relative delta.
  **This passes through the top-left hot corner** — consider disabling KDE
  hot corners (`System Settings → Workspace → Screen Edges`) so parking is inert.
  The daemon parks automatically before the first absolute action (see
  [Pointer synchronisation](#pointer-synchronisation)) so a cold start cannot
  aim from a stale origin.
- **EIS is not a way around this.** `ConnectToEIS` returns a valid fd and the
  connection is accepted, but the server never announces a seat, so no device can
  be created. Documented in the upstream report so it is not re-explored.
- **Full-display capture only.** The portal screencast covers the whole
  composited screen; per-window capture falls back to full display.
- **Key names need evdev keycodes.** `gui_keypress` / `gui_hotkey` need
  `UNDERSTUDY_GUI_KEY_CODE` (e.g. `29`=Ctrl, `60`=F2). Named-key translation
  is not implemented on Linux yet.
- **Modifiers are held as key presses.** The portal has no modifier field on
  button events, so `shift`/`ctrl`/`alt`/`super` are pressed and released
  around the click.

### Pointer synchronisation

Because absolute positioning is emulated, the daemon keeps a **tracked** pointer
position. On a fresh daemon that value is only a guess (screen centre), so the first
absolute action would be aimed from a phantom origin and can land far off target.

The daemon therefore **parks once before the first absolute action** and marks
itself synchronised; later actions reuse the tracked position and pay nothing.

If something else moves the pointer (the user grabs the mouse, another tool
injects input), tell the daemon so it re-parks on the next move:

```bash
# via the daemon socket directly
python3 - <<'PY'
import socket, os, json
p = os.path.join(os.environ["XDG_RUNTIME_DIR"], "pi-compuse-portal.sock")
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(p)
s.sendall(b'{"cmd":"invalidate"}\n'); print(s.recv(200).decode())
PY
```

`{"cmd":"status"}` reports `synced` and the current tracked position, which is
useful when a click seems to have gone astray.

### Coordinate mapping

The screencast stream reports **logical** pixels (device pixels ÷ display scale).
`captureRect` is set to the logical display bounds, so the existing
`captureRect.origin + imagePoint / scale` math yields logical pixels — exactly
what the daemon expects. On a 3840×2160 display at 150% scale the screenshot is
3840×2160 but coordinates are in 2560×1440 space.

## Tools

### Observation

| Tool | What it does |
|------|-------------|
| `gui_read` | Screenshot + optionally locate a target element |
| `gui_screenshot` | Screenshot only |
| `gui_cursor_position` | Current mouse (x, y) |
| `gui_clipboard_read` | Read system clipboard |

### Mouse

| Tool | What it does |
|------|-------------|
| `gui_click` | Left/right/middle click. Supports modifier keys (Shift+click, Cmd+click, etc.) |
| `gui_double_click` | Double-click (select word, open file) |
| `gui_triple_click` | Triple-click (select line/paragraph) |
| `gui_right_click` | Right-click (context menu) |
| `gui_hover` | Hover (tooltips, hover menus) |
| `gui_drag` | Drag from A to B. Supports modifiers (Option+drag to duplicate) |
| `gui_scroll` | Scroll up/down/left/right |

### Keyboard

| Tool | What it does |
|------|-------------|
| `gui_type` | Type text into a field (optionally click target first) |
| `gui_keypress` | Press a key (Enter, Tab, Escape, arrows, etc.) |
| `gui_hotkey` | Keyboard shortcut (Cmd+S, Shift+Cmd+P, etc.) |

### Utility

| Tool | What it does |
|------|-------------|
| `gui_clipboard_write` | Write to system clipboard |
| `gui_wait` | Pause N milliseconds (animations, loading) |
| `gui_batch` | Chain multiple actions in one tool call |

### `gui_batch`

Executes a sequence of actions without round-tripping through the LLM between each step. Each grounded action (click, type with target) takes a fresh screenshot, but you save inference calls.

```
gui_batch({ actions: [
  { action: "click", target: "search field" },
  { action: "type", value: "hello world" },
  { action: "keypress", key: "Enter" },
  { action: "wait", ms: 1000 },
  { action: "scroll", direction: "down", amount: 10 }
]})
```

Supported actions: `click`, `right_click`, `double_click`, `triple_click`, `hover`, `drag`, `scroll`, `type`, `keypress`, `hotkey`, `wait`, `clipboard_read`, `clipboard_write`. Stops on first error.

## Source

```
src/
├── index.ts          # Extension entry — registers tools with pi
├── runtime.ts        # Screenshot capture, grounding, native input dispatch
├── grounding.ts      # Vision model grounding (uses pi's model registry + pi-ai)
├── native-helper.ts  # Embedded Swift source, compiled and cached at runtime
└── learn.ts          # /learn command — record GUI demos and save as skills
```

## Credits

GUI runtime adapted from [understudy](https://github.com/nichochar/understudy).

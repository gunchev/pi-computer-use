# pi-computer-use

[Pi](https://github.com/badlogic/pi-mono) extension for GUI computer-use on macOS. Gives your agent eyes and hands — it can see the screen, find UI elements, and interact with any app through native mouse/keyboard events.

Useful for launching, testing, and debugging GUI applications from pi.

## How it works

1. **Screenshot** — captures the screen or app window via macOS `screencapture`
2. **Grounding** — sends the screenshot + a target description (e.g. `'button labeled "Save"'`) to a vision model to get pixel coordinates
3. **Action** — dispatches native input events via a compiled Swift helper

The Swift binary is compiled on first use and cached. No manual build step needed.

## Install

```bash
pi install git:github.com/swairshah/pi-computer-use
```

The extension uses a Swift native helper for mouse/keyboard events, compiled automatically on first use. You'll need:

- **Xcode Command Line Tools** — `xcode-select --install` if you don't have them
- **Accessibility** permission for your terminal (System Settings → Privacy & Security → Accessibility)
- **Screen Recording** permission for your terminal (System Settings → Privacy & Security → Screen Recording)

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

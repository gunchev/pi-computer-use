# Should this Linux backend be ported to `injaneity/pi-computer-use`?

Decision note. Filed here so the question is not re-litigated from scratch later.

## The two projects

| | `swairshah/pi-computer-use` (this repo) | `injaneity/pi-computer-use` |
|---|---|---|
| Stars / forks | 2 / 0 | 2018 / 140 |
| Last push | 2026-04-02 | 2026-09-27 (active) |
| Architecture | TypeScript. `runNativeHelper()` shells to a runtime-compiled **Swift** binary; `screencapture` + `osascript` | **Rust** native bridge (`atspi.rs`, `wayland.rs`, `x11.rs`) + ref/state navigation; TS extension layer |
| Linux today | None — hard `process.platform !== "darwin"` bail | Partial. `docs/linux.md` states plainly: *"On Wayland, portal diagnostics are read-only; capture and input are not implemented."* |
| Input model | Screenshot → vision grounding → absolute pixel coordinates | AT-SPI semantic refs first; coordinates are a fallback |

## Why the port is NOT a straight transplant

The backend we proved on KDE Plasma 6.7.5 / Wayland is **coordinate-driven**:

```
spectacle capture  →  vision grounding  →  park-and-count relative motion
                                        + NotifyPointerButton / NotifyKeyboardKeycode
```

`injaneity`'s Linux design is **semantics-first** — it drives `Action` / `EditableText` /
`Text` AT-SPI interfaces and treats pixel input as a fallback. Converting our work
means:

1. Re-implementing the RemoteDesktop portal client in **Rust** (`zbus` or `sd-bus`),
   including the async `Request`/`Response` signal dance.
2. Fitting it into their `wayland.rs` capability matrix and their
   `headless` / `ax_only` / `foreground` delivery-policy model.
3. Deciding how portal-granted input interacts with their policy that "background
   delivery is not invisible execution" — portal input moves the **real** cursor,
   so it is a `foreground`-class capability in their terms.

That is a multi-day Rust project, not a port.

## Why it is still worth telling them about

Their `docs/linux.md` explicitly names the gap we solved, and they have open Linux
issues being triaged (e.g. #82, AT-SPI `read_text` errors). The **portal facts** we
discovered are directly reusable by them regardless of language, and several are
non-obvious enough that they will re-derive them painfully otherwise:

1. `session_handle_token` is **mandatory** on `CreateSession`; omitting it makes
   `xdp_session_initable_init` assert on a NULL token and **abort the portal daemon**.
2. Token charset is `[A-Za-z0-9_]` only — it becomes a D-Bus object path element.
3. The portal object path is lowercase `/org/freedesktop/portal/desktop`; the
   spec's capital-`D` form introspects as an empty node on KDE.
4. `CreateSession` is **async** — it returns a `/request/…` whose `Response`
   carries the real `session_handle`.
5. `SelectDevices` takes a `types` **UInt32 bitmask** (1=keyboard, 2=pointer,
   4=touch), not booleans. Wrong keys ⇒ response code 2 (cancelled).
6. Sessions die with the creating D-Bus connection ⇒ a long-lived holder is required.
7. The consent dialog's app name derives from the systemd cgroup
   (`app-<APPID>-<uuid>.scope`); a bare CLI resolves to an empty app ID.
8. `NotifyPointerMotionAbsolute` is **broken upstream** in
   xdg-desktop-portal-kde 6.7.5 — `Invalid position` for every coordinate,
   stream and options combination. Absolute targeting must be emulated with
   park-and-count relative motion.
9. Raw uinput (tablet `BTN_TOOL_PEN`+`ABS`, or touchscreen `ABS_MT_*`+`BTN_TOUCH`)
   reaches libinput pixel-exact but **Plasma ignores it for UI interaction** —
   so their `wayland.rs` cannot be solved with uinput either.

## Recommendation

**Open an issue on `injaneity/pi-computer-use`** rather than attempting the Rust
port now:

- Title: *Wayland input/capture: RemoteDesktop portal works on KDE Plasma — facts +
  repro for anyone implementing `wayland.rs`*
- Body: the nine facts above, plus the note that their own `docs/linux.md` already
  identifies this exact gap.
- Attach the portal repro script.

That gives them the hard-won knowledge at near-zero cost to us, and leaves the door
open for them (or us, later) to do the Rust implementation properly.

**Do not** block this repo's Linux support on that. Ship the portal backend here
first; it makes the package that `npm:pi-computer-use` actually installs work on
Linux.

## Upstream bug worth filing separately

`NotifyPointerMotionAbsolute` returning `Invalid position` for all inputs is a
genuine defect in xdg-desktop-portal-kde 6.7.5. Repro sweep: coordinates
0→3839, stream ∈ {0, 1, real stream id}, options ∈ `{}`, `{stream}`, `{pointer}`
— all rejected, while `NotifyPointerMotion` (relative) and `NotifyPointerButton`
on the same session succeed. Filing this could get a real absolute API back, which
would remove the hot-corner-sensitive park-and-count workaround.

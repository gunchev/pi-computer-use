# Bug report: `setScreenSharingEnabled(true)` is never called → RemoteDesktop streams and EIS seats are never announced

**Target:** `xdg-desktop-portal-kde` (KDE/xdg-desktop-portal-kde, `src/remotedesktop.cpp`)
**Verified on:** Plasma 6.7.5 / kwin 6.7.5 / xdg-desktop-portal 1.22.1 / Fedora 44 / Wayland
**Severity:** blocks all absolute pointer/touch input through the RemoteDesktop portal, and blocks EIS device creation entirely.

> Ready to paste into https://bugs.kde.org/ (product `xdg-desktop-portal-kde`) or a GitHub issue on the mirror.

---

## Summary

`RemoteDesktopPortal::Start` never includes a `streams` key in its response, and
`ConnectToEIS` never announces a seat, because `RemoteDesktopSession`'s
`m_screenSharingEnabled` flag is never set to `true`. Both symptoms share this one
cause.

The practical effect: **no RemoteDesktop client can perform absolute pointer or
touch positioning on KDE**, and no EIS client can obtain a device. Only relative
pointer motion and keyboard input work.

## Evidence

### 1. The setter exists but is never called

```cpp
// src/remotedesktop.cpp
RemoteDesktopSession::RemoteDesktopSession(QObject *parent, const QString &appId, const QString &path)
    : ScreenCastSession(parent, appId, path)
    , m_screenSharingEnabled(false)          // ~line 534
    , m_clipboardEnabled(false)
    ...

void RemoteDesktopSession::setScreenSharingEnabled(bool enabled)   // ~line 563
{
    if (m_screenSharingEnabled == enabled) { ... }
    m_screenSharingEnabled = enabled;
    ...
}
```

`grep -n "setScreenSharingEnabled" src/remotedesktop.cpp` returns **only the
definition** — there is no call site with `true` anywhere in the file.

### 2. That makes `continueStart()` skip stream creation

```cpp
QFuture<QVariantList> continueStart(RemoteDesktopSession *session)
{
    QList<QFuture<std::unique_ptr<ScreencastingStream>>> streams;
    if (session->screenSharingEnabled()) {        // always false
        ... startStreamingOutput / startStreamingWorkspace / startStreamingVirtual ...
    }

    session->acquireStreamingInput();
    auto all = QtFuture::whenAll(streams.begin(), streams.end());
    return all.then(session, [session](...) -> QVariantList {
        ...
        if (!streams.empty()) {                  // always empty
            session->setStreams(std::move(streams));
            ...
            results.insert(QStringLiteral("streams"), QVariant::fromValue(dbusResultForStreams));
        }
        ...
    });
}
```

So the `streams` key is never inserted into the RemoteDesktop `Start` response.

### 3. Measured live

Same client, same session, back to back:

```
SC.Start keys : ['streams']        node 213, size = (2560, 1440)     <-- ScreenCast is fine
RD.Start keys : ['clipboard_enabled', 'devices']                     <-- no 'streams'
RD devices    : 3   (keyboard | pointer, granted)
```

The ScreenCast session reports the stream and its size correctly. The RemoteDesktop
session reports no streams at all.

### 4. Consequence in the portal frontend

`xdg-desktop-portal/src/remote-desktop.c` populates the RemoteDesktop session's
stream list from the **RemoteDesktop** `Start` response, not from the ScreenCast
session:

```c
static gboolean
process_results (RemoteDesktopSession *remote_desktop_session, GVariant **in_out_results, GError **error)
{
  g_autoptr(GVariantIter) streams_iter = NULL;
  ...
  if (g_variant_lookup (results, "streams", "a(ua{sv})", &streams_iter))
    {
      remote_desktop_session->streams = collect_screen_cast_stream_data (streams_iter);
    }
  ...
}
```

Because the key is absent, `remote_desktop_session->streams` stays **empty**, and
`check_position()` — which iterates that list — never enters its body:

```c
static gboolean
check_position (XdpSession *session, uint32_t stream, double x, double y)
{
  RemoteDesktopSession *remote_desktop_session = REMOTE_DESKTOP_SESSION (session);
  GList *l;

  for (l = remote_desktop_session->streams; l; l = l->next)   /* empty: never runs */
    {
      ...
    }

  return FALSE;
}
```

Result: `NotifyPointerMotionAbsolute`, `NotifyTouchDown` and `NotifyTouchMotion`
fail with `Invalid position` for **every** coordinate. Confirmed by sweeping
`(0,0) (100,100) (1280,720) (2559,1439) (1920,1080) (3839,2159)` — 0 accepted,
6 rejected.

Note the error originates in the **frontend**: `strings /usr/libexec/xdg-desktop-portal`
contains `"Invalid position"` (3 sites) while
`strings /usr/libexec/xdg-desktop-portal-kde` contains none of it.

### 5. The same cause also starves EIS

`ConnectToEIS` succeeds and hands back a real file descriptor:

```
portal EIS fd: 8
ei_setup_backend_fd -> 0
  [0.00s] EI_EVENT_SYNC      (91)
  [0.00s] EI_EVENT_CONNECT  (1)
  ... 20s of select() + ei_dispatch() ...
seat added (EI_EVENT_SEAT_ADDED) seen: False
```

KWin accepts the EIS connection and sends `SYNC` + `CONNECT`, but never announces a
seat — so a client can never call `ei_seat_request_device_with_capabilities()` and
can never create a device. Tried `deviceTypes` 3 and 7; same result.

## Relationship to flatpak/xdg-desktop-portal#2077 / PR #2078

#2077 describes the identical symptom but attributes it to a **Virtual**-source
stream with an unnegotiated `(0,0)` size. That is a *different* cause. On this
setup:

- the source is a real **Monitor** (`source_type = 1`), and
- `size` **is** reported correctly as `(2560, 1440)`.

I built xdg-desktop-portal 1.22.1 with PR #2078 applied and re-ran the sweep:
**still 0/6 accepted.** Both of that PR's fixes (the shadowed `stream` parameter,
and the new `has_size` guard) operate on a stream list that is empty here, so
neither can take effect. Notably, the PR's own test template *injects* a `streams`
key into the mocked RemoteDesktop `Start` response — precisely the thing this KDE
bug prevents from ever being sent.

#2078 is still worth merging on its own merits (the shadowing is a real bug), but it
should not be treated as resolving this.

## Expected behaviour

`RemoteDesktopPortal::Start` should include the session's streams in its response
when the user has granted input control, so that the frontend can validate
absolute coordinates against a real size — and the EIS path should announce the
seat.

## Suggested fix direction

Set screen sharing on the RemoteDesktop session when input control is granted
(and/or when the session is associated with a ScreenCast session), e.g. in
`SelectDevices` or `Start`:

```cpp
session->setScreenSharingEnabled(true);
```

so that `continueStart()` actually builds streams and reports them.

## Reproduction

1. KDE Plasma 6.7.5 on Wayland, `xdg-desktop-portal` 1.22.1, `xdg-desktop-portal-kde` 6.7.5.
2. Client performs: `ScreenCast.CreateSession` → `SelectSources(sources=[(1,1)], persistent=true, cursor-mode=1)` → `Start` (approve consent).
3. `RemoteDesktop.CreateSession` → `SelectDevices(types=3)` → `Start(session_handle=<screencast session>)` (approve consent).
4. Observe the `Start` response keys: `clipboard_enabled`, `devices` — no `streams`.
5. `NotifyPointerMotionAbsolute(session, {}, <stream node id>, x, y)` → `org.freedesktop.DBus.Error.Failed: Invalid position` for any `x, y`.
6. `ConnectToEIS(session, {})` → valid fd; `libei` receives `SYNC` + `CONNECT` only, no `SEAT_ADDED`.

A Python reproducer (dbus-python + GLib main loop) is available on request; the
key calls are `CreateSession` with a `session_handle_token`, awaiting each
`Request`'s `Response` signal, then `SelectDevices` with the `types` UInt32
bitmask.

## Workaround currently in use

Absolute targeting emulated with park-and-count relative motion
(`NotifyPointerMotion(-5000,-5000)` twice to clamp to origin, then the relative
delta). Functional, but it traverses the screen edges and is sensitive to pointer
acceleration — it is a workaround, not a fix.

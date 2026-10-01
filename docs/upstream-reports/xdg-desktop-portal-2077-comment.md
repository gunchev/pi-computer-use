# Comment for flatpak/xdg-desktop-portal#2077

> Ready to paste into
> https://github.com/flatpak/xdg-desktop-portal/issues/2077
> and/or https://github.com/flatpak/xdg-desktop-portal/pull/2078

---

Confirming the same symptom on a **Monitor** source (not Virtual), where the root
cause is different — worth flagging so nobody lands #2078 and treats the symptom as
resolved for all backends.

**Environment:** xdg-desktop-portal 1.22.1, xdg-desktop-portal-kde 6.7.5,
Plasma 6.7.5, Fedora 44, Wayland, single 3840×2160 display at 150% scale.

## What I observed

`NotifyPointerMotionAbsolute` fails with `Invalid position` for **every**
coordinate. Swept: `(0,0) (100,100) (1280,720) (2559,1439) (1920,1080)
(3839,2159)` → 0 accepted, 6 rejected.

Unlike the case in #2077:

```
source_type = 1                                   # real Monitor, not Virtual
size        = (2560, 1440)                        # reported correctly, not (0,0)
```

So the "unnegotiated virtual stream size" cause does not apply here.

## I built and tested PR #2078 against it

Cloned 1.22.1, applied the patch (path-rewritten `desktop-portal/` → `src/`,
which is the 1.22.1 layout), `ninja`, ran the patched frontend as the portal
(verified via `/proc/<pid>/exe`), re-ran the sweep:

**Still 0/6 accepted.**

Both of the PR's fixes operate on `remote_desktop_session->streams`, and that list
is **empty** in my case:

```c
static gboolean
check_position (XdpSession *session, uint32_t stream, double x, double y)
{
  RemoteDesktopSession *remote_desktop_session = REMOTE_DESKTOP_SESSION (session);
  GList *l;

  for (l = remote_desktop_session->streams; l; l = l->next)   /* empty: body never runs */
    {
      ...
    }

  return FALSE;
}
```

The stream list is filled by `process_results()` from the **RemoteDesktop** `Start`
response — not from the ScreenCast session:

```c
if (g_variant_lookup (results, "streams", "a(ua{sv})", &streams_iter))
  {
    remote_desktop_session->streams = collect_screen_cast_stream_data (streams_iter);
  }
```

And measured back-to-back on one session:

```
SC.Start keys : ['streams']       node 213, size = (2560, 1440)   # ScreenCast fine
RD.Start keys : ['clipboard_enabled', 'devices']                  # no 'streams'
RD devices    : 3                                                 # keyboard|pointer granted
```

The backend simply never emits `streams` on the RemoteDesktop side. (Root cause is
on the KDE side: `RemoteDesktopSession::setScreenSharingEnabled(true)` is never
called, so `continueStart()` never builds streams. Filed separately against
xdg-desktop-portal-kde.)

Worth noting about the PR's test coverage: `tests/templates/remotedesktop.py` in
#2078 *injects* a `streams` key into the mocked RemoteDesktop `Start` response —
which is exactly the thing this KDE bug prevents from ever being sent. So the new
tests pass while the real-world KDE path stays broken.

## Also affected: EIS

Same underlying state problem starves the EIS path too. `ConnectToEIS` returns a
valid fd and `ei_setup_backend_fd()` returns 0, but the server sends only:

```
[0.00s] EI_EVENT_SYNC      (91)
[0.00s] EI_EVENT_CONNECT  (1)
... 20s of select() + ei_dispatch() ...
EI_EVENT_SEAT_ADDED seen: False
```

No seat is ever announced, so a client cannot request a device. Tried
`deviceTypes` 3 and 7.

## On the PR itself

The shadowed-parameter fix is a genuine bug and stands on its own merits — please
don't take the above as opposition. And the `has_size` change is right for the
Virtual case it was written for.

My point is only that `check_position()` returning `FALSE` because the stream list
is **empty** is a third distinct failure mode, invisible to both fixes, and it is
what KDE users actually hit. Might be worth:

1. A debug/warning log when `check_position()` finds an empty stream list, so this
   is diagnosable instead of surfacing as an opaque `Invalid position`; and
2. Considering whether the frontend should fall back to the associated ScreenCast
   session's streams when the RemoteDesktop `Start` response omits them — that
   would make this class of backend omission non-fatal.

Happy to re-test any iteration against the same repro.

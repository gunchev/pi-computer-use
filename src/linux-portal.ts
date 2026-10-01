/**
 * Linux backend: Wayland-safe capture + input via the RemoteDesktop portal.
 *
 * Mirrors the shape of native-helper.ts (which embeds and compiles Swift for
 * macOS). Here we embed a small Python daemon that owns a long-lived
 * org.freedesktop.portal.RemoteDesktop session and expose the same
 * command/env-var contract the rest of the extension already uses, so the
 * nativeClick / nativeDrag / nativeScroll helpers need no changes.
 *
 * Why the portal and not raw uinput:
 *   A uinput tablet (BTN_TOOL_PEN + ABS_X/Y) or touchscreen (ABS_MT_* +
 *   BTN_TOUCH) delivers events that reach libinput pixel-exact, but KDE Plasma
 *   ignores synthetic tablet/touch input for UI interaction — that path exists
 *   for drawing tablets feeding apps like Krita. Portal-created input is made by
 *   the compositor itself and is treated as real.
 *
 * Non-obvious portal facts baked in here (each cost a debugging cycle):
 *   1. session_handle_token is MANDATORY on CreateSession. Omitting it makes
 *      xdp_session_initable_init assert on a NULL token and abort() the portal.
 *   2. Token charset is [A-Za-z0-9_] only — it becomes a D-Bus object path element.
 *   3. The object path is LOWERCASE /org/freedesktop/portal/desktop on KDE.
 *   4. CreateSession is async: it returns a /request/… whose Response signal
 *      carries the real session_handle.
 *   5. SelectDevices takes a "types" UInt32 bitmask (1=keyboard, 2=pointer,
 *      4=touch), not booleans. Wrong keys => response code 2 (cancelled).
 *   6. Sessions die with the creating D-Bus connection, hence the daemon.
 *   7. NotifyPointerMotionAbsolute is broken in xdg-desktop-portal-kde 6.7.5
 *      ("Invalid position" for every input), so absolute targeting is emulated
 *      with park-and-count relative motion.
 */

import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DAEMON_NAME = "pi-compuse-portal.py";
const SOCKET_NAME = "pi-compuse-portal.sock";
const DAEMON_START_TIMEOUT_MS = 240_000; // consent dialogs need human time
const CALL_TIMEOUT_MS = 30_000;

/** The embedded Linux input daemon. Written to disk and run as a long-lived process. */
const LINUX_DAEMON_SOURCE = String.raw`#!/usr/bin/env python3
"""pi-compuse-portal: RemoteDesktop-portal input daemon for Linux/Wayland.

Newline-delimited JSON over a unix socket. Commands:
  {"cmd":"status"}
  {"cmd":"move","x":int,"y":int}
  {"cmd":"click","x":int,"y":int,"button":"left|right|middle","clicks":int}
  {"cmd":"key","code":int}
  {"cmd":"combo","codes":[int,...]}
  {"cmd":"scroll","ticks":int,"horizontal":bool}
  {"cmd":"park"}
  {"cmd":"invalidate"}      mark tracked position untrusted (re-parks on next move)
  {"cmd":"shutdown"}

Coordinates are LOGICAL pixels (device px / display scale).
"""
import json, os, re, socket, subprocess, sys, secrets, threading, time
from pathlib import Path

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

PORTAL_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"   # lowercase on KDE
SC = "org.freedesktop.portal.ScreenCast"
RD = "org.freedesktop.portal.RemoteDesktop"
RUNTIME = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp"))
SOCK = Path(os.environ.get("PI_COMPUSE_PORTAL_SOCKET") or (RUNTIME / "pi-compuse-portal.sock"))
KEYBOARD, POINTER = 1, 2
BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}
# The portal has no modifier field on button events, so modifiers are held as
# real key presses around the click.
MOD_KEYS = {"shift": 42, "control": 29, "ctrl": 29, "alt": 56, "option": 56,
            "meta": 125, "super": 125, "command": 125, "cmd": 125}
RESPONSE_TIMEOUT = 180
PARK_STEP = 5000


def log(m):
    sys.stderr.write("[portal] %s\n" % m); sys.stderr.flush()


def geometry():
    """Logical screen size + scale from kscreen-doctor (ANSI-coloured output)."""
    try:
        raw = subprocess.run(["kscreen-doctor", "-o"], capture_output=True, text=True, timeout=5).stdout
        out = re.sub(r"\x1b\[[0-9;]*m", "", raw)
        scale, w, h = 1.0, None, None
        for line in out.splitlines():
            s = line.strip()
            if s.startswith("Scale:"):
                try:
                    scale = float(s.split(":", 1)[1].strip()) or 1.0
                except ValueError:
                    scale = 1.0
            elif s.startswith("Modes:"):
                toks = [t for t in s.split(":", 1)[1].split() if "x" in t and "@" in t]
                pick = ([t for t in toks if "*" in t] or toks)
                m = re.search(r"(\d+)x(\d+)", pick[0] if pick else "")
                if m:
                    w, h = int(m.group(1)), int(m.group(2))
        if w and h:
            return dict(device_w=w, device_h=h, scale=scale,
                       logical_w=int(round(w / scale)), logical_h=int(round(h / scale)))
    except Exception as ex:
        log("geometry probe failed: %s" % ex)
    return dict(device_w=1920, device_h=1080, scale=1.0, logical_w=1920, logical_h=1080)


class Portal:
    def __init__(self):
        self.bus = dbus.SessionBus()
        self.geo = geometry()
        self.px = self.geo["logical_w"] // 2
        self.py = self.geo["logical_h"] // 2
        self.stream = None
        self.rd = None
        # The tracked position above is a guess until we have parked once. Without
        # this, the first absolute action after a daemon start is aimed from a
        # phantom origin (screen centre) and can land far off target.
        self.synced = False

    def _await(self, req_path, what):
        got = {}
        loop = GLib.MainLoop()

        def cb(code, results):
            got["c"] = int(code)
            got["r"] = {str(k): v for k, v in results.items()}
            if loop.is_running():
                loop.quit()

        sid = self.bus.add_signal_receiver(cb, signal_name="Response",
                                         dbus_interface="org.freedesktop.portal.Request",
                                         path=str(req_path))
        timer = GLib.timeout_add_seconds(RESPONSE_TIMEOUT, lambda: loop.is_running() and loop.quit())
        try:
            loop.run()
        finally:
            GLib.source_remove(timer)
            sid.remove()
        if "c" not in got:
            raise RuntimeError("%s: no response (timed out or cancelled)" % what)
        return got["c"], got["r"]

    def _call(self, iface, meth, *a):
        obj = self.bus.get_object(PORTAL_NAME, PORTAL_PATH)
        return getattr(dbus.Interface(obj, iface), meth)(*a)

    def _create(self, iface, tag):
        # token is mandatory and must be [A-Za-z0-9_] only, else the portal abort()s
        tok = "piconapuse_%s_%s" % (tag, secrets.token_hex(8))
        path = str(self._call(iface, "CreateSession",
                             dbus.Dictionary({"session_handle_token": tok}, signature="sv")))
        code, res = self._await(path, "%s.CreateSession" % iface)
        if code != 0:
            raise RuntimeError("%s.CreateSession code=%s" % (iface, code))
        return str(res["session_handle"])

    def connect(self):
        log("negotiating portal sessions - approve the consent dialogs")
        sc = self._create(SC, "sc")
        self._await(self._call(SC, "SelectSources", sc, dbus.Dictionary({
            "sources": dbus.Array([(1, 1)], signature="(ii)"),
            "persistent": dbus.Boolean(True),
            "cursor-mode": dbus.Int32(1),
        }, signature="sv")), "ScreenCast.SelectSources")
        code, res = self._await(self._call(SC, "Start", sc, "",
                                         dbus.Dictionary({}, signature="sv")), "ScreenCast.Start")
        if code != 0:
            raise RuntimeError("ScreenCast.Start code=%s" % code)
        streams = res.get("streams") or []
        if not streams:
            raise RuntimeError("no screencast streams")
        self.stream = int(streams[0][0])

        self.rd = self._create(RD, "rd")
        # "types" is a UInt32 bitmask, NOT booleans
        code, _ = self._await(self._call(RD, "SelectDevices", self.rd,
                                       dbus.Dictionary({"types": dbus.UInt32(KEYBOARD | POINTER)},
                                                       signature="sv")), "SelectDevices")
        if code != 0:
            raise RuntimeError("SelectDevices code=%s" % code)
        code, res = self._await(self._call(RD, "Start", self.rd, "",
                                         dbus.Dictionary({"session_handle": dbus.String(sc)},
                                                         signature="sv")), "RemoteDesktop.Start")
        if code != 0:
            raise RuntimeError("RemoteDesktop.Start code=%s" % code)
        granted = int(res.get("devices", 0))
        if not granted & POINTER:
            raise RuntimeError("pointer not granted (devices=%s)" % granted)
        log("session live: devices=%s stream=%s" % (granted, self.stream))

    # ── primitives ────────────────────────────────────────────────────────
    def _s(self):
        return dbus.ObjectPath(str(self.rd))

    def _e(self):
        return dbus.Dictionary({}, signature="sv")

    def _rel(self, dx, dy):
        self._call(RD, "NotifyPointerMotion", self._s(), self._e(),
                  dbus.Double(float(dx)), dbus.Double(float(dy)))

    def park(self):
        """Clamp the pointer to (0,0) so relative moves have a known origin.

        NOTE: passes through the top-left hot corner; keep the dwell short.
        """
        for _ in range(2):
            self._rel(-PARK_STEP, -PARK_STEP)
            time.sleep(0.05)
        self.px = self.py = 0
        self.synced = True

    def ensure_synced(self):
        """Park once so subsequent absolute moves are aimed from a known origin.

        Only the first absolute action pays for this; later ones reuse the
        tracked position until something desynchronises it.
        """
        if not self.synced:
            self.park()

    def invalidate_sync(self):
        """Mark the tracked position as untrusted (external pointer movement)."""
        self.synced = False

    def move_to(self, x, y):
        """Absolute move emulated with park-and-count (no working absolute API)."""
        self.ensure_synced()
        x = max(0, min(self.geo["logical_w"] - 1, int(x)))
        y = max(0, min(self.geo["logical_h"] - 1, int(y)))
        if x < self.px or y < self.py:
            self.park()
        self._rel(x - self.px, y - self.py)
        self.px, self.py = x, y
        time.sleep(0.03)

    def click(self, x, y, button="left", clicks=1, mods=None):
        code = BTN.get(button)
        if code is None:
            raise ValueError("unknown button %r" % button)
        self.move_to(x, y)
        time.sleep(0.05)
        self.with_mods(mods, lambda: self._click_n(code, clicks))

    def _click_n(self, code, clicks):
        for _ in range(max(1, clicks)):
            self._call(RD, "NotifyPointerButton", self._s(), self._e(), dbus.UInt32(code), dbus.Int32(1))
            time.sleep(0.06)
            self._call(RD, "NotifyPointerButton", self._s(), self._e(), dbus.UInt32(code), dbus.Int32(0))
            time.sleep(0.07)

    def with_mods(self, mods, fn):
        codes = [MOD_KEYS[m] for m in (mods or []) if m in MOD_KEYS]
        for c in codes:
            self.key(c, True)
        time.sleep(0.03)
        try:
            fn()
        finally:
            for c in reversed(codes):
                self.key(c, False)

    def drag(self, fx, fy, tx, ty, steps=24, duration_ms=450, button="left", mods=None):
        """Button-down, walk in steps, button-up. Uses relative motion throughout."""
        code = BTN.get(button, BTN["left"])
        steps = max(2, int(steps))
        self.move_to(fx, fy)
        time.sleep(0.05)

        def walk():
            self._call(RD, "NotifyPointerButton", self._s(), self._e(), dbus.UInt32(code), dbus.Int32(1))
            time.sleep(0.05)
            per = max(0.004, (duration_ms / 1000.0) / steps)
            dx = (tx - fx) / steps
            dy = (ty - fy) / steps
            for _ in range(steps):
                self._rel(dx, dy)
                time.sleep(per)
            self._call(RD, "NotifyPointerButton", self._s(), self._e(), dbus.UInt32(code), dbus.Int32(0))
            self.px, self.py = tx, ty
            time.sleep(0.05)

        self.with_mods(mods, walk)

    def click_and_hold(self, x, y, hold_ms, button="left"):
        code = BTN.get(button, BTN["left"])
        self.move_to(x, y)
        time.sleep(0.05)
        self._call(RD, "NotifyPointerButton", self._s(), self._e(), dbus.UInt32(code), dbus.Int32(1))
        time.sleep(max(0.05, hold_ms / 1000.0))
        self._call(RD, "NotifyPointerButton", self._s(), self._e(), dbus.UInt32(code), dbus.Int32(0))
        time.sleep(0.05)

    def key(self, code, down):
        self._call(RD, "NotifyKeyboardKeycode", self._s(), self._e(),
                  dbus.Int32(int(code)), dbus.Int32(1 if down else 0))

    def tap_key(self, code):
        self.key(code, True); time.sleep(0.05); self.key(code, False)

    def combo(self, codes):
        for c in codes:
            self.key(c, True); time.sleep(0.03)
        for c in reversed(codes):
            self.key(c, False); time.sleep(0.03)

    def scroll(self, ticks, horizontal=False):
        self._call(RD, "NotifyPointerAxisDiscrete", self._s(), self._e(),
                  dbus.UInt32(0 if horizontal else 2), dbus.Int32(int(ticks)))


class Server:
    def __init__(self):
        self.p = Portal()
        self.p.connect()
        self.lock = threading.Lock()
        self.running = True

    def handle(self, r):
        p = self.p
        c = r.get("cmd")
        with self.lock:
            if c == "status":
                return dict(ok=True, **p.geo, at=[p.px, p.py], stream=p.stream,
                          rd=p.rd, synced=p.synced)
            if c == "move":
                p.move_to(r["x"], r["y"]); return dict(ok=True, at=[p.px, p.py])
            if c == "click":
                p.click(r["x"], r["y"], r.get("button", "left"), int(r.get("clicks", 1)),
                        r.get("mods"))
                return dict(ok=True, at=[p.px, p.py])
            if c == "drag":
                p.drag(r["from"][0], r["from"][1], r["to"][0], r["to"][1],
                       int(r.get("steps", 24)), int(r.get("duration_ms", 450)),
                       r.get("button", "left"), r.get("mods"))
                return dict(ok=True, at=[p.px, p.py])
            if c == "hold":
                p.click_and_hold(r["x"], r["y"], int(r.get("hold_ms", 500)),
                                r.get("button", "left"))
                return dict(ok=True, at=[p.px, p.py])
            if c == "key":
                p.tap_key(int(r["code"])); return dict(ok=True)
            if c == "combo":
                p.combo([int(x) for x in r["codes"]]); return dict(ok=True)
            if c == "scroll":
                p.scroll(int(r.get("ticks", 0)), bool(r.get("horizontal", False)))
                return dict(ok=True)
            if c == "park":
                p.park(); return dict(ok=True)
            if c == "invalidate":
                p.invalidate_sync(); return dict(ok=True, synced=p.synced)
            if c == "shutdown":
                self.running = False; return dict(ok=True)
        raise ValueError("unknown cmd %r" % c)

    def serve(self):
        if SOCK.exists():
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(1.0); s.connect(str(SOCK)); s.close()
                raise RuntimeError("a daemon already owns %s" % SOCK)
            except ConnectionRefusedError:
                SOCK.unlink()
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(SOCK)); os.chmod(SOCK, 0o600); srv.listen(16); srv.settimeout(0.5)
        log("listening on %s" % SOCK)
        try:
            while self.running:
                try:
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self._conn, args=(conn,), daemon=True).start()
        finally:
            srv.close()
            try:
                SOCK.unlink()
            except OSError:
                pass
            log("shut down")

    def _conn(self, conn):
        buf = b""
        with conn:
            conn.settimeout(60.0)
            while self.running:
                try:
                    chunk = conn.recv(65536)
                except (socket.timeout, OSError):
                    return
                if not chunk:
                    return
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        resp = self.handle(json.loads(line))
                    except Exception as ex:
                        resp = {"ok": False, "error": "%s: %s" % (type(ex).__name__, ex)}
                    conn.sendall(json.dumps(resp).encode() + b"\n")


if __name__ == "__main__":
    Server().serve()
`;

export interface LinuxGeometry {
	device_w: number;
	device_h: number;
	scale: number;
	logical_w: number;
	logical_h: number;
}

function runtimeDir(): string {
	return process.env.XDG_RUNTIME_DIR || "/tmp";
}

function socketPath(): string {
	return process.env.PI_COMPUSE_PORTAL_SOCKET || join(runtimeDir(), SOCKET_NAME);
}

function cacheDir(): string {
	return join(tmpdir(), "pi-compuse-linux");
}

/** Write the embedded daemon to disk (content-addressed so updates are picked up). */
async function ensureDaemonScript(): Promise<string> {
	const dir = cacheDir();
	await mkdir(dir, { recursive: true });
	const hash = createHash("sha256").update(LINUX_DAEMON_SOURCE).digest("hex").slice(0, 12);
	const path = join(dir, `pi-compuse-portal-${hash}.py`);
	if (!existsSync(path)) {
		await writeFile(path, LINUX_DAEMON_SOURCE, { mode: 0o755 });
	}
	return path;
}

function socketAlive(): Promise<boolean> {
	return new Promise(resolve => {
		const s = net.createConnection(socketPath());
		s.once("connect", () => { s.destroy(); resolve(true); });
		s.once("error", () => resolve(false));
		s.setTimeout(1500, () => { s.destroy(); resolve(false); });
	});
}

/** Start the daemon if it is not already listening. */
export async function ensureLinuxDaemon(): Promise<void> {
	if (await socketAlive()) return;

	const script = await ensureDaemonScript();
	const child = spawnDetached(script);
	const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await socketAlive()) return;
		if (child.exitCode !== null && child.exitCode !== undefined) {
			throw new Error(
				`Linux portal daemon exited (code ${child.exitCode}). ` +
				`Check that python3-dbus / python3-gobject and xdg-desktop-portal-kde are installed.`,
			);
		}
		await sleep(500);
	}
	throw new Error("Linux portal daemon did not come up in time (were the consent dialogs approved?)");
}

function spawnDetached(script: string) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { spawn } = require("node:child_process");
	const log = require("node:fs").openSync(join(tmpdir(), "pi-compuse-portal.log"), "a");
	return spawn("python3", [script, ], {
		detached: true,
		stdio: ["ignore", log, log],
		env: process.env,
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

/** Send one JSON command to the daemon and return its reply. */
export function linuxCall(req: Record<string, unknown>): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		const s = net.createConnection(socketPath());
		s.setTimeout(CALL_TIMEOUT_MS, () => { s.destroy(); reject(new Error("portal daemon call timed out")); });
		let buf = "";
		s.once("connect", () => s.write(JSON.stringify(req) + "\n"));
		s.on("data", chunk => {
			buf += chunk.toString();
			if (buf.includes("\n")) {
				s.destroy();
				try {
					resolve(JSON.parse(buf.split("\n", 1)[0]));
				} catch (e: any) {
					reject(new Error(`bad daemon reply: ${e.message}`));
				}
			}
		});
		s.on("error", e => reject(e));
		s.on("close", () => { if (!buf.trim()) reject(new Error("daemon closed without reply")); });
	});
}

/** Geometry without needing a live session (pure kscreen-doctor read). */
export async function linuxGeometry(): Promise<LinuxGeometry> {
	try {
		const { stdout } = await execFileAsync("kscreen-doctor", ["-o"], { timeout: 5000 });
		const out = stdout.replace(/\x1b\[[0-9;]*m/g, "");
		let scale = 1.0, w: number | null = null, h: number | null = null;
		for (const raw of out.split("\n")) {
			const s = raw.trim();
			if (s.startsWith("Scale:")) {
				const v = parseFloat(s.split(":")[1]?.trim() || "");
				scale = Number.isFinite(v) && v > 0 ? v : 1.0;
			} else if (s.startsWith("Modes:")) {
				const toks = s.split(":")[1].split(/\s+/).filter(t => t.includes("x") && t.includes("@"));
				const active = toks.filter(t => t.includes("*"));
				const pick = (active.length ? active : toks)[0] || "";
				const m = /(\d+)x(\d+)/.exec(pick);
				if (m) { w = parseInt(m[1], 10); h = parseInt(m[2], 10); }
			}
		}
		if (w && h) {
			return {
				device_w: w, device_h: h, scale,
				logical_w: Math.round(w / scale), logical_h: Math.round(h / scale),
			};
		}
	} catch {
		/* fall through */
	}
	return { device_w: 1920, device_h: 1080, scale: 1.0, logical_w: 1920, logical_h: 1080 };
}

/**
 * Full-display capture via Spectacle.
 * `-b` background (no GUI), `-n` capture now, `-o` output file.
 * Verified silent on Plasma 6 — unlike `-u`/`-r`, which open an interactive picker.
 */
export async function linuxCapture(filePath: string): Promise<void> {
	await execFileAsync("spectacle", ["-b", "-n", "-o", filePath], {
		timeout: 30_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (!existsSync(filePath)) {
		throw new Error("spectacle produced no output file");
	}
}

/** Downscale/compress with ImageMagick (the Linux stand-in for macOS `sips`). */
export async function linuxDownsize(
	srcPath: string,
	maxDimension: number,
	maxBytes: number,
): Promise<{ bytes: Buffer; mimeType: string; width?: number; height?: number } | null> {
	const raw = await readFile(srcPath);
	const width = raw.readUInt32BE(16);
	const height = raw.readUInt32BE(20);
	const needsResize = width > maxDimension || height > maxDimension;
	const needsCompress = raw.length > maxBytes;
	if (!needsResize && !needsCompress) {
		return { bytes: raw, mimeType: "image/png", width, height };
	}
	const outPath = srcPath.replace(/\.png$/, "-small.jpg");
	const args: string[] = [srcPath];
	if (needsResize) {
		const scale = maxDimension / Math.max(width, height);
		args.push("-resize", `${Math.round(width * scale)}x${Math.round(height * scale)}!`);
	}
	args.push("-quality", "70", outPath);
	try {
		await execFileAsync("convert", args, { timeout: 30_000 });
		const bytes = await readFile(outPath);
		const jw = needsResize ? Math.round(width * (maxDimension / Math.max(width, height))) : width;
		const jh = needsResize ? Math.round(height * (maxDimension / Math.max(width, height))) : height;
		return { bytes, mimeType: "image/jpeg", width: jw, height: jh };
	} catch {
		return { bytes: raw, mimeType: "image/png", width, height };
	}
}

export { DAEMON_NAME };

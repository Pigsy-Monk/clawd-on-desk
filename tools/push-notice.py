#!/usr/bin/env python3
"""Push a notice card to the Clawd desktop pet.

The agent-side half of the notice feature: reads the running Clawd's port from
`~/.clawd/runtime.json` and talks to its loopback `/notice` route — POST pushes
a card, DELETE takes one back.

NOTE — this is the repo's own copy. The canonical one, the one every agent on
this machine is pointed at, lives at `~/.claude/skills/pet-notice/bin/`. Keep
the two in step when the wire schema changes; this copy exists so the repo is
self-contained for anyone who cloned only agent-pet.

    push-notice.py "Build failed" "3 tests did not pass" --level error
    echo "long body" | push-notice.py "Title"

    # a trend card: one sparkline per series, value defaults to the last point
    push-notice.py "引擎发布监控" --level warn --ttl-seconds 300 \
        --series "SHA-ALI 耗时=150,152,149,151,163@ms" \
        --series "SHA-ALI 失败率=0.08,0.07,0.09@%" \
        --image trend.png

    # a monitoring card that must be seen at once: no sign, no click
    push-notice.py "引擎发布监控" --level warn --ttl-seconds 300 --presentation card

    # a keyed card: the next push under the same key refreshes this one in
    # place — same card, same spot in the stack — instead of stacking a twin
    push-notice.py "心跳" "仍在运行" --key heartbeat --ttl-seconds 30

    # take a card back: --clear removes every live card, --clear KEY removes the
    # one carrying that key. Without this a cancelled countdown keeps lying on
    # screen until its ttl runs out.
    push-notice.py --clear
    push-notice.py --clear pomodoro

`--key` makes a push idempotent. A keyed push whose key matches a card that is
still on screen replaces it (and restarts its lifetime), so a heartbeat or a
countdown can push every few seconds and leave exactly one card behind. Without
a key every push is a new card, which is the original behaviour.

`--clear` is the retraction. On its own it empties the stack; given a value it
removes the card carrying that key — the same identity `--key` pushed under, so
a cancelled timer can retract exactly the card it made. Either way it reports
through its exit code; the count of cards actually removed is Clawd's answer,
not a promise that a particular card was there.

Stdlib only, on purpose: this is meant to be droppable into any agent harness
without a pip install.

Encoding: pass text as arguments or pipe it in — both are safe. This tool sends
UTF-8, and `json.dumps` escapes non-ASCII into ASCII `\\uXXXX` sequences, so the
bytes on the wire are plain ASCII whatever the console codepage happens to be.

The trap is a hand-rolled `curl`. On Windows, MSYS `curl` is a native binary
whose argv arrives in the ANSI codepage — GBK on a zh-CN box — so

    curl -d '{"body":"中文"}' http://127.0.0.1:23333/notice

puts GBK bytes on a wire the server decodes as UTF-8. The card renders as
mojibake and the server gets blamed for a bug that is in the invocation. Keep
non-ASCII out of curl's argv:

    curl -X POST http://127.0.0.1:23333/notice \\
        -H "Content-Type: application/json" --data-binary @payload.json

(the transport guard wants that Content-Type on DELETE as well, plus a selector
body — `{"all":true}` or `{"key":...}`).

Exit codes:
    0  notice accepted, or clear succeeded
    1  could not reach Clawd, or Clawd rejected the request
    2  bad usage
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Must match hooks/server-config.js. `app` is validated on read because any
# process running as this user can write runtime.json — a stale or foreign file
# must not route our notice at some unrelated listener.
CLAWD_APP_ID = "clawd-on-desk"
CLAWD_SERVER_HEADER = "x-clawd-server"
SERVER_PORTS = range(23333, 23338)

LEVELS = ("info", "success", "warn", "error")

DEFAULT_TTL_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 5

# `--clear` takes an optional value, so argparse hands the flag given without
# one this `const`. The empty string is therefore the "every card" spelling, and
# it cannot collide with a real key: normalize_key rejects an empty one.
CLEAR_ALL = ""

# Mirror src/notice-store.js. Clawd re-validates and silently drops anything
# over these, so catching them here turns a mystery into an error message.
MAX_SERIES = 8
MAX_SERIES_POINTS = 240
MAX_SERIES_NAME_LENGTH = 40
MAX_SERIES_UNIT_LENGTH = 12
MAX_KEY_LENGTH = 64
MAX_IMAGE_BYTES = 6 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def runtime_config_path():
    """Mirror hooks/server-config.js defaultRuntimeConfigPath()."""
    return Path(os.path.expanduser("~")) / ".clawd" / "runtime.json"


def read_runtime_port():
    """Return the live Clawd port, or (None, reason).

    Deliberately never falls back to a hardcoded 23333: the port range is
    shared and the running instance may hold any of 23333-23337.
    """
    path = runtime_config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"no runtime file at {path} (is Clawd running?)"
    except (OSError, ValueError) as exc:
        return None, f"cannot read {path}: {exc}"

    if not isinstance(raw, dict):
        return None, f"{path} is not a JSON object"
    if raw.get("app") != CLAWD_APP_ID:
        return None, f"{path} belongs to another app (app={raw.get('app')!r})"

    port = raw.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or port not in SERVER_PORTS:
        return None, f"{path} has an unusable port ({port!r})"
    return port, None


def read_body_from_stdin():
    if sys.stdin is None or sys.stdin.isatty():
        return ""
    try:
        return sys.stdin.read()
    except (OSError, UnicodeDecodeError):
        return ""


def parse_series(spec):
    """Parse `NAME=p1,p2,p3[@unit]` into a series dict, or raise ValueError."""
    if "=" not in spec:
        raise ValueError(f"expected NAME=1,2,3[@unit], got {spec!r}")
    name, _, rest = spec.partition("=")
    name = name.strip()
    if not name:
        raise ValueError(f"series name is empty in {spec!r}")

    unit = ""
    if "@" in rest:
        rest, _, unit = rest.partition("@")
        unit = unit.strip()

    points = []
    for chunk in rest.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            points.append(float(chunk))
        except ValueError:
            raise ValueError(f"series {name!r} has a non-numeric point {chunk!r}")

    if len(points) < 2:
        raise ValueError(f"series {name!r} needs at least 2 points, got {len(points)}")

    # Clawd keeps the tail; trimming here makes the CLI's behaviour visible
    # rather than silently losing the points the caller thought it sent.
    if len(points) > MAX_SERIES_POINTS:
        points = points[-MAX_SERIES_POINTS:]

    # Integral points read better as 150 than 150.0.
    points = [int(p) if p.is_integer() else p for p in points]
    return {"name": name[:MAX_SERIES_NAME_LENGTH], "points": points,
            "value": points[-1], "unit": unit[:MAX_SERIES_UNIT_LENGTH]}


def normalize_key(value):
    """Mirror normalizeKey() in src/notice-store.js, or raise ValueError.

    Clawd treats an unusable key as absent, which is the safe reading on its
    side but a silent trap on this one: a heartbeat whose key was quietly
    dropped stacks a card per beat. So a key this CLI cannot vouch for is an
    error here rather than a mystery there.
    """
    key = value.strip()
    if not key:
        raise ValueError("--key must not be empty")
    if len(key) > MAX_KEY_LENGTH:
        raise ValueError(f"--key is {len(key)} chars, over Clawd's {MAX_KEY_LENGTH} limit")
    # \p{Cc}: C0 (0000-001F), DEL (007F) and C1 (0080-009F).
    if any(ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F for ch in key):
        raise ValueError("--key must not contain control characters")
    return key


def encode_image(path_text):
    """Read a PNG and return the image payload, or raise ValueError."""
    path = Path(path_text)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"cannot read image {path}: {exc}")
    if not raw.startswith(PNG_SIGNATURE):
        raise ValueError(f"{path} is not a PNG (bad signature)")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(
            f"{path} is {len(raw)} bytes, over Clawd's {MAX_IMAGE_BYTES} byte limit"
        )
    return {"mime": "image/png", "data": base64.b64encode(raw).decode("ascii")}


def build_payload(args):
    body = args.body if args.body is not None else read_body_from_stdin()
    payload = {
        "title": args.title,
        "body": body,
        "level": args.level,
    }
    # Only send a ttl when the caller picked one: leaving the field out lets
    # Clawd apply its per-level default, which is what a caller who never
    # thought about lifetime actually wants.
    if args.ttl_seconds is not None:
        payload["ttl"] = int(args.ttl_seconds * 1000)

    # The pet's own presentation (`bubble`) holds a sign up first and keeps the
    # card back until it is clicked. `card` asks for the card itself, at once,
    # with no sign and no click — the right choice for a monitoring push the
    # user may not be looking at. Omitted means the pet's own.
    if args.presentation is not None:
        payload["presentation"] = args.presentation

    # Only send a key when the caller gave one. An absent key is what makes a
    # push append a fresh card, and sending "" would be the same thing spelled
    # less clearly.
    if args.key is not None:
        payload["key"] = normalize_key(args.key)

    series = [parse_series(spec) for spec in args.series]
    if len(series) > MAX_SERIES:
        raise ValueError(f"at most {MAX_SERIES} series, got {len(series)}")
    if series:
        # `series` is what makes a chart card; Clawd derives `kind` from it, but
        # sending it explicitly documents the intent on the wire.
        payload["kind"] = "trend"
        payload["series"] = series

    if args.image:
        payload["image"] = encode_image(args.image)

    return payload


def build_delete_payload(args):
    """Return the selector body for DELETE /notice, or raise ValueError.

    `--clear` alone means every live card; `--clear KEY` means the one card
    carrying that key. Clawd refuses a body that names no selector at all, which
    is what stops an accidental empty DELETE from wiping the stack — so this
    never sends one.
    """
    if args.clear == CLEAR_ALL:
        return {"all": True}
    return {"key": normalize_key(args.clear)}


def send_notice_request(port, method, payload, what):
    """Send one /notice request. Returns (result, error).

    `what` names the operation in error messages ("notice", "clear"). Exactly
    one of the pair is set: the parsed response on success, a reason on failure.
    """
    url = f"http://127.0.0.1:{port}/notice"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8", "replace")
            headers = response.headers
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace").strip()
        return None, f"Clawd rejected the {what}: HTTP {exc.code} {detail}".strip()
    except (urllib.error.URLError, OSError) as exc:
        return None, f"could not reach Clawd on 127.0.0.1:{port}: {exc}"

    if headers.get(CLAWD_SERVER_HEADER) != CLAWD_APP_ID:
        return None, f"127.0.0.1:{port} answered but is not Clawd"
    try:
        result = json.loads(raw)
    except ValueError:
        return None, f"unreadable response from Clawd: {raw[:200]!r}"
    if not isinstance(result, dict) or result.get("ok") is not True:
        return None, f"Clawd did not accept the {what}: {result!r}"
    return result, None


def post_notice(port, payload):
    """POST one notice. Returns (ok, message)."""
    result, error = send_notice_request(port, "POST", payload, "notice")
    if error:
        return False, error
    return True, str(result.get("id", ""))


def delete_notice(port, payload):
    """DELETE the cards the selector names. Returns (ok, message).

    The message is the number Clawd says it removed. 0 is a success: naming a
    card that has already expired or was never there is not an error, and
    reporting the count is how a caller tells the two apart.
    """
    result, error = send_notice_request(port, "DELETE", payload, "clear")
    if error:
        return False, error
    return True, str(result.get("removed", 0))


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="push-notice.py",
        description="Push a notice card to the Clawd desktop pet.",
        epilog=(
            'Body may be piped: echo "text" | push-notice.py "Title"\n'
            'A trend card needs --series; --image adds a chart that opens on click.\n'
            '--key makes repeated pushes update one card instead of stacking new ones.\n'
            '--clear retracts: alone it empties the stack, with a KEY it removes that card.\n'
            '\n'
            'Non-ASCII is safe here — this tool escapes it before it reaches the wire.\n'
            'Hand-rolled curl is not: on Windows MSYS curl sends argv as GBK, which the\n'
            'server reads as UTF-8, so Chinese comes out as mojibake. If you must use\n'
            'curl, keep non-ASCII out of argv: write the JSON to a UTF-8 file and pass\n'
            '--data-binary @payload.json.'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "title",
        nargs="?",
        default=None,
        help="short headline for the card",
    )
    parser.add_argument(
        "body",
        nargs="?",
        default=None,
        help="card body; omitted reads stdin when piped",
    )
    parser.add_argument(
        "--clear",
        nargs="?",
        const=CLEAR_ALL,
        default=None,
        metavar="KEY",
        help=(
            "retract instead of pushing: on its own, remove every live card; "
            "with a KEY, remove the card that key names (the same key --key "
            "pushed under). Cannot be combined with a title, --key, --series "
            "or --image"
        ),
    )
    parser.add_argument(
        "--level", choices=LEVELS, default="info", help="accent level (default: info)"
    )
    parser.add_argument(
        "--key",
        metavar="KEY",
        default=None,
        help=(
            "identity for this card (max 64 chars). Pushing the same key again "
            "replaces the card the previous push made instead of stacking a "
            "second one; omit for a new card on every push"
        ),
    )
    parser.add_argument(
        "--ttl-seconds",
        type=float,
        default=None,
        help=(
            "seconds before the card auto-expires. Omit to let Clawd pick by "
            "level (info 20s, success 30s, warn 2min, error 5min)"
        ),
    )
    parser.add_argument(
        "--presentation",
        choices=("bubble", "card"),
        default=None,
        help=(
            "how Clawd shows the push. 'bubble' (default): the pet holds up a "
            "sign first and the card waits for a click. 'card': the card "
            "appears at once, no sign and no click, for its ttl"
        ),
    )
    parser.add_argument(
        "--series",
        action="append",
        default=[],
        metavar="NAME=1,2,3[@UNIT]",
        help=(
            "a trend line for the card; repeat for multiple series. "
            "The current value shown on the card is the last point. "
            "Passing any --series makes this a trend card."
        ),
    )
    parser.add_argument(
        "--image",
        metavar="PATH",
        default=None,
        help="a PNG chart to attach; the card becomes clickable to open it full size",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="override the port from runtime.json (debugging only)",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)

    try:
        if args.clear is not None:
            # A retraction carries no card, so the push-only arguments are a
            # contradiction rather than something to quietly ignore.
            conflicting = [
                name for name, given in (
                    ("a title", args.title is not None),
                    ("--key", args.key is not None),
                    ("--series", bool(args.series)),
                    ("--image", args.image is not None),
                ) if given
            ]
            if conflicting:
                print(
                    f"push-notice: --clear cannot be combined with {', '.join(conflicting)}",
                    file=sys.stderr,
                )
                return 2
            payload = build_delete_payload(args)
        else:
            if args.title is None or not args.title.strip():
                print("push-notice: title must not be empty", file=sys.stderr)
                return 2
            if args.ttl_seconds is not None and args.ttl_seconds <= 0:
                print("push-notice: --ttl-seconds must be positive", file=sys.stderr)
                return 2
            payload = build_payload(args)
    except ValueError as exc:
        print(f"push-notice: {exc}", file=sys.stderr)
        return 2

    if args.port is not None:
        if args.port not in SERVER_PORTS:
            print(f"push-notice: --port must be one of {list(SERVER_PORTS)}", file=sys.stderr)
            return 2
        port, reason = args.port, None
    else:
        port, reason = read_runtime_port()
    if port is None:
        print(f"push-notice: {reason}", file=sys.stderr)
        return 1

    if args.clear is not None:
        ok, message = delete_notice(port, payload)
    else:
        ok, message = post_notice(port, payload)
    if not ok:
        print(f"push-notice: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

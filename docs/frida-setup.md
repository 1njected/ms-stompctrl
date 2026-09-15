# Working Frida setup for this iPad

Verified September 8, 2026: iPad4,1 / iOS 12.5.7 / Amethyst-TNSv2 environment,
Frida 16.1.4, StompShare build 1.1.0.36. Attachment, injected JavaScript,
Objective-C access, hook installation, detach, and restart/reattach passed.

## Use the files already staged on the iPad

Run from the project directory. Keep StompShare running. In terminal 1:

```sh
python3 ../tools/frida/start-frida.py
```

SSH prompts for the iPad password. This discovers the current StompShare PID,
starts the adapted server, and forwards host `127.0.0.1:27043` to iPad
`127.0.0.1:27042`. It refuses ambiguous/missing app PIDs. Leave it running.
Ctrl-C stops the foreground server and tunnel; this shutdown was tested.

In terminal 2, prove attachment:

```sh
/tmp/stompshare-frida-env/bin/python ../tools/frida/attach-check.py
```

Or passively capture for a specified number of seconds:

```sh
/tmp/stompshare-frida-env/bin/python ../tools/frida/capture.py 60
```

The capture installs send/receive hooks, records current accessory information,
and appends events and hex packet fragments to `../tools/capture.jsonl`. It does
not initiate pedal operations. The attachment check writes
`../tools/attachment-check.json`. Run these clients sequentially.

If the temporary host Python environment has disappeared:

```sh
python3 -m venv /tmp/stompshare-frida-env
/tmp/stompshare-frida-env/bin/pip install frida==16.1.4
```

The server allows platformization requests only for its own PID and the
StompShare PID selected at startup. Restart the server after relaunching the app.
A refused PID 1 request may appear during enumeration; attachment to StompShare
still passed with that request refused. This is a task-specific adaptation,
not a general-purpose Frida installation.

## Why the stock server failed

Frida 16.1.4 detects Electra solely from `/usr/lib/libjailbreak.dylib` and requires
`jbd_call(port, command, pid)`. Amethyst provides that library path but exports
`jb_oneshot_entitle_now(pid, flags)` instead. The missing symbol caused the
assertion at `policy-softener.vala:228`. Internal mode requires a separate Frida
policy daemon and failed because it was absent.

`amethyst-compat.c` supplies the expected `jbd_call` ABI and translates command 1
into Amethyst's `FLAG_PLATFORMIZE` request. It deliberately does not request
target sandbox or credential changes. The Amethyst function returns void, so
the adapter's log alone cannot prove success; injected-script execution does.

Only two equal-size, NUL-padded path substitutions were made in a private arm64
Frida server copy, followed by re-signing with the stock server entitlements:

| Original | Private replacement |
|---|---|
| `/usr/lib/libjailbreak.dylib` | `/Library/stomp-jb.dylib` |
| `/usr/lib/frida/frida-agent.dylib` | `/Library/stomp-agent.dylib` |

The adapter loads the original system library to call Amethyst's actual API.
No system library was overwritten. `/Library` was necessary: `dlopen` of the
same adapter from `/var/tmp` failed with a sandbox-blocked `mmap()` error, while
loading from `/Library` succeeded. The helper uses the classic linker and an
iOS 12 deployment target; the initial new-linker diagnostic did not run on this
device.

The staged files are:

```text
/var/tmp/stomp-frida-server-compat3
/Library/stomp-jb.dylib
/Library/stomp-agent.dylib
```

The installed jailbreak library and StompShare files are unchanged. The
debugging API modifies runtime process flags; the target's original flags are
not restored by this adapter at detach. Restarting the app creates a new process.
No launch daemon or permanent tracing service was installed.

## Rebuild

The [official Frida 16.1.4 release](https://github.com/frida/frida/releases/tag/16.1.4)
contains `frida_16.1.4_iphoneos-arm.deb` (the rootful package). Its SHA-256 is:

```text
8439e333f26bcc934b45d6756262492d5ce66891d594895bd45245a730938566
```

On this Mac, the package currently exists at `/tmp/stompshare-frida.deb`:

```sh
python3 ../tools/frida/build-compat.py /tmp/stompshare-frida.deb
```

The script checks that hash, extracts the plain arm64 server, preserves its
entitlements, patches the two paths, compiles/signs the adapter, and packages the
three files in `../tools/frida/compat-build/deploy.tar`. It requires Xcode with
`ld-classic`, `ar`, and `ldid`. It does not access the iPad. This build completed
successfully during the investigation. Local build products are retained.

To redeploy these task-owned files while the tracer is stopped:

```sh
ssh root@<device-ip> 'tar -xf - -C /' < ../tools/frida/compat-build/deploy.tar
```

This replaces only the three private paths listed above. The first tested
adapter was compiled with a different install-name string; the rebuilt adapter
uses its final `/Library` path. It is loaded by explicit path in both cases.

## Evidence and limits

- `attachment-check.json`: final successful reattachment, script response and
  clean detach. StompShare PID 957, module base `0x1007a8000`, send method offset
  `0x412b4`, active data container `BEE6C666-9F1F-436C-8049-D534B1D3CA69`.
- `capture.jsonl`: hooks installed at `0x1007e92b4` (send) and `0x1007e91c0`
  (receive). ExternalAccessory reports connected `MS-100BT`, manufacturer ZOOM,
  protocol `jp.co.zoom.p1`, accessory firmware string `1.0.0`.
- The 15-second passive capture had no packet fragments. Both manager heap
  searches returned zero instances. This does not prove that no instances can
  exist or that a StompShare EASession is open. The connected-accessory result
  is an iOS-level observation, not a successful pedal transaction.
- No effect install, firmware update, purchase, or app restart was initiated.

Source references:

- [Exact Frida policy selection and symbol lookup](https://github.com/frida/frida-core/blob/808a3857573aa1ecc907ddb413abd6e27f5c22e3/src/darwin/policy-softener.vala)
- [Exact Frida adapter calling convention](https://github.com/frida/frida-core/blob/808a3857573aa1ecc907ddb413abd6e27f5c22e3/src/darwin/policy-softener-glue.c)
- [Amethyst public compatibility API](https://github.com/staturnzz/amethyst/blob/main/basebins/libjailbreak/src/main.c)


## Successful read-only protocol capture

The installed-effect management screen was opened with `open-installed-effects.js`; it showed LOFI_Rev and ShimmerRv from cached state. `record-query.py` then used `record-query.js` to hook transport and run the app's identity, directory, and disk-space queries through its own connection wrapper. This captured 115 TX and 115 RX frames, firmware 1.30, and 105 files. No effect or firmware write was requested.

Evidence: [decoded transcript and file list](../tools/protocol-20260908T150705Z.md), [raw messages](../tools/protocol-20260908T150705Z.jsonl), [decoded JSON](../tools/protocol-20260908T150705Z.decoded.json).

With the documented SSH/Frida server running and the pedal connected:

```sh
/tmp/stompshare-frida-env/bin/python ../tools/frida/record-query.py
python3 ../tools/decode-protocol.py ../tools/protocol-20260908T150705Z.jsonl
```

Use the newly generated timestamped filename when decoding a new recording. The decoder validates directory and disk values against the app's parsed results and checks the query's transmitted command set. The recording does not exercise file contents or the write protocol.

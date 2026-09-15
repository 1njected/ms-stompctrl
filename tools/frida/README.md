# Frida instrumentation

How the original StompShare app was observed on a jailbroken iOS device. This is
the research path, not part of running the pedal client — nothing here is needed
to use MS StompCtrl, and the protocol it produced is written up in
`docs/protocol.md`.

Source only. The compiled Frida server and agent are third-party builds of tens
of megabytes, and the captures they produced carry ZOOM effect binaries, so
neither is redistributed here. `build-compat.py` rebuilds the server from
Frida's own published `.deb`.

| | |
|---|---|
| `build-compat.py` | builds an arm64 Frida 16.1.4 adaptation from the official iOS `.deb`. Needs macOS, Xcode (including `ld-classic`), `ar` and `ldid`. |
| `amethyst-compat.c` | a private Frida/Electra ABI adapter for the Amethyst jailbreak. Replaces no system library; the patched server loads it as a temporary file. |
| `start-frida.py` | starts the staged server over SSH and forwards its port. Takes the device IP as an argument, or `STOMP_DEVICE_IP`. |
| `capture.py` | attaches and writes every hooked frame to `capture.jsonl`. |
| `inspect.js` | reports the bundle, version and module base. |
| `pedal-state.js` | walks the app delegate and dumps the pedal state it holds. |
| `open-installed-effects.js` | drives the app's own "Manage effects on the pedal" button, to make it perform an operation while hooked. |

`docs/frida-setup.md` has the working setup this was verified against.

The device address is never interpolated into remote shell text: `start-frida.py`
passes fixed remote code and supplies the host only as an `ssh` argument.

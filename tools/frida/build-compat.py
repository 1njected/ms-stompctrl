"""Build the tested arm64 Frida 16.1.4 adaptation from its official iOS .deb.

Usage: python3 tools/frida/build-compat.py /path/to/frida_16.1.4_iphoneos-arm.deb
Requires macOS, Xcode (including ld-classic), ar, and ldid.
"""
import argparse
import hashlib
import io
import pathlib
import struct
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("deb", type=pathlib.Path)
parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("tools/frida/compat-build"))
args = parser.parse_args()
expected = "8439e333f26bcc934b45d6756262492d5ce66891d594895bd45245a730938566"
if hashlib.sha256(args.deb.read_bytes()).hexdigest() != expected:
    raise SystemExit("Package hash differs from the tested official release; refusing binary patch.")
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
archive = subprocess.check_output(["ar", "p", str(args.deb.resolve()), "data.tar.xz"])
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as package:
    server = package.extractfile("./usr/sbin/frida-server").read()
    agent = package.extractfile("./usr/lib/frida/frida-agent.dylib").read()
magic, count = struct.unpack_from(">II", server)
if magic != 0xCAFEBABE:
    raise SystemExit("Unexpected Mach-O container")
for index in range(count):
    cpu, subtype, offset, size, align = struct.unpack_from(">IIIII", server, 8 + index * 20)
    if (cpu, subtype) == (0x0100000C, 0):
        server = server[offset:offset + size]
        break
else:
    raise SystemExit("No plain arm64 slice")
original = output / "frida-server-original-arm64"
original.write_bytes(server)
entitlements = output / "server-entitlements.plist"
entitlements.write_bytes(subprocess.check_output(["ldid", "-e", str(original)]))
for before, after in [
    (b"/usr/lib/libjailbreak.dylib", b"/Library/stomp-jb.dylib"),
    (b"/usr/lib/frida/frida-agent.dylib", b"/Library/stomp-agent.dylib"),
]:
    if server.count(before + b"\0") != 1 or len(after) > len(before):
        raise SystemExit("Unexpected path layout")
    server = server.replace(before + b"\0", after + b"\0" * (len(before) - len(after) + 1))
patched = output / "stomp-frida-server-compat3"
patched.write_bytes(server)
subprocess.run(["ldid", "-S" + str(entitlements), str(patched)], check=True)
patched.chmod(0o755)
sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip()
clang = subprocess.check_output(["xcrun", "--find", "clang"], text=True).strip()
adapter = output / "stomp-jb.dylib"
subprocess.run([
    clang, "-target", "arm64-apple-ios12.0", "-isysroot", sdk,
    "-Wl,-ld_classic", "-dynamiclib", "-O2",
    "-Wl,-install_name,/Library/stomp-jb.dylib", "-o", str(adapter),
    str(pathlib.Path(__file__).with_name("amethyst-compat.c")),
], check=True)
subprocess.run(["ldid", "-S", str(adapter)], check=True)
(output / "stomp-agent.dylib").write_bytes(agent)
with tarfile.open(output / "deploy.tar", "w") as deployment:
    deployment.add(patched, arcname="var/tmp/stomp-frida-server-compat3")
    deployment.add(adapter, arcname="Library/stomp-jb.dylib")
    deployment.add(output / "stomp-agent.dylib", arcname="Library/stomp-agent.dylib")
print(f"Built {output / 'deploy.tar'}; no device files changed.")

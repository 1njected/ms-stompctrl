"""Start the already staged adapted server in the foreground over SSH.

Usage: python3 tools/frida/start-frida.py [IP_ADDRESS]
       STOMP_DEVICE_IP=10.0.0.5 python3 tools/frida/start-frida.py

Leave running in one terminal; Ctrl-C stops the server. SSH prompts for credentials.
"""
import os
import sys

host = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("STOMP_DEVICE_IP")
if not host:
    sys.exit("Pass the device's IP address, or set STOMP_DEVICE_IP.")
# Fixed remote code: the host argument never becomes remote shell text.
remote = r'''
stomp_pid=$(ps -A -o pid,comm | while read -r stomp_candidate stomp_executable; do
  case "$stomp_executable" in
    */StompShare.app/StompShare) printf '%s\n' "$stomp_candidate";;
  esac
done)
case "$stomp_pid" in
  ''|*[!0-9]*) echo "Expected exactly one running StompShare process" >&2; exit 1;;
esac
export STOMP_TRACE_PID="$stomp_pid"
echo "Tracing StompShare PID $stomp_pid; stop with Ctrl-C" >&2
exec /var/tmp/stomp-frida-server-compat3 -l 127.0.0.1:27042 -d /var/tmp/stompshare-trace/runtime
'''
os.execvp("ssh", [
    "ssh", "-tt", "-o", "ConnectTimeout=8", "-o", "ExitOnForwardFailure=yes",
    "-o", "UserKnownHostsFile=/tmp/stompshare-known-hosts",
    "-L", "127.0.0.1:27043:127.0.0.1:27042", "root@" + host, remote,
])

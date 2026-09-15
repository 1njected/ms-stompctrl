#!/bin/sh
# Why the MS-100BT will not connect, and which remedy to reach for.
#
# Three failures surface as the same Chrome error,
# "NetworkError: Failed to execute 'open' on 'SerialPort'":
#
#   1. the channel needs a gap after a close   -> wait ~10 s
#   2. the pedal is not linked to the Mac      -> switch it on / reconnect
#   3. macOS cached a bad service record       -> what this script is for
#
# The third is the nasty one, and its cause was MISDIAGNOSED until 2026-09-13.
# It is NOT a corrupt SDP cache. Measured in both states, the SDP records are
# byte-identical and correct (iAP deca-fade -> ch 1, SPP 1101 -> ch 2), and a
# live over-the-air SDP query succeeds even while the pedal is unreachable.
# What actually differs is one bit in the Services bitmask:
#
#     healthy : 0x800000 < ACL >
#     broken  : 0x802000 < Braille ACL >      <- bit 0x2000 set
#
# In the broken state the pedal answers SDP (stateless) but will not open an
# RFCOMM channel (a session) to THIS Mac. The pedal itself is fine: measured
# 2026-09-13, an iPad connected to it normally while the Mac could not.
# So this is the Mac<->pedal bond/session state, not macOS SDP and not Chrome.
#
# Usage:  sh runtime/macos-bt-diagnose.sh
set -u
ADDR="AA:BB:CC:DD:EE:FF"
NAME="MS-100BT"

echo "== $NAME =="
STATE=$(system_profiler SPBluetoothDataType 2>/dev/null |
  awk '/Connected:/{c=1} /Not Connected:/{c=0} c' | grep -A5 "$NAME")

if [ -z "$STATE" ]; then
  echo "  not connected to this Mac."
  echo "  -> switch the pedal on, or reconnect it in Bluetooth settings."
  exit 0
fi

SERVICES=$(printf '%s\n' "$STATE" | awk -F': ' '/Services:/{print $2}')
echo "  Services: ${SERVICES:-unknown}"

case "$SERVICES" in
  *Braille*|*SIM*)
    echo
    echo "  This bitmask is garbage for a MIDI pedal: macOS has cached a wrong"
    echo "  service record. Two shapes of failure have been measured:"
    echo
    echo "    a) both channels time out at ~10 s        (2026-09-13 morning)"
    echo "    b) the iAP channel OPENS instantly and is then silent forever,"
    echo "       while the other channel times out at ~10 s (2026-09-13 evening)"
    echo
    echo "  In shape (b) a successful open is NOT evidence of a good link. The"
    echo "  measured case: port open 90 s, zero bytes ever, and no reply to any"
    echo "  of RequestIdentify / GetAccessoryInfo / StartIDPS, each written with"
    echo "  zero backpressure. iAP identification is started by the PEDAL, so"
    echo "  silence after open cannot be recovered by anything the host sends."
    echo
    echo "  Remedies, cheapest first:"
    echo "    1. Connect the pedal to the iPad/iPhone, then disconnect it, then"
    echo "       try the Mac again. UNTESTED ALONE but the cheapest candidate:"
    echo "       on 2026-09-13 an iPad connect immediately preceded the fix and"
    echo "       costs nothing if it fails. Try this first and report the result."
    echo "    2. Remove the pedal in Bluetooth settings and pair again."
    echo "       (measured to work, four times; costs Chrome its granted port"
    echo "       permission, so you must re-pick the port in the page)"
    echo
    echo "  Measured NOT to help: a plain disconnect/reconnect, quitting Chrome,"
    echo "  sudo pkill bluetoothd, and a full Mac restart -- the broken state"
    echo "  survived all of them, including a reboot of both Mac and pedal."
    ;;
  *)
    echo "  Bitmask looks healthy (expected: 0x800000 < ACL >)."
    echo
    echo "  If Chrome still will not open the port:"
    echo "    - one channel failing and the other opening = needs a gap; wait ~10 s"
    echo "    - both failing = re-check the bitmask above"
    ;;
esac

echo
echo "== cached serial binding =="
plutil -p /Library/Preferences/com.apple.Bluetooth.plist 2>/dev/null |
  awk "/$ADDR/{f=1} f&&/RFCOMMChannel/{print \"  \" \$0; f=0}" ||
  echo "  (plist not readable)"
[ -e "/dev/cu.ZOOMMS-100BT" ] &&
  echo "  /dev/cu.ZOOMMS-100BT exists (macOS binds SPP, channel 2, as a legacy node)"
exit 0

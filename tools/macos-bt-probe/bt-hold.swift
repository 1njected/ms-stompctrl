// Hold the baseband link up, and nothing else.
//
// Measured 2026-10-07: Chrome's SerialPort.open() takes 10,004 ms and fails
// when the pedal has no ACL link, and 91 ms and succeeds when something else
// has already established one. So the browser's problem may not need a native
// transport at all -- only a native nudge.
//
// This opens the baseband connection and then sits there. It deliberately does
// NOT open an RFCOMM channel: the pedal serves one channel, and holding channel
// 2 (tested) consumes the slot the app needs. openConnection() takes no slot.
//
//   swiftc -O -framework IOBluetooth -o bt-hold bt-hold.swift
//   MS100BT_ADDR=… ./bt-hold [seconds]
import Foundation
import IOBluetooth

let addr = ProcessInfo.processInfo.environment["MS100BT_ADDR"] ?? "AA-BB-CC-DD-EE-FF"
if addr == "AA-BB-CC-DD-EE-FF" {
    FileHandle.standardError.write("set MS100BT_ADDR to the pedal's address first (see README)\n".data(using: .utf8)!)
    exit(2)
}
let seconds = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 120) : 120
let start = Date()
func stamp() -> String { String(format: "%6.3f", Date().timeIntervalSince(start)) }

guard let device = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("device: \(device.name ?? "?")  connected=\(device.isConnected())  paired=\(device.isPaired())")

/* Re-assert the link whenever it drops: the pedal power-cycling, or macOS
   tidying up an idle connection, both end it, and the whole point is that the
   link is already there the moment the page asks. */
var opens = 0
func ensureLink() {
    if device.isConnected() { return }
    let rc = device.openConnection()
    opens += 1
    print("[\(stamp())] openConnection() -> \(rc == kIOReturnSuccess ? "success" : "IOReturn \(rc)")"
          + "  (link established \(opens)x)")
}
ensureLink()

Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
    ensureLink()
    if Date().timeIntervalSince(start) >= seconds {
        print("[\(stamp())] done; link was established \(opens) time(s). Not disconnecting.")
        exit(0)
    }
}
print("holding the link for \(Int(seconds)) s — no RFCOMM channel is opened, so the")
print("pedal's channel stays free for the browser. Press Connect in the app now.")
RunLoop.main.run()

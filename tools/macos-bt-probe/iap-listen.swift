// Does the pedal try to connect to US?
//
// iAP over Bluetooth reverses roles after bonding: the first connection is made
// by the host to the channel the accessory provides, and on SUBSEQUENT
// connections the accessory connects to a channel the host provides. If the
// MS-100BT behaves that way, then everything measured on 2026-10-07 follows:
//
//   * a host-initiated RFCOMM open is simply ignored -- link up, link
//     authenticated, request accepted by macOS, pedal silent
//   * re-pairing is the only remedy that works, because it puts the pedal back
//     in the state where the HOST initiates, for exactly one connection
//   * a power cycle does not help, because it does not undo the bond
//   * the iPad is unaffected, because iOS listens for accessory-initiated
//     connections; Chrome's Web Serial can only ever dial out
//
// This listens rather than dials. It registers for INCOMING RFCOMM channel
// notifications and waits. One knock from the pedal settles the question.
//
//   swiftc -O -framework IOBluetooth -o iap-listen iap-listen.swift
//   MS100BT_ADDR=… ./iap-listen [seconds]
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
var knocks = 0

final class Watcher: NSObject {
    /* Fires for any RFCOMM channel that opens in the incoming direction. The
       pedal knocking is the whole result; what it asks for is a bonus. */
    @objc func incoming(_ note: IOBluetoothUserNotification!, channel: IOBluetoothRFCOMMChannel!) {
        knocks += 1
        let who = channel.getDevice()?.addressString ?? "?"
        let name = channel.getDevice()?.name ?? "?"
        print("[\(stamp())] INCOMING RFCOMM channel \(channel.getID()) from \(name) [\(who)]")
        print("           -> the accessory initiates. A listening host is what this needs.")
        channel.setDelegate(self)
    }
    @objc func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data ptr: UnsafeMutableRawPointer!, length n: Int) {
        let hex = Data(bytes: ptr, count: n).map { String(format: "%02x", $0) }.joined(separator: " ")
        print("[\(stamp())] RX \(n) bytes: \(hex)")
    }
}

guard let device = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("device: \(device.name ?? "?")  connected=\(device.isConnected())  paired=\(device.isPaired())")
print("listening \(Int(seconds)) s for an accessory-initiated RFCOMM channel.")
print("Nothing is dialled out: if the pedal knocks, the role-reversal is real.")

let watcher = Watcher()
/* Two registrations, because the first version of this got a meaningless
   negative: it passed channel 0, which is not a channel, so the notification
   very likely never armed at all. The broad form catches any RFCOMM channel in
   either direction; the per-channel forms catch an inbound knock on the two
   channels this pedal actually advertises. */
let broad = IOBluetoothRFCOMMChannel.register(forChannelOpenNotifications: watcher,
                                              selector: #selector(Watcher.incoming(_:channel:)))
print("armed: any-channel notification \(broad == nil ? "FAILED" : "ok")")
for id in [BluetoothRFCOMMChannelID(1), BluetoothRFCOMMChannelID(2)] {
    let n = IOBluetoothRFCOMMChannel.register(forChannelOpenNotifications: watcher,
                                              selector: #selector(Watcher.incoming(_:channel:)),
                                              withChannelID: id,
                                              direction: kIOBluetoothUserNotificationChannelDirectionIncoming)
    print("armed: incoming on channel \(id) \(n == nil ? "FAILED" : "ok")")
}
print("NOTE: macOS accepts an inbound channel only for a service it publishes.")
print("      We publish none, so a refused knock would not reach this program.")

Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
    print("")
    print(knocks > 0
          ? "RESULT: \(knocks) incoming channel(s). The pedal initiates -- a native app must LISTEN."
          : "RESULT: no incoming channel. The pedal did not try to reach us in \(Int(seconds)) s.")
    exit(knocks > 0 ? 0 : 1)
}
RunLoop.main.run()

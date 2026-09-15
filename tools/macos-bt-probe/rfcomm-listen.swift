// Open one RFCOMM channel on the MS-100BT by EXPLICIT channel number and print
// whatever the pedal sends. Explicit channel bypasses macOS's UUID -> channel
// SDP lookup, which is the thing suspected of being corrupt.
//
//   usage: rfcomm-listen <channelID> [seconds]
import Foundation
import IOBluetooth

let addr = "AA-BB-CC-DD-EE-FF"
let channelID = BluetoothRFCOMMChannelID(CommandLine.arguments.count > 1 ? UInt8(CommandLine.arguments[1]) ?? 1 : 1)
let seconds = CommandLine.arguments.count > 2 ? (Double(CommandLine.arguments[2]) ?? 12.0) : 12.0

func stamp() -> String { String(format: "%.3f", Date().timeIntervalSince(start)) }
let start = Date()
var total = 0

final class Listener: NSObject, IOBluetoothRFCOMMChannelDelegate {
    func rfcommChannelOpenComplete(_ ch: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        if error == kIOReturnSuccess {
            print("[\(stamp())] channel \(channelID) OPEN (mtu \(ch.getMTU()))")
        } else {
            print("[\(stamp())] channel \(channelID) OPEN FAILED, IOReturn \(error)")
            exit(2)
        }
    }
    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data ptr: UnsafeMutableRawPointer!, length n: Int) {
        let bytes = Data(bytes: ptr, count: n)
        total += n
        let hex = bytes.map { String(format: "%02x", $0) }.joined(separator: " ")
        print("[\(stamp())] RX \(n) bytes: \(hex)")
    }
    func rfcommChannelClosed(_ ch: IOBluetoothRFCOMMChannel!) {
        print("[\(stamp())] channel closed by remote")
    }
}

guard let device = IOBluetoothDevice(addressString: addr) else {
    print("no such device \(addr)"); exit(1)
}
print("device: \(device.name ?? "?")  connected=\(device.isConnected())  paired=\(device.isPaired())")

let listener = Listener()
var channel: IOBluetoothRFCOMMChannel?
let rc = device.openRFCOMMChannelAsync(&channel, withChannelID: channelID, delegate: listener)
if rc != kIOReturnSuccess {
    print("openRFCOMMChannelAsync failed immediately, IOReturn \(rc)")
    exit(3)
}

Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
    print("[\(stamp())] done. total bytes received: \(total)")
    channel?.close()
    exit(total > 0 ? 0 : 4)
}
RunLoop.main.run()

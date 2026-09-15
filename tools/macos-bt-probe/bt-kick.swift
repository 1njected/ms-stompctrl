// Tear down the baseband (ACL) link to the pedal WITHOUT unpairing, then try to
// open iAP RFCOMM channel 1 and listen. Keeps pairing, so Chrome keeps its
// granted serial-port permission.
import Foundation
import IOBluetooth

let addr = "AA-BB-CC-DD-EE-FF"
let start = Date()
func t() -> String { String(format: "%.2f", Date().timeIntervalSince(start)) }
var total = 0

final class Listener: NSObject, IOBluetoothRFCOMMChannelDelegate {
    func rfcommChannelOpenComplete(_ ch: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        print("[\(t())] RFCOMM ch1 open callback: \(error == kIOReturnSuccess ? "SUCCESS mtu=\(ch.getMTU())" : "FAILED IOReturn \(error)")")
    }
    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data p: UnsafeMutableRawPointer!, length n: Int) {
        total += n
        let hex = Data(bytes: p, count: n).map { String(format: "%02x", $0) }.joined(separator: " ")
        print("[\(t())] RX \(n): \(hex)")
    }
    func rfcommChannelClosed(_ ch: IOBluetoothRFCOMMChannel!) { print("[\(t())] closed by remote") }
}

guard let dev = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("[\(t())] before: connected=\(dev.isConnected()) paired=\(dev.isPaired())")
let rc = dev.closeConnection()
print("[\(t())] closeConnection -> IOReturn \(rc)  connected=\(dev.isConnected())")

let listener = Listener()
Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { _ in
    print("[\(t())] reconnecting, opening RFCOMM ch 1 ...")
    var ch: IOBluetoothRFCOMMChannel?
    let r = dev.openRFCOMMChannelAsync(&ch, withChannelID: 1, delegate: listener)
    print("[\(t())] openRFCOMMChannelAsync returned \(r)")
    Timer.scheduledTimer(withTimeInterval: 15.0, repeats: false) { _ in
        print("[\(t())] done. bytes received: \(total)  connected=\(dev.isConnected())")
        ch?.close()
        exit(total > 0 ? 0 : 4)
    }
}
RunLoop.main.run()

// Drop the Mac's baseband (ACL) link to the pedal and do NOT reconnect, so
// another host can take it. Pairing is left intact.
import Foundation
import IOBluetooth
/* The pedal's BD address is not in this source: it is a personal device
   identifier, and the published copy carries a placeholder. Supply it as
   MS100BT_ADDR, or find it with
   `system_profiler SPBluetoothDataType | grep -A2 "ZOOM MS-100BT"`. */
let addr = ProcessInfo.processInfo.environment["MS100BT_ADDR"] ?? "AA-BB-CC-DD-EE-FF"
if addr == "AA-BB-CC-DD-EE-FF" {
    FileHandle.standardError.write("set MS100BT_ADDR to the pedal's address first (see README)\n".data(using: .utf8)!)
    exit(2)
}
guard let dev = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("before: connected=\(dev.isConnected()) paired=\(dev.isPaired())")
for i in 1...3 {
    let rc = dev.closeConnection()
    print("closeConnection #\(i) -> IOReturn \(rc)")
    Thread.sleep(forTimeInterval: 1.0)
    if !dev.isConnected() { break }
}
print("after:  connected=\(dev.isConnected())")

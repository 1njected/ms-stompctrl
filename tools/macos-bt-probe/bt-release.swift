// Drop the Mac's baseband (ACL) link to the pedal and do NOT reconnect, so
// another host can take it. Pairing is left intact.
import Foundation
import IOBluetooth
let addr = "AA-BB-CC-DD-EE-FF"
guard let dev = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("before: connected=\(dev.isConnected()) paired=\(dev.isPaired())")
for i in 1...3 {
    let rc = dev.closeConnection()
    print("closeConnection #\(i) -> IOReturn \(rc)")
    Thread.sleep(forTimeInterval: 1.0)
    if !dev.isConnected() { break }
}
print("after:  connected=\(dev.isConnected())")

// Dump what macOS has cached as the MS-100BT's SDP service records, and
// optionally force a fresh SDP query first.   usage: sdp-dump [--refresh]
import Foundation
import IOBluetooth

let addr = "AA-BB-CC-DD-EE-FF"
guard let device = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("device      : \(device.name ?? "?")")
print("connected   : \(device.isConnected())   paired: \(device.isPaired())")
print("classOfDev  : 0x\(String(device.classOfDevice, radix: 16))")
print("services svc: 0x\(String(device.serviceClassMajor, radix: 16))")

func dump(_ device: IOBluetoothDevice, _ label: String) {
    print("\n=== \(label) ===")
    guard let records = device.services as? [IOBluetoothSDPServiceRecord], !records.isEmpty else {
        print("  (no service records cached)"); return
    }
    print("  \(records.count) record(s)")
    for (i, r) in records.enumerated() {
        var channel: BluetoothRFCOMMChannelID = 0
        let hasRFCOMM = r.getRFCOMMChannelID(&channel) == kIOReturnSuccess
        let name = r.getServiceName() ?? "(unnamed)"
        print("  [\(i)] name=\(name)  rfcomm=\(hasRFCOMM ? String(channel) : "none")")
        if let uuid = r.getAttributeDataElement(1) {          // ServiceClassIDList
            let s = "\(uuid)".replacingOccurrences(of: "\n", with: " ")
            print("       classes: \(s.prefix(300))")
        }
    }
}

dump(device, "cached service records")

if CommandLine.arguments.contains("--refresh") {
    print("\nforcing fresh SDP query ...")
    final class D: NSObject, IOBluetoothDeviceAsyncCallbacks {
        func remoteNameRequestComplete(_ d: IOBluetoothDevice!, status: IOReturn) {}
        func connectionComplete(_ d: IOBluetoothDevice!, status: IOReturn) {}
        func sdpQueryComplete(_ d: IOBluetoothDevice!, status: IOReturn) {
            print("sdpQueryComplete status=\(status) \(status == kIOReturnSuccess ? "(success)" : "(FAILED)")")
            dump(d!, "after fresh SDP query")
            exit(status == kIOReturnSuccess ? 0 : 5)
        }
    }
    let d = D()
    let rc = device.performSDPQuery(d)
    if rc != kIOReturnSuccess { print("performSDPQuery returned \(rc)"); exit(6) }
    Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { _ in
        print("SDP query TIMED OUT after 20 s (no callback)"); exit(7)
    }
    RunLoop.main.run()
}

import Foundation
import IOBluetooth

/// Owns raw RFCOMM only; the bundled JavaScript owns the complete iAP protocol.
final class BluetoothTransport: NSObject, IOBluetoothRFCOMMChannelDelegate {
    typealias Reply = (Any?, String?) -> Void
    var diagnostic: (String) -> Void = { _ in }
    var receive: ([UInt8]) -> Void = { _ in }
    var closed: () -> Void = {}
    private var device: IOBluetoothDevice?
    private var channel: IOBluetoothRFCOMMChannel?
    private var opening: Reply?
    private var timer: Timer?
    private var deadline = Date()
    private var ready = false
    private var lastStatus: IOReturn = kIOReturnSuccess
    private var writeReply: Reply?
    private var payload = Data()
    private var offset = 0
    private var chunk: NSMutableData?
    private var writeTimer: Timer?

    func connect(_ reply: @escaping Reply) {
        guard channel == nil, opening == nil else { reply(nil, "Connection already open or opening."); return }
        let pedals = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] ?? [])
            .filter { ($0.name ?? "").uppercased().contains("MS-100BT") }
        guard pedals.count == 1, let pedal = pedals.first else {
            reply(nil, pedals.isEmpty ? "Pair your MS-100BT in System Settings → Bluetooth, then connect here."
                  : "Multiple paired MS-100BT pedals found. Remove the unused pairing before connecting.")
            return
        }
        diagnostic("Native: found paired pedal")
        device = pedal
        opening = reply
        deadline = Date().addingTimeInterval(30)
        // This is the successful native probe's order, without Chrome's SDP
        // socket wrapper. An authenticated link alone was insufficient in tests.
        if !pedal.isConnected() { lastStatus = pedal.openConnection() }
        if pedal.isConnected() { lastStatus = pedal.requestAuthentication() }
        diagnostic("Native: baseband/authentication status \(lastStatus)")
        attempt()
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if self.ready { self.timer?.invalidate(); self.timer = nil; return }
            if Date() >= self.deadline {
                self.fail("Native Bluetooth connection timed out (status \(self.lastStatus)). Close other pedal apps, switch the pedal off and on, then reconnect.")
            } else { self.attempt() }
        }
    }

    private func attempt() {
        guard opening != nil, let device = device else { return }
        // Close even an incomplete channel: Chrome omits this for failed opens.
        retireChannel()
        var next: IOBluetoothRFCOMMChannel?
        lastStatus = device.openRFCOMMChannelAsync(&next, withChannelID: 1, delegate: self)
        channel = next
        diagnostic("Native: channel 1 open requested, status \(lastStatus)")
    }

    private func retireChannel() {
        let old = channel
        channel = nil
        old?.setDelegate(nil)
        old?.close()
    }

    func disconnect() {
        timer?.invalidate(); timer = nil
        writeTimer?.invalidate(); writeTimer = nil
        let pending = opening; opening = nil
        let writing = writeReply; writeReply = nil
        ready = false
        retireChannel()
        device = nil
        chunk = nil; payload = Data(); offset = 0
        pending?(nil, "Connection cancelled.")
        writing?(nil, "Connection closed during write.")
    }

    private func fail(_ message: String) {
        let pending = opening; opening = nil
        let writing = writeReply; writeReply = nil
        let wasReady = ready
        disconnect()
        pending?(nil, message)
        writing?(nil, message)
        if wasReady { closed() }
    }

    func rfcommChannelOpenComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        guard rfcommChannel === channel, opening != nil else { return }
        diagnostic("Native: RFCOMM open callback \(error)")
        lastStatus = error
        guard error == kIOReturnSuccess else { return } // bounded timer retries
        ready = true
        timer?.invalidate(); timer = nil
        let reply = opening; opening = nil
        reply?(true, nil)
    }

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!, data pointer: UnsafeMutableRawPointer!, length: Int) {
        guard rfcommChannel === channel, ready, let pointer = pointer, length > 0 else { return }
        receive(Array(UnsafeBufferPointer(start: pointer.assumingMemoryBound(to: UInt8.self), count: length)))
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        guard rfcommChannel === channel else { return }
        if ready { fail("The pedal disconnected.") }
    }

    func write(_ bytes: [UInt8], reply: @escaping Reply) {
        guard ready, channel != nil else { reply(nil, "The pedal is not connected."); return }
        guard writeReply == nil else { reply(nil, "A Bluetooth write is already in progress."); return }
        guard !bytes.isEmpty else { reply(true, nil); return }
        payload = Data(bytes); offset = 0; writeReply = reply
        writeTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
            self?.fail("Bluetooth write timed out. The connection was closed to prevent further writes.")
        }
        pump()
    }

    private func pump() {
        guard let channel = channel, writeReply != nil else { return }
        if offset == payload.count {
            writeTimer?.invalidate(); writeTimer = nil
            let done = writeReply; writeReply = nil
            chunk = nil; payload = Data(); offset = 0
            done?(true, nil); return
        }
        let count = min(Int(channel.getMTU()), payload.count - offset)
        guard count > 0 else { fail("Invalid RFCOMM MTU."); return }
        // Retain the actual buffer until IOBluetooth's completion callback.
        let buffer = NSMutableData(data: payload.subdata(in: offset..<(offset + count)))
        chunk = buffer
        let rc = channel.writeAsync(buffer.mutableBytes, length: UInt16(count), refcon: nil)
        if rc != kIOReturnSuccess { fail("Bluetooth write failed (status \(rc)).") }
    }

    func rfcommChannelWriteComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel!, refcon: UnsafeMutableRawPointer!, status error: IOReturn) {
        guard rfcommChannel === channel, writeReply != nil else { return }
        guard error == kIOReturnSuccess else { fail("Bluetooth write failed (status \(error))."); return }
        offset += chunk?.length ?? 0
        chunk = nil
        pump()
    }
}

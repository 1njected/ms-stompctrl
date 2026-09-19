// The pedal, as an ExternalAccessory stream pair.
//
// iOS owns iAP1 here -- identification, authentication, the data session,
// fragmentation -- so these streams carry ZOOM application payload and nothing
// else. transport-ea.js is the other half of this: it strips the iAP framing
// the web app builds, hands the payload down, and wraps what comes back.

import ExternalAccessory

// Read off StompShare.app's Info.plist and confirmed on the wire: the pedal
// advertises it in FID token subtype 4 during identification.
let PROTOCOL_STRING = "jp.co.zoom.p1"

protocol AccessoryDelegate: AnyObject {
    func accessoryDidOpen(name: String)
    func accessoryDidClose()
    func accessoryDidReceive(_ bytes: [UInt8])
    func accessoryDidFail(_ message: String)
}

final class Accessory: NSObject, StreamDelegate {
    weak var delegate: AccessoryDelegate?

    private var session: EASession?
    private var outbox: [UInt8] = []
    private var opened = 0

    override init() {
        super.init()
        let manager = EAAccessoryManager.shared()
        manager.registerForLocalNotifications()
        NotificationCenter.default.addObserver(
            forName: .EAAccessoryDidDisconnect, object: nil, queue: .main) { [weak self] _ in
            self?.disconnect()
        }
    }

    var isConnected: Bool { session != nil }

    func connect() {
        guard session == nil else { return }
        guard let accessory = EAAccessoryManager.shared().connectedAccessories
            .first(where: { $0.protocolStrings.contains(PROTOCOL_STRING) }) else {
            delegate?.accessoryDidFail(
                "No MS-100BT. Pair it in Settings \u{203A} Bluetooth, then try again.")
            return
        }
        guard let opening = EASession(accessory: accessory, forProtocol: PROTOCOL_STRING) else {
            delegate?.accessoryDidFail("iOS refused the accessory session.")
            return
        }
        session = opening
        opened = 0
        for stream in [opening.inputStream, opening.outputStream].compactMap({ $0 }) {
            stream.delegate = self
            stream.schedule(in: RunLoop.main, forMode: .default)
            stream.open()
        }
    }

    func disconnect() {
        guard let open = session else { return }
        for stream in [open.inputStream, open.outputStream].compactMap({ $0 }) {
            stream.close()
            stream.remove(from: RunLoop.main, forMode: .default)
            stream.delegate = nil
        }
        session = nil
        outbox.removeAll()
        opened = 0
        delegate?.accessoryDidClose()
    }

    // Queue and drain. An install pushes a .ZDL in 4096-byte chunks and a stream
    // write is free to take fewer bytes than offered, so what is left waits for
    // the next .hasSpaceAvailable rather than being dropped.
    func write(_ bytes: [UInt8]) {
        outbox.append(contentsOf: bytes)
        pump()
    }

    private func pump() {
        guard let out = session?.outputStream else { return }
        while !outbox.isEmpty, out.hasSpaceAvailable {
            let written = outbox.withUnsafeBufferPointer {
                out.write($0.baseAddress!, maxLength: outbox.count)
            }
            if written <= 0 {
                delegate?.accessoryDidFail(
                    "Write failed: \(out.streamError.map { String(describing: $0) } ?? "unknown")")
                return
            }
            outbox.removeFirst(written)
        }
    }

    private func read(_ stream: InputStream) {
        var chunk = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&chunk, maxLength: chunk.count)
            if count <= 0 { break }
            // Handed up unreassembled: the web app rebuilds F0..F7 across
            // frames already, because the pedal fragments too.
            delegate?.accessoryDidReceive(Array(chunk[0..<count]))
        }
    }

    func stream(_ stream: Stream, handle event: Stream.Event) {
        switch event {
        case .openCompleted:
            opened += 1
            // Report open once, when both directions are up.
            if opened == 2, let accessory = session?.accessory {
                delegate?.accessoryDidOpen(name: accessory.name)
            }
        case .hasBytesAvailable:
            if let input = stream as? InputStream { read(input) }
        case .hasSpaceAvailable:
            pump()
        case .errorOccurred:
            delegate?.accessoryDidFail(
                stream.streamError.map { String(describing: $0) } ?? "Stream error")
        case .endEncountered:
            disconnect()
        default:
            break
        }
    }
}

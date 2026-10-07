// Does a NATIVE RFCOMM transport get all the way to an open ZOOM data session?
//
// The browser cannot reliably open the channel at all on macOS: measured
// 2026-10-06, Chrome's SerialPort.open() died at the 10,004 ms RFCOMM timeout
// while this same IOBluetooth path opened channel 1 in ~4 s, before and after a
// pedal power cycle (docs/bluetooth.md). That proved the CHANNEL. It did not
// prove the SESSION -- identification, then the 0x3F that opens
// `jp.co.zoom.p1` -- which is what a native app would have to reach before any
// of the existing client code could run.
//
// So this walks the same handshake app/iap.js walks, in the same order, and
// stops the moment a data session opens. It is a spike: it reads nothing from
// the pedal's memory, writes nothing to it, and sends no ZOOM command at all --
// identification and one session open, then it closes.
//
//   swiftc -O -framework IOBluetooth -o iap-spike iap-spike.swift
//   MS100BT_ADDR=… ./iap-spike
import Foundation
import IOBluetooth

/* The pedal's BD address is not in this source: it is a personal device
   identifier, and the published copy carries a placeholder. */
let addr = ProcessInfo.processInfo.environment["MS100BT_ADDR"] ?? "AA-BB-CC-DD-EE-FF"
if addr == "AA-BB-CC-DD-EE-FF" {
    FileHandle.standardError.write("set MS100BT_ADDR to the pedal's address first (see README)\n".data(using: .utf8)!)
    exit(2)
}
let channelID = BluetoothRFCOMMChannelID(1)          // iAP; channel 2 never answers
let waiting = CommandLine.arguments.contains("--wait")
/* --race: retry the channel open as fast as the stack will take it.
   Apple Developer Forums 697032 reports openRFCOMMChannelAsync failing since
   Monterey, and a related report that a connection only succeeds when the
   socket is opened BEFORE the OS settles on the device. Six-second retries
   cannot win that race; 400 ms might. Power-cycle the pedal while this runs. */
let racing = CommandLine.arguments.contains("--race")
let retryEvery = racing ? 0.4 : 6.0
let deadline = Date().addingTimeInterval(racing ? 180 : (waiting ? 240 : 30))

func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined(separator: " ") }
func note(_ s: String) { print("[\(String(format: "%6.3f", Date().timeIntervalSince(start)))] \(s)") }
let start = Date()

/* iAP1 framing, identical to app/iap.js frame(): 0x55, length (one byte, or
   0x00 plus two bytes when it will not fit), payload, then the byte that makes
   the sum zero. */
func frame(_ cmd: UInt8, _ transaction: UInt16, _ data: [UInt8] = []) -> [UInt8] {
    let payload: [UInt8] = [0, cmd, UInt8(transaction >> 8), UInt8(transaction & 0xff)] + data
    let header: [UInt8] = payload.count < 256
        ? [UInt8(payload.count)]
        : [0, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)]
    let body = header + payload
    let sum = body.reduce(0) { ($0 &+ Int($1)) }
    return [0x55] + body + [UInt8((-sum) & 0xff)]
}

struct Packet { let cmd: UInt8; let transaction: UInt16; let data: [UInt8] }

/* Same resynchronising parser as app/iap.js: find 0x55, read the length, check
   the sum, hand over the payload. */
final class Parser {
    private var buf: [UInt8] = []
    var onPacket: (Packet) -> Void = { _ in }
    func feed(_ bytes: [UInt8]) {
        buf += bytes
        while !buf.isEmpty {
            guard let pos = buf.firstIndex(of: 0x55) else { buf.removeAll(); return }
            if pos > 0 { buf.removeFirst(pos) }
            if buf.count < 2 { return }
            var off = 2, len = Int(buf[1])
            if len == 0 {
                if buf.count < 4 { return }
                off = 4; len = Int(buf[2]) << 8 | Int(buf[3])
            }
            if len < 4 || len > 16384 { buf.removeFirst(); continue }
            let end = off + len + 1
            if buf.count < end { return }
            if buf[1..<end].reduce(0, { $0 &+ Int($1) }) % 256 != 0 { buf.removeFirst(); continue }
            let p = Array(buf[off..<(end - 1)])
            buf.removeFirst(end)
            onPacket(Packet(cmd: p[1], transaction: UInt16(p[2]) << 8 | UInt16(p[3]), data: Array(p.dropFirst(4))))
        }
    }
}

/* NSObject matters: IOBluetooth dispatches these callbacks from Objective-C, so
   a plain Swift class never hears from it -- the channel opens and the delegate
   is simply never called, which looks exactly like a pedal that said nothing. */
final class Spike: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var channel: IOBluetoothRFCOMMChannel?
    let parser = Parser()
    var protocols: [(index: UInt8, name: String)] = []
    var identified = false, sessionOpen = false, failed: String?
    var pendingSession: UInt16?
    var nextTransaction: UInt16 = 1
    /* The accessory authenticates itself to the host: we ask for its
       certificate (0x14 -> 0x15 sections), challenge it (0x17 -> 0x18), and
       report the result (0x19). app/iap-auth.js and app/iap-signature.js do
       exactly this, and the pedal appears to withhold a data session until it
       has happened -- the previous run sent 0x3F straight after identification
       and got no answer at all. We do NOT verify the signature here; this is a
       reachability probe, and a real client must check it (iap-signature.js). */
    var certSections: [[UInt8]] = []
    var finalTransaction: UInt16 = 5
    var challenge: [UInt8] = []

    func send(_ cmd: UInt8, _ transaction: UInt16, _ data: [UInt8] = []) {
        var bytes = frame(cmd, transaction, data)
        let rc = channel?.writeSync(&bytes, length: UInt16(bytes.count)) ?? kIOReturnNotOpen
        if rc != kIOReturnSuccess { failed = "write failed: \(rc)" }
        note("TX cmd=0x\(String(format: "%02x", cmd)) \(hex(bytes))")
    }
    func ack(_ p: Packet, _ value: UInt8 = 0) { send(2, p.transaction, [value, p.cmd]) }

    /* The same cases app/iap.js handles, in the same order. */
    func receive(_ p: Packet) {
        note("RX cmd=0x\(String(format: "%02x", p.cmd)) data=\(hex(p.data))")
        switch p.cmd {
        case 0x38:                                    // StartIDPS: the pedal speaks first
            protocols = []; identified = false
            ack(p)
        case 0x11:                                    // RequestTransportMaxPayloadSize
            send(0x12, p.transaction, [0x10, 0])
        case 0x0f:                                    // RequestLingoProtocolVersion
            send(0x10, p.transaction, [p.data.first ?? 0, 1, 9])
        case 0x39:                                    // FID tokens -> ACK each one
            var out: [UInt8] = [p.data[0]]
            var pos = 1
            for _ in 0..<Int(p.data[0]) {
                guard pos < p.data.count else { failed = "truncated FID token"; return }
                let n = Int(p.data[pos]); pos += 1
                guard n >= 2, pos + n <= p.data.count else { failed = "truncated FID token"; return }
                let t = Array(p.data[pos..<(pos + n)]); pos += n
                var reply: [UInt8] = [t[0], t[1], 0]
                if t[0] == 0, [2, 3, 4].contains(t[1]) { reply.append(t[2]) }
                if t[0] == 0, t[1] == 4 {
                    let name = String(decoding: t.dropFirst(3), as: UTF8.self)
                        .split(separator: "\0").first.map(String.init) ?? ""
                    protocols.append((index: t[2], name: name))
                    note("   protocol index \(t[2]): \(name)")
                }
                if !(t[0] == 0 && t[1] <= 7) && !(t[0] == 1 && t[1] == 0) { reply = [t[0], t[1], 1] }
                out.append(UInt8(reply.count)); out += reply
            }
            send(0x3a, p.transaction, out)
        case 0x3b:                                    // EndIDPS
            if p.data.first == 0 {
                send(0x3c, p.transaction, [0])
                identified = true
                note("   IDENTIFICATION ACCEPTED")
                certSections = []
                note("   requesting the accessory certificate (0x14)")
                send(0x14, 0x100)
            } else {
                failed = "accessory ended identification: \(p.data.first ?? 0)"
            }
        case 0x41:                                    // ACK for our 0x3F
            if p.data.count >= 2, p.data[1] == 0x3f, let pending = pendingSession, p.transaction == pending {
                if p.data[0] == 0 { sessionOpen = true; note("   DATA SESSION OPEN") }
                else { failed = "session rejected: status \(p.data[0])" }
                pendingSession = nil
            }
        case 0x15:                                    // a certificate section
            guard p.data.count >= 4 else { failed = "short 0x15"; return }
            let section = Int(p.data[2]), last = Int(p.data[3])
            if section == 0 { certSections = [] }
            guard section == certSections.count, section <= last else {
                failed = "out-of-order certificate section \(section)/\(last)"; return
            }
            certSections.append(Array(p.data.dropFirst(4)))
            if section < last {
                send(2, p.transaction, [0, 0x15])      // more to come
            } else {
                finalTransaction = p.transaction
                let bytes = certSections.reduce(0) { $0 + $1.count }
                note("   certificate complete: \(certSections.count) section(s), \(bytes) bytes")
                challenge = (0..<20).map { _ in UInt8.random(in: 0...255) }
                send(0x16, finalTransaction, [0])
                send(0x17, 0x101, challenge + [0])
                note("   challenged the pedal (0x17); waiting for its signature")
            }
        case 0x18:                                    // the signature over our challenge
            note("   signature received (\(p.data.count) bytes); accepting")
            send(0x19, p.transaction, [0])            // 0 = accepted
            openSession()
        case 0x4b:
            send(0x4c, p.transaction, [p.data.first ?? 0, 0, 0, 0, 0, 0, 0, 0, 0])
        case 0x02: break                              // the pedal's ack of ours
        case 0x1a, 0x1d: ack(p, 5)
        case 0x64: ack(p, 2)
        default: ack(p, 5)
        }
    }

    /* The question this spike exists to answer. */
    func openSession() {
        guard let p = protocols.first(where: { $0.name == "jp.co.zoom.p1" }) else {
            failed = "pedal did not advertise jp.co.zoom.p1"; return
        }
        let tr = nextTransaction; nextTransaction += 1
        pendingSession = tr
        note("   opening data session on protocol index \(p.index) (\(p.name))")
        send(0x3f, tr, [0, 1, p.index])
    }

    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data: UnsafeMutableRawPointer!, length: Int) {
        parser.feed(Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: length)))
    }
    func rfcommChannelOpenComplete(_ ch: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        note(error == kIOReturnSuccess
             ? "channel \(channelID) OPEN (mtu \(ch.getMTU()))"
             : "channel open FAILED status=\(error)")
        if error != kIOReturnSuccess { failed = "channel open failed: \(error)" }
    }
    func rfcommChannelClosed(_ ch: IOBluetoothRFCOMMChannel!) { note("channel closed") }
}

guard let device = IOBluetoothDevice(addressString: addr) else { print("no device"); exit(1) }
print("device: \(device.name ?? "?")  connected=\(device.isConnected())  paired=\(device.isPaired())")

/* IOReturn as something readable. Every failure tonight has been silence --
   no callback, no code -- and silence is not a diagnosis. */
func ioName(_ rc: IOReturn) -> String {
    switch rc {
    case kIOReturnSuccess:      return "success"
    case kIOReturnNoDevice:     return "noDevice"
    case kIOReturnNotOpen:      return "notOpen"
    case kIOReturnTimeout:      return "TIMEOUT"
    case kIOReturnNotPermitted: return "notPermitted"
    case kIOReturnBusy:         return "busy"
    case kIOReturnError:        return "generalError"
    case kIOReturnNoResources:  return "noResources"
    case kIOReturnExclusiveAccess: return "EXCLUSIVE ACCESS (someone else holds it)"
    case kIOReturnAborted:      return "aborted"
    case kIOReturnNotResponding: return "notResponding"
    default:                    return String(format: "0x%08x", UInt32(bitPattern: rc))
    }
}

/* RFCOMM needs more than a baseband link: on an iAP accessory the channel is
   established over an AUTHENTICATED one, and SDP is not -- which is exactly the
   shape seen all night, SDP answering while every RFCOMM open stays silent. So
   bring the link up and authenticate it EXPLICITLY, and report what each step
   returns, instead of handing the whole thing to openRFCOMMChannelAsync and
   watching nothing happen. */
let spike = Spike()
note("baseband: connected=\(device.isConnected()) paired=\(device.isPaired())")
if !device.isConnected() {
    let rcOpen = device.openConnection()
    note("openConnection()        -> \(ioName(rcOpen))")
}
let rcAuth = device.requestAuthentication()
note("requestAuthentication() -> \(ioName(rcAuth))")
note("baseband now: connected=\(device.isConnected()) paired=\(device.isPaired())")
spike.parser.onPacket = { spike.receive($0) }
var ch: IOBluetoothRFCOMMChannel?
let rc = device.openRFCOMMChannelAsync(&ch, withChannelID: channelID, delegate: spike)
note("openRFCOMMChannelAsync()  -> \(ioName(rc))")
if rc != kIOReturnSuccess { exit(1) }
spike.channel = ch
note(racing
     ? "RACING: retrying the open every 0.4 s for 3 minutes -- power-cycle the pedal NOW"
     : waiting ? "channel open requested; retrying every 6 s for 4 minutes"
               : "channel open requested; waiting for the pedal")
var attempts = 0

/* The pedal answers a channel request only in some states, and which ones is
   the open question. Retrying lets it be changed while this watches, instead of
   racing a single 30-second attempt against walking to the pedal. */
if waiting || racing {
    Timer.scheduledTimer(withTimeInterval: retryEvery, repeats: true) { t in
        if spike.identified || spike.sessionOpen || spike.failed != nil || Date() >= deadline {
            t.invalidate(); return
        }
        spike.channel?.close()
        var again: IOBluetoothRFCOMMChannel?
        let rc = device.openRFCOMMChannelAsync(&again, withChannelID: channelID, delegate: spike)
        attempts += 1
        if rc == kIOReturnSuccess { spike.channel = again }
        else if attempts % 10 == 0 { note("attempt \(attempts) -> \(ioName(rc))") }
    }
}

/* The run loop is driven exactly the way rfcomm-listen does it: IOBluetooth
   delivers these callbacks on the main run loop, and a hand-rolled polling loop
   over RunLoop.current.run(mode:before:) never saw a single one -- the channel
   opened and the delegate stayed silent, which reads identically to a pedal
   that said nothing. A timer plus RunLoop.main.run() is what works. */
func finish() {
    if spike.sessionOpen {
        spike.send(0x40, spike.nextTransaction, [0, 1])   // leave no session behind
        spike.nextTransaction += 1
        note("sent 0x40 to close the data session")
    }
    spike.channel?.close()
    print("")
    print("identification: \(spike.identified ? "ACCEPTED" : "not reached")")
    print("data session  : \(spike.sessionOpen ? "OPEN" : "not opened")")
    print("protocols     : \(spike.protocols.map { "\($0.index):\($0.name)" }.joined(separator: ", "))")
    if let f = spike.failed { print("stopped       : \(f)") }
    exit(spike.sessionOpen ? 0 : 1)
}

Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { t in
    if spike.sessionOpen || spike.failed != nil || Date() >= deadline {
        /* Silence here is the pedal, not this tool: when it refuses RFCOMM the
           delegate never fires at all, and rfcomm-listen on channel 1 fails the
           same way at the same moment. Check that before suspecting the code. */
        if !spike.identified && spike.failed == nil {
            note("no reply from the pedal. Cross-check with: ./rfcomm-listen 1 20")
        }
        t.invalidate()
        // Give the 0x41 for a just-opened session a moment to be logged.
        Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { _ in finish() }
    }
}
RunLoop.main.run()

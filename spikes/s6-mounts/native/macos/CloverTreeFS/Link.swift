// The module's side of the link to the file service on another computer: request multiplexing,
// liveness pings, and failing fast when the computer drops. Same rules as the Go helper
// (spikes/s6-mounts/native/remote/client.go): any inbound frame proves the link alive; silence longer
// than `deadAfter` fails every pending call with EHOSTDOWN, and new calls fail at once until a
// redial succeeds. A call never waits longer than `opTimeout`.
//
// That bound matters more here than on Linux: a volume call FSKit never sees answered can leave
// the calling process unkillable (Apple forums thread 831396), so nothing may wait on the network
// without a deadline.

import Foundation
import Network
import os

typealias LinkReply = (Result<WireReader, LinkError>) -> Void

struct LinkError: Error { let errno: UInt16 }

final class Link {
    let host: String
    let port: UInt16
    var pingEvery: TimeInterval = 0.25
    var deadAfter: TimeInterval = 1.5
    var opTimeout: TimeInterval = 10
    var dialTimeout: TimeInterval = 1
    var onEvent: ((UInt8, String) -> Void)?
    var onReconnect: (() -> Void)?

    private let q = DispatchQueue(label: "clovertree.link")
    private let log = Logger(subsystem: "com.waifucave.clover.tree", category: "link")
    private var conn: NWConnection?
    private var online = false
    private var gen = 0
    private var everOnline = false
    private var pending: [UInt32: (reply: LinkReply, timer: DispatchSourceTimer)] = [:]
    private var nextID: UInt32 = 0
    private var inbuf = Data()
    private var lastRecv = DispatchTime.now()
    private var lastPing = DispatchTime.now()
    private var pingSeq: UInt32 = 0
    private var watchdog: DispatchSourceTimer?
    private var redialDelay: TimeInterval = 0.1
    private var stopped = false

    init(host: String, port: UInt16) {
        self.host = host
        self.port = port
    }

    func start() { q.async { self.dial() } }

    func stop() {
        q.async {
            self.stopped = true
            self.drop("stopped")
            self.watchdog?.cancel()
        }
    }

    var isOnline: Bool { q.sync { online } }

    /// Sends one request. `build` writes the op's arguments after the op byte.
    func call(_ op: Wire.Op, _ build: ((inout WireWriter) -> Void)? = nil, reply: @escaping LinkReply) {
        q.async {
            guard self.online, let conn = self.conn else {
                reply(.failure(LinkError(errno: Wire.EHOSTDOWN))) // the computer is away: at once
                return
            }
            self.nextID &+= 1
            if self.nextID == 0 { self.nextID = 1 }
            let id = self.nextID
            var w = WireWriter(kind: .req, id: id)
            w.u8(op.rawValue)
            build?(&w)
            let timer = DispatchSource.makeTimerSource(queue: self.q)
            timer.schedule(deadline: .now() + self.opTimeout)
            timer.setEventHandler { [weak self] in
                guard let self, let p = self.pending.removeValue(forKey: id) else { return }
                p.timer.cancel()
                p.reply(.failure(LinkError(errno: Wire.ETIMEDOUT)))
            }
            timer.resume()
            self.pending[id] = (reply, timer)
            conn.send(content: w.frame(), completion: .contentProcessed { _ in })
        }
    }

    // MARK: - connection

    private func dial() {
        guard !stopped else { return }
        gen += 1
        let myGen = gen
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: NWParameters(tls: nil, tcp: tcp))
        conn = c
        inbuf.removeAll()
        let giveUp = DispatchSource.makeTimerSource(queue: q)
        giveUp.schedule(deadline: .now() + dialTimeout)
        giveUp.setEventHandler { [weak self] in
            guard let self, self.gen == myGen, !self.online else { return }
            self.drop("no welcome within \(self.dialTimeout) s")
        }
        giveUp.resume()
        c.stateUpdateHandler = { [weak self] state in
            guard let self, self.gen == myGen else { return }
            switch state {
            case .ready:
                var hello = WireWriter(kind: .hello, id: 0)
                hello.u32(Wire.version)
                hello.str("clover-fskit")
                c.send(content: hello.frame(), completion: .contentProcessed { _ in })
                self.receive(c, myGen)
            case .failed(let e):
                giveUp.cancel()
                self.drop("connection failed: \(e)")
            case .waiting(let e):
                giveUp.cancel()
                self.drop("connection waiting: \(e)") // refused or unreachable: fail fast, redial
            case .cancelled:
                giveUp.cancel()
            default:
                break
            }
        }
        c.start(queue: q)
    }

    private func receive(_ c: NWConnection, _ myGen: Int) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 18) { [weak self] data, _, isComplete, error in
            guard let self, self.gen == myGen else { return }
            if let data, !data.isEmpty {
                self.lastRecv = .now()
                self.inbuf.append(data)
                self.parse()
            }
            if isComplete || error != nil {
                self.drop(error.map { "receive: \($0)" } ?? "closed by peer")
                return
            }
            self.receive(c, myGen)
        }
    }

    private func parse() {
        while inbuf.count >= 4 {
            let s = inbuf.startIndex
            let len = Int(UInt32(inbuf[s]) | UInt32(inbuf[s + 1]) << 8 | UInt32(inbuf[s + 2]) << 16 | UInt32(inbuf[s + 3]) << 24)
            guard len <= Wire.maxFrame else { drop("frame too large"); return }
            guard inbuf.count >= 4 + len else { return }
            let body = inbuf.subdata(in: (s + 4)..<(s + 4 + len))
            inbuf.removeSubrange(s..<(s + 4 + len))
            frame(body)
        }
    }

    private func frame(_ body: Data) {
        var r = WireReader(body)
        let kind = r.u8()
        let id = r.u32()
        switch Wire.Kind(rawValue: kind) {
        case .welcome:
            _ = r.u32()
            let instance = r.str()
            online = true
            redialDelay = 0.1
            lastRecv = .now()
            startWatchdog()
            log.info("online, file service \(instance, privacy: .public)")
            if everOnline { onReconnect?() }
            everOnline = true
        case .res:
            guard let p = pending.removeValue(forKey: id) else { return }
            p.timer.cancel()
            let err = r.u16()
            if err != 0 { p.reply(.failure(LinkError(errno: err))) } else { p.reply(.success(r)) }
        case .event:
            let type = r.u8()
            let path = r.str()
            onEvent?(type, path)
        case .ping:
            var w = WireWriter(kind: .pong, id: id)
            conn?.send(content: w.frame(), completion: .contentProcessed { _ in })
        case .pong:
            break
        default:
            drop("unknown frame kind \(kind)")
        }
    }

    private func startWatchdog() {
        guard watchdog == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + pingEvery / 2, repeating: pingEvery / 2)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        watchdog = t
    }

    private func tick() {
        guard online else { return }
        let now = DispatchTime.now()
        let silent = Double(now.uptimeNanoseconds - lastRecv.uptimeNanoseconds) / 1e9
        if silent > deadAfter {
            drop(String(format: "silent for %.3f s", silent))
            return
        }
        if Double(now.uptimeNanoseconds - lastPing.uptimeNanoseconds) / 1e9 >= pingEvery {
            lastPing = now
            pingSeq &+= 1
            var w = WireWriter(kind: .ping, id: pingSeq)
            conn?.send(content: w.frame(), completion: .contentProcessed { _ in })
        }
    }

    /// The link is down: fail everything pending now, answer new calls at once, redial.
    private func drop(_ reason: String) {
        let failed = pending
        pending.removeAll()
        let wasOnline = online
        online = false
        gen += 1
        conn?.stateUpdateHandler = nil
        conn?.cancel()
        conn = nil
        for (_, p) in failed {
            p.timer.cancel()
            p.reply(.failure(LinkError(errno: Wire.EHOSTDOWN)))
        }
        if wasOnline || !failed.isEmpty {
            log.info("offline: \(reason, privacy: .public) (\(failed.count) calls failed)")
        }
        guard !stopped else { return }
        let delay = redialDelay
        redialDelay = min(redialDelay * 2, 1)
        q.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.online, self.conn == nil else { return }
            self.dial()
        }
    }
}

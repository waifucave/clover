// The FSKit module: a unary file system whose resource is a clovertree:// URL naming the link to
// one other computer. Mounted with
//
//   mount -F -t clovertree clovertree://127.0.0.1:7500/Desktop1 <mount point>
//
// In Clover the URL names the local daemon's tree socket instead of a TCP port (see the report:
// a Unix socket in the app group container, the caller checked by its audit token).

import ExtensionFoundation
import FSKit
import Foundation
import os

@main
struct CloverTreeExtension: UnaryFileSystemExtension {
    var fileSystem: CloverTreeFileSystem { CloverTreeFileSystem.shared }
}

final class CloverTreeFileSystem: FSUnaryFileSystem, FSUnaryFileSystemOperations {
    static let shared = CloverTreeFileSystem()
    private let log = Logger(subsystem: "com.waifucave.clover.tree", category: "fs")
    private var volume: TreeVolume?

    /// `clovertree://<host>:<port>/<Computer>[?mitigate=0]`. `mitigate=0` turns off the
    /// short-read guard, so the live gate can check whether macOS still has the bug.
    private func parse(_ resource: FSResource) -> (host: String, port: UInt16, computer: String, mitigate: Bool)? {
        guard let r = resource as? FSGenericURLResource, r.url.scheme?.lowercased() == "clovertree",
              let host = r.url.host, let port = r.url.port, port > 0, port < 65536 else { return nil }
        let name = r.url.path.split(separator: "/").first.map(String.init) ?? host
        let items = URLComponents(url: r.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let mitigate = items.first(where: { $0.name == "mitigate" })?.value != "0"
        return (host, UInt16(port), name, mitigate)
    }

    func probeResource(resource: FSResource, replyHandler reply: @escaping @Sendable (FSProbeResult?, (any Error)?) -> Void) {
        guard let p = parse(resource) else { reply(.notRecognized, nil); return }
        // A stable container id per computer name, so the same computer keeps its identity.
        var bytes = [UInt8](repeating: 0, count: 16)
        for (i, b) in Array("clovertree/\(p.computer)".utf8).enumerated() { bytes[i % 16] &+= b &* UInt8(truncatingIfNeeded: i + 1) }
        let uuid = NSUUID(uuidBytes: bytes) as UUID
        reply(.usable(name: p.computer, containerID: FSContainerIdentifier(uuid: uuid)), nil)
    }

    func loadResource(resource: FSResource, options: FSTaskOptions, replyHandler reply: @escaping @Sendable (FSVolume?, (any Error)?) -> Void) {
        guard let p = parse(resource) else { reply(nil, fs_errorForPOSIXError(EINVAL)); return }
        let link = Link(host: p.host, port: p.port)
        link.start()
        let v = TreeVolume(link: link, computer: p.computer)
        v.mitigateShortReads = p.mitigate
        volume = v
        containerStatus = .ready
        log.info("loaded \(p.computer, privacy: .public) via \(p.host, privacy: .public):\(p.port), short-read guard \(p.mitigate ? "on" : "off", privacy: .public)")
        reply(v, nil)
    }

    func unloadResource(resource: FSResource, options: FSTaskOptions, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) {
        volume?.link.stop()
        volume = nil
        reply(nil)
    }

    func didFinishLoading() {}
}

// One other computer's home folder as an FSKit volume, served over its link.
//
// Two rules shape this file:
//
// 1. Every call is answered within the link's bound (Link.swift). FSKit has no timeout of its own,
//    and a call it never sees answered can leave the caller unkillable.
//
// 2. FSKit's short-read bug (macFUSE #1188, #1222, #1231; mitigated in macFUSE 5.5.0). FSKit
//    keeps the file size it was last told and does not shrink a file when a read comes back short:
//    the reader receives the old length, and the bytes past what the module sent are padding,
//    zeros or stale memory. A file that changes size on the other computer hits this. Until Apple
//    fixes it, `read` (a) clears the unused tail of FSKit's buffer, (b) never answers a read that
//    FSKit believes is inside the file with fewer bytes than asked: it answers EIO instead, and
//    refreshes the item's size so the next stat is right, and (c) never answers 0 bytes for a
//    non-empty request inside the file.

import FSKit
import Foundation
import os

final class TreeItem: FSItem {
    var path: String
    var attr = WireAttr()
    var fetched: DispatchTime = .init(uptimeNanoseconds: 0)
    /// The size FSKit was last told: what it will believe until told otherwise.
    var reportedSize: UInt64 = 0
    var writeHandle: UInt64 = 0
    var writers = 0

    init(path: String) { self.path = path }
}

final class TreeVolume: FSVolume, FSVolume.Operations, FSVolume.ReadWriteOperations, FSVolume.OpenCloseOperations {
    let link: Link
    let computer: String
    /// The short-read guard (see the top of this file). Only the live gate turns it off.
    var mitigateShortReads = true
    private let log = Logger(subsystem: "com.waifucave.clover.tree", category: "volume")
    private let lock = NSLock()
    private var items: [String: TreeItem] = [:]
    private var root: TreeItem!
    private var stats = FSStatFSResult(fileSystemTypeName: "clovertree")
    private var listings: [String: (verifier: UInt64, entries: [(String, WireAttr)])] = [:]
    private var nextVerifier: UInt64 = 1
    private let attrTTL: UInt64 = 1_000_000_000 // 1 s, the "plain" policy
    private let uid = getuid(), gid = getgid()

    init(link: Link, computer: String) {
        self.link = link
        self.computer = computer
        super.init(volumeID: FSVolume.Identifier(uuid: UUID()), volumeName: FSFileName(string: computer))
        stats.blockSize = 4096
        stats.ioSize = 1 << 20
        stats.totalBlocks = 1 << 28
        stats.availableBlocks = 1 << 27
        stats.freeBlocks = 1 << 27
        stats.totalFiles = 1 << 24
        stats.freeFiles = 1 << 23
        link.onEvent = { [weak self] _, path in self?.changed(path) }
        link.onReconnect = { [weak self] in self?.forgetAll() }
    }

    // MARK: - helpers

    private func posix(_ e: UInt16) -> Error { fs_errorForPOSIXError(Wire.posix(e)) }
    private func join(_ dir: String, _ name: String) -> String { dir.isEmpty ? name : dir + "/" + name }

    private func item(for path: String) -> TreeItem {
        lock.lock(); defer { lock.unlock() }
        if path.isEmpty { return root }
        if let it = items[path] { return it }
        let it = TreeItem(path: path)
        items[path] = it
        return it
    }

    private func changed(_ path: String) {
        lock.lock(); defer { lock.unlock() }
        items[path]?.fetched = .init(uptimeNanoseconds: 0)
        let parent = path.split(separator: "/").dropLast().joined(separator: "/")
        listings[parent] = nil
        // macOS 26 gives the module no way to tell the kernel; macOS 27's DataCacheHandler can
        // revoke cached data (see the report). Our own caches are dropped here.
    }

    private func forgetAll() {
        lock.lock(); defer { lock.unlock() }
        for it in items.values { it.fetched = .init(uptimeNanoseconds: 0); it.writeHandle = 0 }
        listings.removeAll()
    }

    private func fileID(_ a: WireAttr, path: String) -> FSItem.Identifier {
        if path.isEmpty { return .rootDirectory }
        // The holder's inode number, so git's index stays valid; kept clear of FSKit's reserved ids.
        return FSItem.Identifier(rawValue: a.ino > 2 ? a.ino : a.ino | (1 << 62)) ?? .invalid
    }

    private func type(_ t: UInt8) -> FSItem.ItemType {
        switch t {
        case WireAttr.dir: return .directory
        case WireAttr.symlink: return .symlink
        case WireAttr.file: return .file
        default: return .unknown
        }
    }

    private func fill(_ out: FSItem.Attributes, _ a: WireAttr, _ it: TreeItem) {
        let typeBits: UInt32 = a.type == WireAttr.dir ? UInt32(S_IFDIR) : a.type == WireAttr.symlink ? UInt32(S_IFLNK) : UInt32(S_IFREG)
        out.type = type(a.type)
        out.mode = typeBits | (a.mode & 0o7777)
        out.uid = uid
        out.gid = gid
        out.linkCount = max(a.nlink, 1)
        out.size = a.size
        out.allocSize = (a.size + 4095) / 4096 * 4096
        out.fileID = fileID(a, path: it.path)
        out.parentID = it.path.isEmpty ? .parentOfRoot : .rootDirectory
        out.flags = 0
        out.modifyTime = ts(a.mtimeNs)
        out.changeTime = ts(a.ctimeNs)
        out.accessTime = ts(a.atimeNs)
        out.birthTime = ts(a.birthNs)
        it.reportedSize = a.size
    }

    private func ts(_ ns: Int64) -> timespec { timespec(tv_sec: Int(ns / 1_000_000_000), tv_nsec: Int(ns % 1_000_000_000)) }

    private func offlineRoot() -> WireAttr {
        var a = WireAttr()
        a.type = WireAttr.dir
        a.mode = 0o755
        a.nlink = 2
        return a
    }

    /// Attributes of `it`, from the item if fetched in the last second, else from the holder.
    private func stat(_ it: TreeItem, fresh: Bool = false, _ done: @escaping (Result<WireAttr, LinkError>) -> Void) {
        if !fresh, DispatchTime.now().uptimeNanoseconds &- it.fetched.uptimeNanoseconds < attrTTL {
            done(.success(it.attr))
            return
        }
        link.call(.stat, { $0.str(it.path) }) { r in
            switch r {
            case .success(var rd):
                let a = rd.attr()
                it.attr = a
                it.fetched = .now()
                done(.success(a))
            case .failure(let e):
                if it.path.isEmpty, e.errno == Wire.EHOSTDOWN { done(.success(self.offlineRoot())); return }
                done(.failure(e))
            }
        }
    }

    // MARK: - FSVolume.PathConfOperations

    var maximumLinkCount: Int { 32767 }
    var maximumNameLength: Int { 255 }
    var restrictsOwnershipChanges: Bool { true }
    var truncatesLongNames: Bool { false }

    // MARK: - FSVolume.Operations

    var supportedVolumeCapabilities: FSVolume.SupportedCapabilities {
        let c = FSVolume.SupportedCapabilities()
        c.supportsSymbolicLinks = true
        c.supportsHardLinks = true
        c.supports64BitObjectIDs = true
        c.supportsPersistentObjectIDs = false
        c.supportsHiddenFiles = true
        c.supports2TBFiles = true
        c.caseFormat = .sensitive
        return c
    }

    var volumeStatistics: FSStatFSResult {
        link.call(.statfs) { [weak self] r in
            guard let self, case .success(var rd) = r else { return }
            let bsize = rd.u64(), blocks = rd.u64(), bfree = rd.u64(), bavail = rd.u64(), files = rd.u64(), ffree = rd.u64()
            self.stats.blockSize = Int(bsize)
            self.stats.totalBlocks = blocks
            self.stats.freeBlocks = bfree
            self.stats.availableBlocks = bavail
            self.stats.totalFiles = files
            self.stats.freeFiles = ffree
        }
        return stats // never wait on the network for statfs
    }

    func mount(options: FSTaskOptions, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) { reply(nil) }
    func unmount(replyHandler reply: @escaping @Sendable () -> Void) { link.stop(); reply() }
    func synchronize(flags: FSSyncFlags, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) { reply(nil) }

    func activate(options: FSTaskOptions, replyHandler reply: @escaping @Sendable (FSItem?, (any Error)?) -> Void) {
        root = TreeItem(path: "")
        root.attr = offlineRoot()
        link.call(.watch, { $0.u8(1) }) { _ in }
        reply(root, nil)
    }

    func deactivate(options: FSDeactivateOptions = [], replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) { reply(nil) }

    func getAttributes(_ desired: FSItem.GetAttributesRequest, of item: FSItem, replyHandler reply: @escaping @Sendable (FSItem.Attributes?, (any Error)?) -> Void) {
        guard let it = item as? TreeItem else { reply(nil, fs_errorForPOSIXError(EINVAL)); return }
        stat(it) { r in
            switch r {
            case .success(let a):
                let out = FSItem.Attributes()
                self.fill(out, a, it)
                reply(out, nil)
            case .failure(let e): reply(nil, self.posix(e.errno))
            }
        }
    }

    func setAttributes(_ req: FSItem.SetAttributesRequest, on item: FSItem, replyHandler reply: @escaping @Sendable (FSItem.Attributes?, (any Error)?) -> Void) {
        guard let it = item as? TreeItem else { reply(nil, fs_errorForPOSIXError(EINVAL)); return }
        var mask: UInt32 = 0
        var consumed: FSItem.Attribute = []
        if req.isValid(.mode) { mask |= Wire.setMode; consumed.insert(.mode) }
        if req.isValid(.size) { mask |= Wire.setSize; consumed.insert(.size) }
        if req.isValid(.accessTime) { mask |= Wire.setAtime; consumed.insert(.accessTime) }
        if req.isValid(.modifyTime) { mask |= Wire.setMtime; consumed.insert(.modifyTime) }
        let nanos = { (t: timespec) in Int64(t.tv_sec) * 1_000_000_000 + Int64(t.tv_nsec) }
        let mode = req.mode, size = req.size, at = nanos(req.accessTime), mt = nanos(req.modifyTime)
        link.call(.setattr, { w in
            w.str(it.path); w.u64(it.writeHandle); w.u32(mask); w.u32(mode & 0o7777); w.u64(size); w.i64(at); w.i64(mt)
        }) { r in
            switch r {
            case .success(var rd):
                let a = rd.attr()
                it.attr = a
                it.fetched = .now()
                req.consumedAttributes = consumed
                let out = FSItem.Attributes()
                self.fill(out, a, it)
                reply(out, nil)
            case .failure(let e): reply(nil, self.posix(e.errno))
            }
        }
    }

    func lookupItem(named name: FSFileName, inDirectory directory: FSItem, replyHandler reply: @escaping @Sendable (FSItem?, FSFileName?, (any Error)?) -> Void) {
        guard let dir = directory as? TreeItem, let n = name.string else { reply(nil, nil, fs_errorForPOSIXError(EINVAL)); return }
        let it = item(for: join(dir.path, n))
        stat(it) { r in
            switch r {
            case .success(let a):
                it.reportedSize = a.size
                reply(it, name, nil)
            case .failure(let e): reply(nil, nil, self.posix(e.errno))
            }
        }
    }

    func reclaimItem(_ item: FSItem, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) {
        if let it = item as? TreeItem, !it.path.isEmpty {
            lock.lock()
            if items[it.path] === it { items[it.path] = nil }
            lock.unlock()
        }
        reply(nil)
    }

    func readSymbolicLink(_ item: FSItem, replyHandler reply: @escaping @Sendable (FSFileName?, (any Error)?) -> Void) {
        guard let it = item as? TreeItem else { reply(nil, fs_errorForPOSIXError(EINVAL)); return }
        link.call(.readlink, { $0.str(it.path) }) { r in
            switch r {
            case .success(var rd): reply(FSFileName(string: rd.str()), nil)
            case .failure(let e): reply(nil, self.posix(e.errno))
            }
        }
    }

    func createItem(named name: FSFileName, type: FSItem.ItemType, inDirectory directory: FSItem, attributes newAttributes: FSItem.SetAttributesRequest, replyHandler reply: @escaping @Sendable (FSItem?, FSFileName?, (any Error)?) -> Void) {
        guard let dir = directory as? TreeItem, let n = name.string else { reply(nil, nil, fs_errorForPOSIXError(EINVAL)); return }
        let path = join(dir.path, n)
        let mode = newAttributes.isValid(.mode) ? newAttributes.mode & 0o7777 : (type == .directory ? 0o755 : 0o644)
        let finish: (Result<WireAttr, LinkError>) -> Void = { r in
            switch r {
            case .success(let a):
                let it = self.item(for: path)
                it.attr = a
                it.fetched = .now()
                it.reportedSize = a.size
                self.changed(path)
                reply(it, name, nil)
            case .failure(let e): reply(nil, nil, self.posix(e.errno))
            }
        }
        switch type {
        case .directory:
            link.call(.mkdir, { $0.str(path); $0.u32(mode) }) { r in finish(r.map { var rd = $0; return rd.attr() }) }
        case .file:
            link.call(.open, { $0.str(path); $0.u32(Wire.oWronly | Wire.oCreat | Wire.oExcl); $0.u32(mode) }) { r in
                finish(r.map { rd in
                    var rd = rd
                    let h = rd.u64()
                    self.link.call(.close, { $0.u64(h) }) { _ in }
                    return rd.attr()
                })
            }
        default:
            reply(nil, nil, fs_errorForPOSIXError(ENOTSUP))
        }
    }

    func createSymbolicLink(named name: FSFileName, inDirectory directory: FSItem, attributes newAttributes: FSItem.SetAttributesRequest, linkContents contents: FSFileName, replyHandler reply: @escaping @Sendable (FSItem?, FSFileName?, (any Error)?) -> Void) {
        guard let dir = directory as? TreeItem, let n = name.string, let target = contents.string else { reply(nil, nil, fs_errorForPOSIXError(EINVAL)); return }
        let path = join(dir.path, n)
        link.call(.symlink, { $0.str(path); $0.str(target) }) { r in
            switch r {
            case .success(var rd):
                let it = self.item(for: path)
                it.attr = rd.attr()
                it.fetched = .now()
                self.changed(path)
                reply(it, name, nil)
            case .failure(let e): reply(nil, nil, self.posix(e.errno))
            }
        }
    }

    func createLink(to item: FSItem, named name: FSFileName, inDirectory directory: FSItem, replyHandler reply: @escaping @Sendable (FSFileName?, (any Error)?) -> Void) {
        guard let it = item as? TreeItem, let dir = directory as? TreeItem, let n = name.string else { reply(nil, fs_errorForPOSIXError(EINVAL)); return }
        let path = join(dir.path, n)
        link.call(.link, { $0.str(it.path); $0.str(path) }) { r in
            switch r {
            case .success: self.changed(path); reply(name, nil)
            case .failure(let e): reply(nil, self.posix(e.errno))
            }
        }
    }

    func removeItem(_ item: FSItem, named name: FSFileName, fromDirectory directory: FSItem, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) {
        guard let it = item as? TreeItem, let dir = directory as? TreeItem, let n = name.string else { reply(fs_errorForPOSIXError(EINVAL)); return }
        let path = join(dir.path, n)
        let op: Wire.Op = it.attr.type == WireAttr.dir ? .rmdir : .unlink
        link.call(op, { $0.str(path) }) { r in
            switch r {
            case .success: self.changed(path); reply(nil)
            case .failure(let e): reply(self.posix(e.errno))
            }
        }
    }

    func renameItem(_ item: FSItem, inDirectory sourceDirectory: FSItem, named sourceName: FSFileName, to destinationName: FSFileName, inDirectory destinationDirectory: FSItem, overItem: FSItem?, replyHandler reply: @escaping @Sendable (FSFileName?, (any Error)?) -> Void) {
        guard let it = item as? TreeItem, let sd = sourceDirectory as? TreeItem, let dd = destinationDirectory as? TreeItem,
              let sn = sourceName.string, let dn = destinationName.string else { reply(nil, fs_errorForPOSIXError(EINVAL)); return }
        let from = join(sd.path, sn), to = join(dd.path, dn)
        link.call(.rename, { $0.str(from); $0.str(to); $0.u32(0) }) { r in
            switch r {
            case .success:
                self.lock.lock()
                for (p, x) in self.items where p == from || p.hasPrefix(from + "/") {
                    self.items[p] = nil
                    x.path = to + p.dropFirst(from.count)
                    self.items[x.path] = x
                }
                it.path = to
                self.lock.unlock()
                self.changed(from)
                self.changed(to)
                reply(destinationName, nil)
            case .failure(let e): reply(nil, self.posix(e.errno))
            }
        }
    }

    func enumerateDirectory(_ directory: FSItem, startingAt cookie: FSDirectoryCookie, verifier: FSDirectoryVerifier, attributes: FSItem.GetAttributesRequest?, packer: FSDirectoryEntryPacker, replyHandler reply: @escaping @Sendable (FSDirectoryVerifier, (any Error)?) -> Void) {
        guard let dir = directory as? TreeItem else { reply(verifier, fs_errorForPOSIXError(EINVAL)); return }
        let pack: (UInt64, [(String, WireAttr)]) -> Void = { v, entries in
            // Cookies are indexes into one snapshot of the listing, so a resumed enumeration never
            // repeats or skips an entry (the duplicate-listing bugs in macFUSE's FSKit backend).
            var names: [(String, FSItem.ItemType, FSItem.Identifier, WireAttr?)] = []
            if attributes == nil {
                names.append((".", .directory, self.fileID(dir.attr, path: dir.path), nil))
                names.append(("..", .directory, dir.path.isEmpty ? .parentOfRoot : .rootDirectory, nil))
            }
            for (n, a) in entries { names.append((n, self.type(a.type), self.fileID(a, path: self.join(dir.path, n)), a)) }
            var i = Int(cookie.rawValue)
            while i < names.count {
                let (n, t, id, a) = names[i]
                var attrs: FSItem.Attributes?
                if let a, attributes != nil {
                    let out = FSItem.Attributes()
                    self.fill(out, a, self.item(for: self.join(dir.path, n)))
                    attrs = out
                }
                if !packer.packEntry(name: FSFileName(string: n), itemType: t, itemID: id, nextCookie: FSDirectoryCookie(rawValue: UInt64(i + 1)), attributes: attrs) { break }
                i += 1
            }
            reply(FSDirectoryVerifier(rawValue: v), nil)
        }
        lock.lock()
        let snap = listings[dir.path]
        lock.unlock()
        if cookie != .initial, let snap, snap.verifier == verifier.rawValue {
            pack(snap.verifier, snap.entries)
            return
        }
        link.call(.list, { $0.str(dir.path) }) { r in
            switch r {
            case .success(var rd):
                var entries: [(String, WireAttr)] = []
                let n = rd.u32()
                for _ in 0..<n { let name = rd.str(); entries.append((name, rd.attr())) }
                self.lock.lock()
                let v = self.nextVerifier
                self.nextVerifier += 1
                self.listings[dir.path] = (v, entries)
                self.lock.unlock()
                pack(v, entries)
            case .failure(let e): reply(verifier, self.posix(e.errno))
            }
        }
    }

    // MARK: - FSVolume.OpenCloseOperations

    var isOpenCloseInhibited: Bool = false

    func openItem(_ item: FSItem, modes: FSVolume.OpenModes, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) {
        guard let it = item as? TreeItem else { reply(fs_errorForPOSIXError(EINVAL)); return }
        guard modes.contains(.write), it.attr.type == WireAttr.file else { reply(nil); return } // reads: stateless, no round trip
        lock.lock()
        it.writers += 1
        let need = it.writeHandle == 0
        lock.unlock()
        guard need else { reply(nil); return }
        link.call(.open, { $0.str(it.path); $0.u32(Wire.oRdwr); $0.u32(0) }) { r in
            switch r {
            case .success(var rd):
                it.writeHandle = rd.u64()
                reply(nil)
            case .failure(let e):
                self.lock.lock(); it.writers -= 1; self.lock.unlock()
                reply(self.posix(e.errno))
            }
        }
    }

    func closeItem(_ item: FSItem, modes: FSVolume.OpenModes, replyHandler reply: @escaping @Sendable ((any Error)?) -> Void) {
        if let it = item as? TreeItem, modes.contains(.write) {
            lock.lock()
            it.writers = max(0, it.writers - 1)
            let h = it.writers == 0 ? it.writeHandle : 0
            if h != 0 { it.writeHandle = 0 }
            lock.unlock()
            if h != 0 { link.call(.close, { $0.u64(h) }) { _ in } } // never hold close(2) on the network
        }
        reply(nil)
    }

    // MARK: - FSVolume.ReadWriteOperations

    func read(from item: FSItem, at offset: off_t, length: Int, into buffer: FSMutableFileDataBuffer, replyHandler reply: @escaping @Sendable (Int, (any Error)?) -> Void) {
        guard let it = item as? TreeItem else { reply(0, fs_errorForPOSIXError(EINVAL)); return }
        let want = min(length, buffer.length)
        link.call(.read, { $0.str(it.path); $0.u64(it.writeHandle); $0.u64(UInt64(offset)); $0.u32(UInt32(want)) }) { r in
            switch r {
            case .success(var rd):
                let data = rd.bytes()
                let n = data.count
                let guardOn = self.mitigateShortReads
                buffer.withUnsafeMutableBytes { dst in
                    data.copyBytes(to: dst, count: min(n, dst.count))
                    if guardOn, n < dst.count { memset(dst.baseAddress! + n, 0, dst.count - n) } // (a) clear the tail
                }
                let believed = it.reportedSize
                if guardOn, n < want, UInt64(offset) + UInt64(n) < believed {
                    // (b)+(c): FSKit thinks the file is longer than it now is. A short answer here
                    // would hand the reader bytes we never sent; fail the read and refresh.
                    self.log.error("short read of \(it.path, privacy: .public) at \(offset): \(n) of \(want), FSKit believes \(believed) bytes; EIO")
                    it.fetched = .init(uptimeNanoseconds: 0)
                    reply(0, fs_errorForPOSIXError(EIO))
                    return
                }
                reply(n, nil)
            case .failure(let e): reply(0, self.posix(e.errno))
            }
        }
    }

    func write(contents: Data, to item: FSItem, at offset: off_t, replyHandler reply: @escaping @Sendable (Int, (any Error)?) -> Void) {
        guard let it = item as? TreeItem else { reply(0, fs_errorForPOSIXError(EINVAL)); return }
        let send: (UInt64) -> Void = { h in
            self.link.call(.write, { $0.str(it.path); $0.u64(h); $0.u64(UInt64(offset)); $0.data(contents) }) { r in
                switch r {
                case .success(var rd):
                    let n = Int(rd.u32())
                    it.fetched = .init(uptimeNanoseconds: 0)
                    let end = UInt64(offset) + UInt64(n)
                    if end > it.reportedSize { it.reportedSize = end }
                    reply(n, nil)
                case .failure(let e): reply(0, self.posix(e.errno))
                }
            }
        }
        if it.writeHandle != 0 { send(it.writeHandle); return }
        link.call(.open, { $0.str(it.path); $0.u32(Wire.oWronly); $0.u32(0) }) { r in
            switch r {
            case .success(var rd): let h = rd.u64(); it.writeHandle = h; send(h)
            case .failure(let e): reply(0, self.posix(e.errno))
            }
        }
    }
}

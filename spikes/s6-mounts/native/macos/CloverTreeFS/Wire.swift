// clover-tree wire protocol v1 — the Swift side (../../PROTOCOL.md).

import Foundation

enum Wire {
    static let version: UInt32 = 1
    static let maxFrame = 16 << 20

    enum Kind: UInt8 { case hello = 1, welcome, req, res, event, ping, pong }

    enum Op: UInt8 {
        case stat = 1, list, tree, read, open, write, close, fsync, setattr, mkdir, unlink, rmdir,
             rename, symlink, readlink, statfs, link, watch, sleep
    }

    // Linux errno numbers on the wire.
    static let ENOENT: UInt16 = 2, EIO: UInt16 = 5, EACCES: UInt16 = 13, EEXIST: UInt16 = 17,
               EXDEV: UInt16 = 18, ENOTDIR: UInt16 = 20, EISDIR: UInt16 = 21, EINVAL: UInt16 = 22,
               ENOSPC: UInt16 = 28, EROFS: UInt16 = 30, ENAMETOOLONG: UInt16 = 36,
               ENOTEMPTY: UInt16 = 39, ELOOP: UInt16 = 40, ENOTSUP: UInt16 = 95,
               ETIMEDOUT: UInt16 = 110, EHOSTDOWN: UInt16 = 112, ESTALE: UInt16 = 116

    /// Wire errno to this platform's POSIX code.
    static func posix(_ e: UInt16) -> Int32 {
        switch e {
        case 1: return EPERM
        case 2: return Darwin.ENOENT
        case 4: return EINTR
        case 5: return Darwin.EIO
        case 9: return EBADF
        case 13: return Darwin.EACCES
        case 16: return EBUSY
        case 17: return Darwin.EEXIST
        case 18: return Darwin.EXDEV
        case 20: return Darwin.ENOTDIR
        case 21: return Darwin.EISDIR
        case 22: return Darwin.EINVAL
        case 24: return EMFILE
        case 26: return ETXTBSY
        case 27: return EFBIG
        case 28: return Darwin.ENOSPC
        case 30: return Darwin.EROFS
        case 31: return EMLINK
        case 36: return Darwin.ENAMETOOLONG
        case 39: return Darwin.ENOTEMPTY
        case 40: return Darwin.ELOOP
        case 95: return Darwin.ENOTSUP
        case 110: return Darwin.ETIMEDOUT
        case 112: return Darwin.EHOSTDOWN
        case 116: return Darwin.ESTALE
        default: return Darwin.EIO
        }
    }

    // Open flags (Linux values on the wire).
    static let oWronly: UInt32 = 1, oRdwr: UInt32 = 2, oCreat: UInt32 = 0x40, oExcl: UInt32 = 0x80,
               oTrunc: UInt32 = 0x200, oAppend: UInt32 = 0x400
    static let setMode: UInt32 = 1, setSize: UInt32 = 2, setAtime: UInt32 = 4, setMtime: UInt32 = 8
}

struct WireAttr {
    var type: UInt8 = 0
    var mode: UInt32 = 0
    var size: UInt64 = 0
    var mtimeNs: Int64 = 0
    var ctimeNs: Int64 = 0
    var atimeNs: Int64 = 0
    var birthNs: Int64 = 0
    var ino: UInt64 = 0
    var nlink: UInt32 = 0
    var uid: UInt32 = 0
    var gid: UInt32 = 0

    static let file: UInt8 = 1, dir: UInt8 = 2, symlink: UInt8 = 3
}

struct WireWriter {
    private(set) var bytes: [UInt8]

    init(kind: Wire.Kind, id: UInt32) {
        bytes = [0, 0, 0, 0]
        bytes.reserveCapacity(64)
        u8(kind.rawValue)
        u32(id)
    }
    mutating func u8(_ v: UInt8) { bytes.append(v) }
    mutating func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { bytes.append(contentsOf: $0) } }
    mutating func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { bytes.append(contentsOf: $0) } }
    mutating func u64(_ v: UInt64) { withUnsafeBytes(of: v.littleEndian) { bytes.append(contentsOf: $0) } }
    mutating func i64(_ v: Int64) { u64(UInt64(bitPattern: v)) }
    mutating func data(_ d: Data) { u32(UInt32(d.count)); bytes.append(contentsOf: d) }
    mutating func str(_ s: String) { data(Data(s.utf8)) }
    /// The finished frame, length prefix included.
    mutating func frame() -> Data {
        let n = UInt32(bytes.count - 4).littleEndian
        withUnsafeBytes(of: n) { p in for i in 0..<4 { bytes[i] = p[i] } }
        return Data(bytes)
    }
}

struct WireReader {
    let data: Data
    private var off: Int
    private(set) var failed = false

    init(_ data: Data, offset: Int = 0) {
        self.data = data
        self.off = data.startIndex + offset
    }
    private mutating func take(_ n: Int) -> Data? {
        if failed || off + n > data.endIndex { failed = true; return nil }
        defer { off += n }
        return data[off..<(off + n)]
    }
    private mutating func int<T: FixedWidthInteger>(_: T.Type) -> T {
        guard let d = take(MemoryLayout<T>.size) else { return 0 }
        var v: T = 0
        _ = withUnsafeMutableBytes(of: &v) { d.copyBytes(to: $0) }
        return T(littleEndian: v)
    }
    mutating func u8() -> UInt8 { int(UInt8.self) }
    mutating func u16() -> UInt16 { int(UInt16.self) }
    mutating func u32() -> UInt32 { int(UInt32.self) }
    mutating func u64() -> UInt64 { int(UInt64.self) }
    mutating func i64() -> Int64 { Int64(bitPattern: u64()) }
    mutating func bytes() -> Data { let n = Int(u32()); return take(n) ?? Data() }
    mutating func str() -> String { String(decoding: bytes(), as: UTF8.self) }
    mutating func attr() -> WireAttr {
        WireAttr(type: u8(), mode: u32(), size: u64(), mtimeNs: i64(), ctimeNs: i64(), atimeNs: i64(),
                 birthNs: i64(), ino: u64(), nlink: u32(), uid: u32(), gid: u32())
    }
}

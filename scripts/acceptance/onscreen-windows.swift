// The windows on this Mac's screen now, from the window server (lane HS's host row: nothing of the host may be on the
// screen): one JSON line per on-screen window, its owner's pid, its opacity, its layer and its size. No titles or names
// are read (they need the screen-recording permission, and say what the person has open).
import CoreGraphics
import Foundation

let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
for w in list {
  let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
  let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1
  let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
  let b = (w[kCGWindowBounds as String] as? [String: Double]) ?? [:]
  print("{\"pid\":\(pid),\"alpha\":\(alpha),\"layer\":\(layer),\"w\":\(Int(b["Width"] ?? 0)),\"h\":\(Int(b["Height"] ?? 0))}")
}

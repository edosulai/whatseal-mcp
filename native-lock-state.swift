import Foundation
import CoreGraphics

// Tiny helper used by install-launchagent when available.
// Prints: {"screenLocked":true|false}
// No message content, no network, no keep-alive.

let dict = CGSessionCopyCurrentDictionary() as? [String: Any]
let locked: Bool
if let value = dict?["CGSSessionScreenIsLocked"] as? Bool {
  locked = value
} else if let value = dict?["CGSSessionScreenIsLocked"] as? Int {
  locked = value != 0
} else if let value = dict?["CGSSessionScreenIsLocked"] as? NSNumber {
  locked = value.boolValue
} else {
  locked = false
}

let payload: [String: Any] = ["screenLocked": locked]
let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
if let text = String(data: data, encoding: .utf8) {
  print(text)
}

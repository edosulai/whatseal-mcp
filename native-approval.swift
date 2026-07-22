import AppKit
import Foundation
import LocalAuthentication

struct ApprovalPayload: Decodable {
    let target: String
    let text: String
    let action: String?
}

func fail(_ message: String, code: Int32 = 3) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let payload: ApprovalPayload
do {
    payload = try JSONDecoder().decode(ApprovalPayload.self, from: input)
} catch {
    fail("Invalid approval payload.")
}

guard !payload.target.isEmpty, !payload.text.isEmpty, payload.text.count <= 10_000 else {
    fail("The immutable target or message body is invalid.")
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.activate(ignoringOtherApps: true)

let alert = NSAlert()
alert.alertStyle = .critical
let action = payload.action ?? "send-text"
alert.messageText = "Authorize this WhatsApp action?"
alert.informativeText = "Target: \(payload.target)\nAction: \(action)\n\nImmutable preview:\n\(payload.text)\n\nThis action requires Touch ID or your macOS login password."
alert.addButton(withTitle: "Authenticate and Continue")
alert.addButton(withTitle: "Cancel")

guard alert.runModal() == .alertFirstButtonReturn else {
    exit(2)
}

let context = LAContext()
context.localizedCancelTitle = "Cancel"
var authorizationError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authorizationError) else {
    fail("macOS user-presence authentication is unavailable: \(authorizationError?.localizedDescription ?? "unknown error")")
}

let semaphore = DispatchSemaphore(value: 0)
var authorized = false
var evaluationError: Error?
context.evaluatePolicy(
    .deviceOwnerAuthentication,
    localizedReason: "Authorize WhatsApp action \(action) for \(payload.target)"
) { success, error in
    authorized = success
    evaluationError = error
    semaphore.signal()
}
semaphore.wait()

guard authorized else {
    if let error = evaluationError {
        FileHandle.standardError.write(Data(("Authorization declined: \(error.localizedDescription)\n").utf8))
    }
    exit(2)
}

exit(0)
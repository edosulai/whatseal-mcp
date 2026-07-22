import AppKit
import Foundation
import LocalAuthentication

struct VersionTuple: Decodable {
    let whatsappWebVersion: String
    let browserVersion: String
    let nodeVersion: String
    let platform: String
    let backendVersion: String
    let whatsappWebJsVersion: String
    let whatsappWebJsSource: String
    let packageLockSha256: String
    let backendStartupSourceSha256: String
    let backendCurrentDiskSourceSha256: String
    let backendSourceMatchesStartup: Bool
    let installedDependenciesStartupSha256: String
    let messageApprovalHelperSha256: String
    let baselineApprovalHelperSha256: String
}

func fail(_ message: String, code: Int32 = 3) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let tuple: VersionTuple
do {
    tuple = try JSONDecoder().decode(VersionTuple.self, from: input)
} catch {
    fail("Invalid compatibility baseline payload.")
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.activate(ignoringOtherApps: true)

let alert = NSAlert()
alert.alertStyle = .critical
alert.messageText = "Approve this WhatsApp compatibility baseline?"
alert.informativeText = """
WhatsApp Web: \(tuple.whatsappWebVersion)
Chrome: \(tuple.browserVersion)
Node: \(tuple.nodeVersion)
Platform: \(tuple.platform)
Backend: \(tuple.backendVersion)
whatsapp-web.js package: \(tuple.whatsappWebJsVersion)
whatsapp-web.js source: \(tuple.whatsappWebJsSource)
Lockfile SHA-256: \(tuple.packageLockSha256)
Backend startup source SHA-256: \(tuple.backendStartupSourceSha256)
Backend current-disk source SHA-256: \(tuple.backendCurrentDiskSourceSha256)
Source matches startup: \(tuple.backendSourceMatchesStartup)
Installed dependencies startup SHA-256: \(tuple.installedDependenciesStartupSha256)
Message helper SHA-256: \(tuple.messageApprovalHelperSha256)
Baseline helper SHA-256: \(tuple.baselineApprovalHelperSha256)

Approving enables chat-content access and user-authorized sending only for this exact tuple. Any detected future drift blocks them again. This protects against accidental/cooperative changes, not malicious code already running as your macOS user.
"""
alert.addButton(withTitle: "Authenticate and Approve")
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
    localizedReason: "Approve this exact WhatsApp compatibility baseline"
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
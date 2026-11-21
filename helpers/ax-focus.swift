// beckon-ax: prints, as JSON, the element that has keyboard focus in an app, so beckon can check
// where a secret would go before typing it. Read-only; needs the Accessibility permission.
//
//   beckon-ax [app name or bundle id]   (default: the frontmost app)
//
// Output: {"app","bundleId","pid","role","subrole","label","url"} or {"error"}.
// "url" is the page address when the focus is inside a web view (AXWebArea's AXURL), else the
// window's document URL when it has one.

import AppKit
import ApplicationServices
import Foundation

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func string(_ element: AXUIElement, _ name: String) -> String? {
    if let s = attr(element, name) as? String { return s }
    if let u = attr(element, name) as? URL { return u.absoluteString }
    if let u = attr(element, name) as? NSURL { return u.absoluteString }
    return nil
}

func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(object["error"] == nil ? 0 : 1)
}

guard AXIsProcessTrusted() else { emit(["error": "accessibility permission is missing"]) }

let wanted = CommandLine.arguments.dropFirst().first
let app: NSRunningApplication? = {
    guard let wanted else { return NSWorkspace.shared.frontmostApplication }
    return NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier == wanted || $0.localizedName == wanted
    }
}()
guard let app else { emit(["error": "app is not running"]) }

let appElement = AXUIElementCreateApplication(app.processIdentifier)
// Chromium and Electron apps build their full accessibility tree only for assistive tools.
AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
guard let focusedRef = attr(appElement, kAXFocusedUIElementAttribute) else {
    emit(["error": "nothing has focus in \(app.localizedName ?? "the app")"])
}
let focused = focusedRef as! AXUIElement

var label = string(focused, kAXTitleAttribute) ?? ""
if label.isEmpty { label = string(focused, kAXPlaceholderValueAttribute) ?? "" }
if label.isEmpty { label = string(focused, kAXDescriptionAttribute) ?? "" }

// Walk up to the web area for the page URL.
var url: String?
var current: AXUIElement? = focused
for _ in 0..<64 {
    guard let element = current else { break }
    if string(element, kAXRoleAttribute) == "AXWebArea", let u = string(element, "AXURL") {
        url = u
        break
    }
    current = attr(element, kAXParentAttribute).map { $0 as! AXUIElement }
}
if url == nil, let windowRef = attr(appElement, kAXFocusedWindowAttribute) {
    url = string(windowRef as! AXUIElement, kAXDocumentAttribute)
}

var out: [String: Any] = [
    "app": app.localizedName ?? "",
    "bundleId": app.bundleIdentifier ?? "",
    "pid": Int(app.processIdentifier),
    "frontmost": app.isActive,
    "role": string(focused, kAXRoleAttribute) ?? "",
    "subrole": string(focused, kAXSubroleAttribute) ?? "",
    "label": label,
]
if let url { out["url"] = url }
emit(out)

import Foundation

/// Notification bursts share one recovery; transient Bluetooth formats can settle before retrying.
struct NativeAudioRecovery {
    private(set) var attempt = 0
    private(set) var pending = false
    private(set) var recovering = false
    mutating func request(healthy: Bool) -> TimeInterval? {
        guard !healthy, !pending else { return nil }
        pending = true
        return 0.25
    }
    mutating func begin() -> Bool {
        pending = false
        let first = !recovering
        recovering = true; attempt += 1
        return first
    }
    mutating func retryDelay() -> TimeInterval? {
        guard attempt < 6 else { return nil }
        pending = true
        return min(2, 0.2 * pow(2, Double(attempt)))
    }
    mutating func reset() { attempt = 0; pending = false; recovering = false }
}

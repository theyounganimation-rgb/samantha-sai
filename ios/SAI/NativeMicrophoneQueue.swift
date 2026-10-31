import Foundation

/// One send in flight, bounded fresh PCM, and a time-based stall watchdog.
/// Never replay microphone speech captured during a broken connection.
struct NativeMicrophoneQueue {
    private(set) var bytes = Data()
    private(set) var inFlight: UUID?
    private(set) var sentAt: TimeInterval = 0
    private(set) var droppedBytes = 0
    let capacity = 32000 * 2
    mutating func append(_ data: Data) {
        bytes.append(data)
        if bytes.count > capacity {
            let excess = bytes.count - capacity
            bytes.removeFirst(excess); droppedBytes += excess
        }
    }
    mutating func next(now: TimeInterval) -> (id: UUID, data: Data)? {
        guard inFlight == nil, !bytes.isEmpty else { return nil }
        let n = min(bytes.count, 6400), data = Data(bytes.prefix(n)), id = UUID()
        bytes.removeFirst(n); inFlight = id; sentAt = now
        return (id, data)
    }
    mutating func completed(_ id: UUID) -> Bool {
        guard inFlight == id else { return false }
        inFlight = nil; return true
    }
    func stalled(now: TimeInterval) -> Bool { inFlight != nil && now - sentAt >= 5 }
    mutating func reset() { bytes.removeAll(); inFlight = nil; sentAt = 0 }
}

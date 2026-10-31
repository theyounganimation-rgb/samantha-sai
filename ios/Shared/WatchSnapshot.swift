import Foundation

struct WatchMessage: Codable, Identifiable {
    let id: String
    let role: String
    let text: String
    let timestamp: String
    var needsFullText: Bool? = nil
}

// Bound the paired-device payload; never turn a tool result into a message.
enum WatchSnapshot {
    static func messages(_ data: Data, maxEncodedBytes: Int = 42000) -> [WatchMessage] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = object["messages"] as? [[String: Any]] else { return [] }
        var result: [WatchMessage] = []
        for row in rows.reversed() {
            guard let role = row["role"] as? String, ["user", "assistant"].contains(role) else { continue }
            let body = (row["text"] as? String) ?? (row["content"] as? String) ?? ""
            let media = row["media"] as? [[String: Any]] ?? []
            let text = body + (media.isEmpty ? "" : "\n[Attachment · open on iPhone]")
            guard !text.isEmpty else { continue }
            let date: String
            if let value = row["timestamp"] as? String { date = value }
            else if let value = row["timestamp"] as? Double { date = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: value > 1e11 ? value / 1000 : value)) }
            else { date = "" }
            // Stable identity across refreshes, even on older history rows.
            let id = row["id"] as? String ?? "\(date):\(role):\(text.prefix(80))"
            let message = WatchMessage(id: id, role: role, text: text, timestamp: date)
            if let encoded = try? JSONEncoder().encode(result + [message]), encoded.count <= maxEncodedBytes {
                result.append(message)
            } else {
                // Transfer whole messages, never an unmarked truncated ending.
                if result.isEmpty { result.append(WatchMessage(id: id, role: role, text: "Long message · tap to read in full", timestamp: date, needsFullText: true)) }
                break
            }
            if result.count == 40 { break }
        }
        return result.reversed()
    }
}

import Foundation
import RoomPlan
import simd

private struct RoomPlanPackage: Encodable {
    let format = "space-map-roomplan"
    let version = 1
    let unit = "m"
    let source = "apple-roomplan"
    let capturedAt: String
    let rooms: [Room]

    struct Room: Encodable {
        let id: String
        let name: String
        let story: Int
        let height: Double
        let walls: [Wall]
        let openings: [Opening]
        let objects: [RoomObject]
    }

    struct Wall: Encodable {
        let id: String
        let start: [Double]
        let end: [Double]
        let confidence: String
    }

    struct Opening: Encodable {
        let id: String
        let kind: String
        let center: [Double]
        let width: Double
        let confidence: String
    }

    struct RoomObject: Encodable {
        let id: String
        let category: String
        let center: [Double]
        let size: [Double]
        let confidence: String
    }
}

struct RoomPlanExportFiles {
    let measurementsURL: URL
    let modelURL: URL
    let roomCount: Int
    let wallCount: Int
    let openingCount: Int
    let objectCount: Int
    let lowConfidenceCount: Int
}

/// Converts Apple's measured RoomPlan surfaces into the versioned JSON contract
/// accepted by the Space Map editor. The editor still requires manual alignment
/// and route graph review after import.
enum RoomPlanExport {
    static func write(_ capturedRooms: [CapturedRoom], to directory: URL) async throws -> RoomPlanExportFiles {
        guard !capturedRooms.isEmpty else { throw ExportError.noRooms }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let rooms = capturedRooms.enumerated().map { index, capturedRoom in
            let wallSurfaces = capturedRoom.walls.map(wall)
            let openingSurfaces = (capturedRoom.doors + capturedRoom.openings + capturedRoom.windows)
            .map(opening)
            return RoomPlanPackage.Room(
                id: capturedRoom.identifier.uuidString,
                name: "Помещение \(index + 1)",
                story: capturedRoom.story,
                height: measuredHeight(capturedRoom),
                walls: wallSurfaces,
                openings: openingSurfaces,
                objects: capturedRoom.objects.map(object)
            )
        }
        let iso = ISO8601DateFormatter().string(from: Date())
        let package = RoomPlanPackage(capturedAt: iso, rooms: rooms)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let measurementsURL = directory.appendingPathComponent("space-map-roomplan.json")
        try encoder.encode(package).write(to: measurementsURL, options: .atomic)

        let structure = try await StructureBuilder(options: []).capturedStructure(from: capturedRooms)
        let modelURL = directory.appendingPathComponent("space-map-roomplan.usdz")
        try structure.export(to: modelURL, metadataURL: nil, modelProvider: nil, exportOptions: .mesh)
        return RoomPlanExportFiles(
            measurementsURL: measurementsURL,
            modelURL: modelURL,
            roomCount: rooms.count,
            wallCount: rooms.reduce(0) { $0 + $1.walls.count },
            openingCount: rooms.reduce(0) { $0 + $1.openings.count },
            objectCount: rooms.reduce(0) { $0 + $1.objects.count },
            lowConfidenceCount: capturedRooms.reduce(0) { total, room in
                total
                    + room.walls.filter { $0.confidence == .low }.count
                    + (room.doors + room.openings + room.windows).filter { $0.confidence == .low }.count
                    + room.objects.filter { $0.confidence == .low }.count
            }
        )
    }

    private static func wall(_ surface: CapturedRoom.Surface) -> RoomPlanPackage.Wall {
        let transform = surface.transform
        let center = transform.columns.3
        let axis = SIMD2<Float>(transform.columns.0.x, transform.columns.0.z)
        let magnitude = max(simd_length(axis), 0.0001)
        let direction = axis / magnitude
        let halfLength = surface.dimensions.x / 2
        let start = SIMD2<Float>(center.x, center.z) - direction * halfLength
        let end = SIMD2<Float>(center.x, center.z) + direction * halfLength
        return .init(
            id: surface.identifier.uuidString,
            start: [Double(start.x), Double(-start.y)],
            end: [Double(end.x), Double(-end.y)],
            confidence: confidenceName(surface.confidence)
        )
    }

    private static func opening(_ surface: CapturedRoom.Surface) -> RoomPlanPackage.Opening {
        let center = surface.transform.columns.3
        let kind: String
        switch surface.category {
        case .window:
            kind = "window"
        case .opening:
            kind = "opening"
        case .door(_):
            kind = "door"
        default:
            kind = "opening"
        }
        return .init(
            id: surface.identifier.uuidString,
            kind: kind,
            center: [Double(center.x), Double(-center.z)],
            width: Double(surface.dimensions.x),
            confidence: confidenceName(surface.confidence)
        )
    }

    private static func confidenceName(_ confidence: CapturedRoom.Confidence) -> String {
        switch confidence {
        case .high:
            return "high"
        case .medium:
            return "medium"
        case .low:
            return "low"
        @unknown default:
            return "low"
        }
    }

    private static func object(_ item: CapturedRoom.Object) -> RoomPlanPackage.RoomObject {
        let center = item.transform.columns.3
        return .init(
            id: item.identifier.uuidString,
            category: String(describing: item.category),
            center: [Double(center.x), Double(-center.z)],
            size: [Double(item.dimensions.x), Double(item.dimensions.y), Double(item.dimensions.z)],
            confidence: confidenceName(item.confidence)
        )
    }

    private static func measuredHeight(_ room: CapturedRoom) -> Double {
        let heights = room.walls.map { Double($0.dimensions.y) }.filter { $0.isFinite && $0 > 0 }
        return heights.isEmpty ? 0 : heights.reduce(0, +) / Double(heights.count)
    }

    enum ExportError: Error { case noRooms }
}

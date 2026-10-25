import Foundation
import RoomPlan
import SwiftUI
import UIKit

struct RoomPlanScannerView: View {
    @State private var isScanning = false
    @State private var hasStartedSession = false
    @State private var scannerVisible = false
    @State private var rooms: [CapturedRoom] = []
    @State private var files: RoomPlanExportFiles?
    @State private var isExporting = false
    @State private var errorMessage: String?
    @State private var statusMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if RoomCaptureSession.isSupported {
                    scannerContent
                } else {
                    ContentUnavailableView(
                        "На этом устройстве нет LiDAR",
                        systemImage: "sensor.tag.radiowaves.forward",
                        description: Text("Нужен iPhone или iPad с LiDAR. На обычном iPhone 13 откройте веб-редактор и используйте фотосъёмку.")
                    )
                }
            }
            .navigationTitle("Карта пространства")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var scannerContent: some View {
        VStack(spacing: 14) {
            header

            RoomCaptureContainer(
                isScanning: $isScanning,
                onRoomComplete: { room in
                    guard scannerVisible else { return }
                    rooms.append(room)
                    files = nil
                    statusMessage = "Помещение \(rooms.count) распознано. Проверьте 3D-эскиз и добавьте следующее помещение или завершите объект."
                },
                onError: { message in
                    errorMessage = message
                    isScanning = false
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(.quaternary))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityLabel("Предпросмотр RoomPlan в реальном времени")

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let statusMessage {
                Text(statusMessage).font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let files {
                exportSummary(files)
            } else {
                scanActions
            }
        }
        .padding(16)
        .background(Color(uiColor: .systemGroupedBackground))
        .onAppear { scannerVisible = true }
        .onDisappear {
            scannerVisible = false
            isScanning = false
            // A new capture view has a new coordinate system; never merge across tab visits.
            if files == nil {
                rooms = []
                statusMessage = "Сеанс завершён при выходе из LiDAR. Начните новый обмер, чтобы сохранить общую систему координат комнат."
            }
        }
        .task {
            guard !hasStartedSession else { return }
            hasStartedSession = true
            isScanning = true
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "view.3d")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color(red: 0.77, green: 0.12, blue: 0.13))
                Text("LiDAR-обмер помещения")
                    .font(.headline)
                Spacer()
                Text("\(rooms.count) / 20")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .padding(.horizontal, 9).padding(.vertical, 6)
                    .background(.thinMaterial, in: Capsule())
            }
            Text(isScanning
                 ? "Медленно обойдите стены по периметру, держа телефон вертикально."
                 : "Проверьте 3D-эскиз, затем продолжите или завершите обмер.")
                .font(.subheadline).foregroundStyle(.secondary)
            Text("Снимайте по одной комнате, не покидая приложение между ними: так Apple RoomPlan сможет совместить их координаты.")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var scanActions: some View {
        if isScanning {
            Button {
                errorMessage = nil
                statusMessage = "Обрабатываем измерения RoomPlan…"
                isScanning = false
            } label: {
                Label("Завершить помещение", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.77, green: 0.12, blue: 0.13))
        } else {
            HStack(spacing: 10) {
                Button {
                    guard rooms.count < 20 else { return }
                    errorMessage = nil
                    statusMessage = nil
                    isScanning = true
                } label: {
                    Label(rooms.isEmpty ? "Сканировать" : "Следующая комната", systemImage: "plus.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(rooms.count >= 20)

                Button {
                    Task { await finishStructure() }
                } label: {
                    Label(isExporting ? "Собираем…" : "Собрать 3D-модель", systemImage: "cube.transparent")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0.77, green: 0.12, blue: 0.13))
                .disabled(rooms.isEmpty || isExporting)
            }
        }
    }

    private func exportSummary(_ result: RoomPlanExportFiles) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Измерения готовы к проверке", systemImage: "checkmark.seal.fill")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.green)
            Text("\(result.roomCount) комнат · \(result.wallCount) стен · \(result.openingCount) проёмов · \(result.objectCount) предметов")
                .font(.footnote).foregroundStyle(.secondary)
            Label(
                result.lowConfidenceCount == 0
                    ? "RoomPlan не отметил элементов с низкой уверенностью"
                    : "Низкая уверенность: \(result.lowConfidenceCount) элементов — проверьте их на объекте",
                systemImage: result.lowConfidenceCount == 0 ? "checkmark.circle" : "exclamationmark.triangle"
            )
            .font(.caption).foregroundStyle(result.lowConfidenceCount == 0 ? Color.gray : Color.orange)
            HStack(spacing: 10) {
                ShareLink(item: result.measurementsURL) {
                    Label("JSON для редактора", systemImage: "arrow.up.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                ShareLink(item: result.modelURL) {
                    Label("3D-модель USDZ", systemImage: "cube.transparent")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Button("Новый обмер") {
                rooms = []
                files = nil
                statusMessage = nil
                isScanning = true
            }
            .frame(maxWidth: .infinity)
            .buttonStyle(.bordered)
            if let editorURL = URL(string: "https://vladikgolosnoi.ru/editor/demo") {
                Link(destination: editorURL) {
                    Label("Открыть веб-редактор", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Text("JSON добавляется в редактор как обмерная подложка. USDZ откройте в Quick Look для 3D-показа. Совместите этажи и проверьте геометрию и маршруты вручную.")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 14))
    }

    @MainActor
    private func finishStructure() async {
        guard !rooms.isEmpty else { return }
        isExporting = true
        errorMessage = nil
        statusMessage = "Совмещаем помещения в общей системе координат и экспортируем модель…"
        defer { isExporting = false }
        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("space-map-\(UUID().uuidString)", isDirectory: true)
            let result = try await RoomPlanExport.write(rooms, to: directory)
            files = result
            statusMessage = nil
        } catch {
            errorMessage = "Не удалось объединить сканы. Убедитесь, что комнаты снимались подряд в одном здании и AR-сессия не прерывалась. \(error.localizedDescription)"
            statusMessage = nil
        }
    }
}

private struct RoomCaptureContainer: UIViewRepresentable {
    @Binding var isScanning: Bool
    let onRoomComplete: (CapturedRoom) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onRoomComplete: onRoomComplete, onError: onError)
    }

    func makeUIView(context: Context) -> RoomCaptureView {
        let view = RoomCaptureView(frame: .zero)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: RoomCaptureView, context: Context) {
        context.coordinator.onRoomComplete = onRoomComplete
        context.coordinator.onError = onError
        if isScanning && !context.coordinator.isRunning {
            context.coordinator.isRunning = true
            context.coordinator.isStopping = false
            view.captureSession.run(configuration: RoomCaptureSession.Configuration())
        } else if !isScanning && context.coordinator.isRunning && !context.coordinator.isStopping {
            context.coordinator.isStopping = true
            // Keep AR tracking alive so the next room remains in a mergeable world space.
            view.captureSession.stop(pauseARSession: false)
        }
    }

    static func dismantleUIView(_ view: RoomCaptureView, coordinator: Coordinator) {
        view.captureSession.stop(pauseARSession: true)
        view.delegate = nil
    }

    final class Coordinator: NSObject, RoomCaptureViewDelegate {
        var onRoomComplete: (CapturedRoom) -> Void
        var onError: (String) -> Void
        var isRunning = false
        var isStopping = false

        init(onRoomComplete: @escaping (CapturedRoom) -> Void, onError: @escaping (String) -> Void) {
            self.onRoomComplete = onRoomComplete
            self.onError = onError
        }

        func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
            if let error {
                DispatchQueue.main.async { self.onError(error.localizedDescription) }
                return false
            }
            return true
        }

        func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
            isRunning = false
            isStopping = false
            if let error {
                DispatchQueue.main.async { self.onError(error.localizedDescription) }
                return
            }
            DispatchQueue.main.async { self.onRoomComplete(processedResult) }
        }
    }
}

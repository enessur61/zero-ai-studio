import Foundation
import AVFoundation

public enum NativeAudioImportError: Error, LocalizedError, Sendable {
    case invalidIdentifier
    case expiredOrMissing
    case invalidAudioFile
    case fileTooLarge
    case unsafePath
    case storageFailure(String)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier: return "Ungültige Audio-Import-ID."
        case .expiredOrMissing: return "Audio-Import ist abgelaufen oder nicht vorhanden."
        case .invalidAudioFile: return "Die ausgewählte Datei ist keine lesbare Audiodatei."
        case .fileTooLarge: return "Die Audiodatei überschreitet das Importlimit von 512 MB."
        case .unsafePath: return "Unsicherer Audio-Importpfad wurde abgewiesen."
        case .storageFailure(let detail): return "Audio-Import fehlgeschlagen: \(detail)"
        }
    }
}

/// Private, short-lived storage for files explicitly selected through the native document picker.
/// JavaScript receives only opaque UUIDs; it never supplies filesystem paths.
public final class NativeAudioImportStore: @unchecked Sendable {
    public static let defaultLifetime: TimeInterval = 15 * 60
    public static let maximumFileSize: UInt64 = 512 * 1024 * 1024
    private static let allowedExtensions: Set<String> = ["m4a", "wav", "mp3", "aiff", "aif", "caf", "flac"]

    private let lock = NSLock()
    private let fileManager: FileManager
    private let rootDirectory: URL
    private let lifetime: TimeInterval
    private let now: () -> Date
    private var expirations: [UUID: Date] = [:]

    public init(
        baseDirectory: URL? = nil,
        lifetime: TimeInterval = NativeAudioImportStore.defaultLifetime,
        fileManager: FileManager = .default,
        now: @escaping () -> Date = Date.init
    ) throws {
        self.fileManager = fileManager
        self.lifetime = max(1, lifetime)
        self.now = now

        var directoryAttributes: [FileAttributeKey: Any] = [:]
#if os(iOS)
        directoryAttributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
#endif
        let storageDirectory: URL
        if let baseDirectory {
            storageDirectory = baseDirectory
        } else {
            let sharedRoot = fileManager.temporaryDirectory
                .appendingPathComponent("ZEROAudioImports", isDirectory: true)
            try fileManager.createDirectory(
                at: sharedRoot,
                withIntermediateDirectories: true,
                attributes: directoryAttributes
            )

            // Each bridge instance gets an isolated lease directory. Starting a second
            // WKWebView must never erase an import that the first one is transcribing.
            let staleBefore = now().addingTimeInterval(-self.lifetime)
            let existingDirectories = (try? fileManager.contentsOfDirectory(
                at: sharedRoot,
                includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey]
            )) ?? []
            for candidate in existingDirectories {
                guard let values = try? candidate.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey]),
                      values.isDirectory == true,
                      let modifiedAt = values.contentModificationDate,
                      modifiedAt <= staleBefore else { continue }
                try? fileManager.removeItem(at: candidate)
            }
            storageDirectory = sharedRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        }

        self.rootDirectory = storageDirectory
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true,
            attributes: directoryAttributes
        )
    }

    public var directoryURL: URL { rootDirectory }

    @discardableResult
    public func importAudio(from sourceURL: URL) throws -> String {
        _ = cleanupExpired()
        let ext = sourceURL.pathExtension.lowercased()
        guard Self.allowedExtensions.contains(ext),
              let values = try? sourceURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true
        else { throw NativeAudioImportError.invalidAudioFile }

        let attributes = try fileManager.attributesOfItem(atPath: sourceURL.path)
        guard let size = attributes[.size] as? NSNumber else {
            throw NativeAudioImportError.invalidAudioFile
        }
        guard size.uint64Value > 0 else { throw NativeAudioImportError.invalidAudioFile }
        guard size.uint64Value <= Self.maximumFileSize else { throw NativeAudioImportError.fileTooLarge }

        let audioFile: AVAudioFile
        do {
            audioFile = try AVAudioFile(forReading: sourceURL)
        } catch {
            throw NativeAudioImportError.invalidAudioFile
        }
        guard audioFile.length > 0 else { throw NativeAudioImportError.invalidAudioFile }

        let id = UUID()
        let destination = rootDirectory.appendingPathComponent(id.uuidString).appendingPathExtension(ext)
        do {
            try fileManager.copyItem(at: sourceURL, to: destination)
            var fileAttributes: [FileAttributeKey: Any] = [:]
#if os(iOS)
            fileAttributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
#endif
            if !fileAttributes.isEmpty {
                try fileManager.setAttributes(fileAttributes, ofItemAtPath: destination.path)
            }
        } catch {
            try? fileManager.removeItem(at: destination)
            throw NativeAudioImportError.storageFailure(error.localizedDescription)
        }

        lock.lock()
        expirations[id] = now().addingTimeInterval(lifetime)
        lock.unlock()
        return id.uuidString.lowercased()
    }

    public func resolve(_ identifier: String) throws -> URL {
        guard let id = UUID(uuidString: identifier),
              id.uuidString.lowercased() == identifier.lowercased()
        else { throw NativeAudioImportError.invalidIdentifier }

        lock.lock()
        let expiry = expirations[id]
        if let expiry, expiry <= now() {
            expirations.removeValue(forKey: id)
        }
        lock.unlock()

        guard let expiry, expiry > now() else {
            removeFiles(for: id)
            throw NativeAudioImportError.expiredOrMissing
        }

        let matches = (try? fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]
        )) ?? []
        guard let url = matches.first(where: { $0.deletingPathExtension().lastPathComponent.lowercased() == id.uuidString.lowercased() }),
              url.deletingLastPathComponent().standardizedFileURL == rootDirectory.standardizedFileURL,
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true,
              fileManager.fileExists(atPath: url.path)
        else { throw NativeAudioImportError.unsafePath }
        return url
    }

    public func remove(_ identifier: String) {
        guard let id = UUID(uuidString: identifier) else { return }
        lock.lock()
        expirations.removeValue(forKey: id)
        lock.unlock()
        removeFiles(for: id)
    }

    @discardableResult
    public func cleanupExpired() -> Int {
        lock.lock()
        let expired = expirations.filter { $0.value <= now() }.map(\.key)
        for id in expired { expirations.removeValue(forKey: id) }
        lock.unlock()
        for id in expired { removeFiles(for: id) }
        return expired.count
    }

    private func removeFiles(for id: UUID) {
        let candidates = (try? fileManager.contentsOfDirectory(at: rootDirectory, includingPropertiesForKeys: nil)) ?? []
        for candidate in candidates where candidate.deletingPathExtension().lastPathComponent.lowercased() == id.uuidString.lowercased() {
            try? fileManager.removeItem(at: candidate)
        }
    }
}

#if canImport(FoundationModels)
import Foundation
import FoundationModels

@available(iOS 26.0, macOS 26.0, *)
public enum AppleFoundationModelError: Error, LocalizedError, Sendable {
    case modelUnavailable(String)
    case germanLocaleUnsupported
    case emptyPrompt

    public var errorDescription: String? {
        switch self {
        case .modelUnavailable(let reason):
            return "Apple Foundation Model ist nicht verfügbar: \(reason)"
        case .germanLocaleUnsupported:
            return "Das Apple On-Device-Modell unterstützt die deutsche Spracheinstellung derzeit nicht."
        case .emptyPrompt:
            return "Die ZERO-Anfrage ist leer."
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
public struct AppleFoundationModelDiagnostics: Codable, Sendable {
    public let modelId: String
    public let available: Bool
    public let germanSupported: Bool
    public let status: String
    public let runtime: String
    public let message: String
}

/// Zero-cost on-device text generation through Apple's system model.
/// No model weights, API key, network request, or paid provider are required.
/// Availability still depends on Apple Intelligence being enabled and ready on the device.
@available(iOS 26.0, macOS 26.0, *)
@MainActor
public final class AppleFoundationModelAdapter {
    public init() {}

    public func deploymentDiagnostics() -> AppleFoundationModelDiagnostics {
        let model = SystemLanguageModel.default
        let germanSupported = model.supportsLocale(Locale(identifier: "de-DE"))

        switch model.availability {
        case .available:
            return AppleFoundationModelDiagnostics(
                modelId: "apple-foundation-model",
                available: true,
                germanSupported: germanSupported,
                status: germanSupported ? "BEREIT" : "SPRACHE NICHT UNTERSTÜTZT",
                runtime: "Apple Foundation Models · On-Device · Apple Intelligence",
                message: germanSupported
                    ? "Apple On-Device-Modell ist verfügbar. Anfragen werden lokal auf dem iPhone verarbeitet."
                    : "Das Modell ist verfügbar, unterstützt die deutsche Locale aber nicht."
            )
        case .unavailable(let reason):
            return AppleFoundationModelDiagnostics(
                modelId: "apple-foundation-model",
                available: false,
                germanSupported: germanSupported,
                status: "NICHT VERFÜGBAR",
                runtime: "Apple Foundation Models · On-Device",
                message: String(describing: reason)
            )
        }
    }

    public func generate(prompt: String) async throws -> String {
        let cleanedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedPrompt.isEmpty else {
            throw AppleFoundationModelError.emptyPrompt
        }

        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            throw AppleFoundationModelError.modelUnavailable(
                String(describing: model.availability)
            )
        }
        guard model.supportsLocale(Locale(identifier: "de-DE")) else {
            throw AppleFoundationModelError.germanLocaleUnsupported
        }

        let instructions = """
        You are ZERO CORE, the private on-device assistant inside ZERO AI STUDIO.
        You MUST respond in German unless the user explicitly asks for another language.
        Be clear, useful, honest, and concise. Never claim internet access, external tools,
        or capabilities you do not actually have. If a task requires current information,
        explain that this local model has no automatic web access.
        """
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(to: cleanedPrompt)
        return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
#endif

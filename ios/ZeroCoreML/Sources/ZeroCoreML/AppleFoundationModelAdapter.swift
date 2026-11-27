#if canImport(FoundationModels)
import Foundation
import FoundationModels

@available(iOS 26.0, macOS 26.0, *)
public enum AppleFoundationModelError: Error, LocalizedError, Sendable {
    case modelUnavailable(String)
    case germanLocaleUnsupported
    case emptyPrompt
    case emptyResponse

    public var errorDescription: String? {
        switch self {
        case .modelUnavailable(let reason):
            return "Apple Foundation Model ist nicht verfügbar: \(reason)"
        case .germanLocaleUnsupported:
            return "Das Apple On-Device-Modell unterstützt die deutsche Spracheinstellung derzeit nicht."
        case .emptyPrompt:
            return "Die ZERO-Anfrage ist leer."
        case .emptyResponse:
            return "Apple Foundation Models hat eine leere Antwort geliefert."
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
public struct AppleFoundationModelDiagnostics: Codable, Sendable {
    public let modelId: String
    /// True only when the OS reports the model as ready for inference.
    public let available: Bool
    /// True only when the model is ready and supports ZERO's default German locale.
    public let readyForGerman: Bool
    public let germanSupported: Bool
    public let availabilityReason: String?
    public let contextSize: Int
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
            let readyForGerman = germanSupported
            return AppleFoundationModelDiagnostics(
                modelId: "apple-foundation-model",
                available: true,
                readyForGerman: readyForGerman,
                germanSupported: germanSupported,
                availabilityReason: nil,
                contextSize: model.contextSize,
                status: readyForGerman ? "BEREIT" : "SPRACHE NICHT UNTERSTÜTZT",
                runtime: "Apple Foundation Models · On-Device · Apple Intelligence",
                message: readyForGerman
                    ? "Apple On-Device-Modell ist verfügbar und unterstützt Deutsch. Anfragen werden lokal verarbeitet."
                    : "Das Apple-Modell ist geladen, unterstützt die deutsche Locale aber nicht. Es wird keine Inferenz gestartet."
            )
        case .unavailable(let reason):
            let details: (status: String, message: String)
            switch reason {
            case .deviceNotEligible:
                details = (
                    "GERÄT NICHT BERECHTIGT",
                    "Dieses Gerät unterstützt Apple Intelligence nicht. ZERO meldet das Modell nicht als verfügbar."
                )
            case .appleIntelligenceNotEnabled:
                details = (
                    "APPLE INTELLIGENCE DEAKTIVIERT",
                    "Apple Intelligence ist in den iOS-Einstellungen nicht aktiviert."
                )
            case .modelNotReady:
                details = (
                    "MODELL WIRD VORBEREITET",
                    "Das Apple-Modell wird geladen oder aktualisiert. Bitte später erneut prüfen."
                )
            @unknown default:
                details = (
                    "NICHT VERFÜGBAR",
                    "Apple Foundation Models meldet einen nicht unterstützten Verfügbarkeitszustand."
                )
            }
            return AppleFoundationModelDiagnostics(
                modelId: "apple-foundation-model",
                available: false,
                readyForGerman: false,
                germanSupported: germanSupported,
                availabilityReason: String(describing: reason),
                contextSize: model.contextSize,
                status: details.status,
                runtime: "Apple Foundation Models · On-Device",
                message: details.message
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
        let content = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else {
            throw AppleFoundationModelError.emptyResponse
        }
        return content
    }
}
#endif

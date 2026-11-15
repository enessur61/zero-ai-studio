import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Native, on-device Apple Intelligence language model.
/// This uses Apple's system model; it does not call a cloud API or require an API key.
@available(iOS 26.0, macOS 26.0, *)
public enum ZeroAppleFoundationModel {
    public static let modelId = "apple-foundation-model"

    public static func availabilityDescription() -> (available: Bool, status: String) {
        #if canImport(FoundationModels)
        switch SystemLanguageModel.default.availability {
        case .available:
            return (true, "VERFÜGBAR · Apple Foundation Models")
        case .unavailable(let reason):
            return (false, "NICHT VERFÜGBAR · \(String(describing: reason))")
        }
        #else
        return (false, "FoundationModels Framework ist in diesem SDK nicht verfügbar.")
        #endif
    }

    public static func generate(prompt: String) async throws -> String {
        #if canImport(FoundationModels)
        let availability = availabilityDescription()
        guard availability.available else {
            throw NSError(
                domain: "ZERO.FoundationModels",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: availability.status]
            )
        }

        let session = LanguageModelSession(instructions: """
        Du bist ZERO CORE, ein hilfreicher, präziser KI-Assistent.
        Antworte standardmäßig auf Deutsch. Erfinde keine Fakten und sage offen,
        wenn eine Aufgabe die Fähigkeiten des lokalen Modells übersteigt.
        """)
        let response = try await session.respond(to: prompt)
        return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        #else
        throw NSError(
            domain: "ZERO.FoundationModels",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "FoundationModels Framework ist nicht in diesem SDK enthalten."]
        )
        #endif
    }
}

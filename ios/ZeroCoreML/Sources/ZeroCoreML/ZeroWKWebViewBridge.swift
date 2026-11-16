import Foundation
import WebKit

/// Vereinheitlichte WKWebView JS-zu-Native-iOS Bridge für ZERO AI STUDIO auf iPhone 16 Pro Max.
/// Unterstützt alle 8 lokalen On-Device iOS-Modelle:
/// - llama-3.2-1b-coreml & llama-3.2-3b-coreml (CoreML MLState)
/// - qwen-2.5-3b-coreml & deepseek-r1-distill-1.5b (Apple MLX Swift)
/// - gemma-3-4b-it (MediaPipe Tasks GenAI)
/// - whisper-cpp-small (whisper.cpp Metal/CoreML)
/// - piper-tts-de (ONNX Runtime DE)
/// - kokoro-82m (CoreML/MLX Audio)
///
/// Registrierung im App-ViewController:
/// webView.configuration.userContentController.add(ZeroWKWebViewBridge(webView: webView), name: "zeroCoreML")
@MainActor
public final class ZeroWKWebViewBridge: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let trustedHost: String
    private var llamaAdapters: [Llama32Variant: LlamaCoreMLAdapter] = [:]
    private var mlxAdapters: [MLXTextVariant: MLXSwiftTextAdapter] = [:]
    private lazy var gemmaAdapter = MediaPipeGemmaAdapter()
    private lazy var whisperAdapter = WhisperMetalAdapter()
    private lazy var piperAdapter = PiperONNXAdapter()
    private lazy var kokoroAdapter = KokoroMLXAudioAdapter()

    public init(webView: WKWebView, trustedHost: String) {
        self.webView = webView
        self.trustedHost = trustedHost
        super.init()
    }

    public func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // The native bridge is exposed only to the trusted ZERO web app's main frame.
        // Never allow an embedded or foreign origin to invoke on-device model capabilities.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "https",
              !trustedHost.isEmpty,
              message.frameInfo.securityOrigin.host == trustedHost,
              let body = message.body as? [String: Any],
              let requestId = body["requestId"] as? String,
              !requestId.isEmpty,
              let action = body["action"] as? String
        else { return }

        let modelId = (body["modelId"] as? String) ?? Llama32Variant.instruct3B.rawValue

        switch action {
        case "diagnostics":
            handleDiagnostics(requestId: requestId, modelId: modelId)

        case "generate":
            let prompt = (body["prompt"] as? String) ?? ""
            handleGenerate(requestId: requestId, modelId: modelId, prompt: prompt)

        case "synthesize":
            let text = (body["text"] as? String) ?? ""
            let voice = (body["voiceName"] as? String) ?? "af_heart"
            handleSynthesize(requestId: requestId, modelId: modelId, text: text, voice: voice)

        case "transcribe":
            let audioPath = (body["audioPath"] as? String) ?? ""
            let language = (body["language"] as? String) ?? "de"
            handleTranscribe(requestId: requestId, audioPath: audioPath, language: language)

        default:
            emitToJS(requestId: requestId, payload: [
                "ok": false,
                "error": "Unbekannte iOS-Bridge-Aktion: \(action)"
            ])
        }
    }

    private func handleDiagnostics(requestId: String, modelId: String) {
        if modelId == "apple-foundation-model" {
#if canImport(FoundationModels)
            if #available(iOS 26.0, macOS 26.0, *) {
                let diagnostics = AppleFoundationModelAdapter().deploymentDiagnostics()
                emitToJS(requestId: requestId, payload: [
                    "ok": true,
                    "modelId": diagnostics.modelId,
                    "status": diagnostics.status,
                    "runtime": diagnostics.runtime,
                    "available": diagnostics.available,
                    "germanSupported": diagnostics.germanSupported,
                    "message": diagnostics.message
                ])
            } else {
                emitToJS(requestId: requestId, payload: [
                    "ok": false,
                    "modelId": modelId,
                    "status": "iOS 26 oder neuer erforderlich",
                    "available": false,
                    "germanSupported": false,
                    "error": "Apple Foundation Models benötigt iOS 26 oder neuer."
                ])
            }
#else
            emitToJS(requestId: requestId, payload: [
                "ok": false,
                "modelId": modelId,
                "status": "FoundationModels nicht verfügbar",
                "available": false,
                "germanSupported": false,
                "error": "FoundationModels.framework ist in diesem SDK nicht verfügbar."
            ])
#endif
        } else if let llamaVariant = Llama32Variant(rawValue: modelId) {
            let adapter = llamaAdapters[llamaVariant] ?? LlamaCoreMLAdapter(config: LlamaCoreMLConfig(variant: llamaVariant))
            llamaAdapters[llamaVariant] = adapter
            let d = adapter.deploymentDiagnostics()
            emitToJS(requestId: requestId, payload: [
                "ok": true,
                "modelId": d.modelId,
                "status": d.status,
                "runtime": d.runtime,
                "deviceModel": d.deviceModel,
                "compiledModelPresent": d.compiledModelPresent,
                "estimatedRamGB": d.estimatedRamGB
            ])
        } else if let mlxVariant = MLXTextVariant(rawValue: modelId) {
            let adapter = mlxAdapters[mlxVariant] ?? MLXSwiftTextAdapter(variant: mlxVariant)
            mlxAdapters[mlxVariant] = adapter
            let d = adapter.deploymentDiagnostics()
            emitToJS(requestId: requestId, payload: [
                "ok": true,
                "modelId": d.modelId,
                "status": d.status,
                "runtime": d.runtime,
                "deviceModel": d.deviceModel,
                "compiledModelPresent": d.weightsPresent,
                "estimatedRamGB": d.estimatedRamGB
            ])
        } else if modelId == "gemma-3-4b-it" {
            let d = gemmaAdapter.deploymentDiagnostics()
            emitToJS(requestId: requestId, payload: [
                "ok": true,
                "modelId": d.modelId,
                "status": d.status,
                "runtime": d.runtime,
                "deviceModel": d.deviceModel,
                "compiledModelPresent": d.taskBundlePresent,
                "estimatedRamGB": d.estimatedRamGB
            ])
        } else if modelId == "whisper-cpp-small" {
            let d = whisperAdapter.deploymentDiagnostics()
            emitToJS(requestId: requestId, payload: [
                "ok": true,
                "modelId": d.modelId,
                "status": d.status,
                "runtime": d.runtime,
                "deviceModel": d.deviceModel,
                "compiledModelPresent": d.weightsPresent,
                "estimatedRamGB": d.estimatedRamGB
            ])
        } else if modelId == "piper-tts-de" {
            let d = piperAdapter.deploymentDiagnostics()
            emitToJS(requestId: requestId, payload: [
                "ok": true,
                "modelId": d.modelId,
                "status": d.status,
                "runtime": d.runtime,
                "deviceModel": d.deviceModel,
                "compiledModelPresent": d.voicePresent,
                "estimatedRamGB": d.estimatedRamGB
            ])
        } else if modelId == "kokoro-82m" {
            let d = kokoroAdapter.deploymentDiagnostics()
            emitToJS(requestId: requestId, payload: [
                "ok": true,
                "modelId": d.modelId,
                "status": d.status,
                "runtime": d.runtime,
                "deviceModel": d.deviceModel,
                "compiledModelPresent": d.modelPresent,
                "estimatedRamGB": d.estimatedRamGB
            ])
        } else {
            emitToJS(requestId: requestId, payload: [
                "ok": false,
                "error": "Unbekanntes lokales iOS-Modell: \(modelId)"
            ])
        }
    }

    private func handleGenerate(requestId: String, modelId: String, prompt: String) {
        if modelId == "apple-foundation-model" {
#if canImport(FoundationModels)
            if #available(iOS 26.0, macOS 26.0, *) {
                let adapter = AppleFoundationModelAdapter()
                Task {
                    do {
                        let result = try await adapter.generate(prompt: prompt)
                        self.emitToJS(requestId: requestId, payload: [
                            "ok": true,
                            "type": "done",
                            "text": result,
                            "modelId": modelId,
                            "runtime": "Apple Foundation Models · On-Device",
                            "costEur": 0,
                            "execution": "on-device"
                        ])
                    } catch {
                        self.emitToJS(requestId: requestId, payload: [
                            "ok": false,
                            "type": "error",
                            "error": error.localizedDescription
                        ])
                    }
                }
            } else {
                emitToJS(requestId: requestId, payload: [
                    "ok": false,
                    "type": "error",
                    "error": "Apple Foundation Models benötigt iOS 26 oder neuer."
                ])
            }
#else
            emitToJS(requestId: requestId, payload: [
                "ok": false,
                "type": "error",
                "error": "FoundationModels.framework ist in diesem SDK nicht verfügbar."
            ])
#endif
        } else if let llamaVariant = Llama32Variant(rawValue: modelId) {
            let adapter = llamaAdapters[llamaVariant] ?? LlamaCoreMLAdapter(config: LlamaCoreMLConfig(variant: llamaVariant))
            llamaAdapters[llamaVariant] = adapter
            Task {
                do {
                    let result = try await adapter.generate(prompt: prompt) { [weak self] token in
                        Task { @MainActor in
                            self?.emitToJS(requestId: requestId, payload: ["type": "token", "token": token])
                        }
                    }
                    self.emitToJS(requestId: requestId, payload: [
                        "ok": true, "type": "done", "text": result, "modelId": modelId, "costEur": 0
                    ])
                } catch {
                    self.emitToJS(requestId: requestId, payload: [
                        "ok": false, "type": "error", "error": error.localizedDescription
                    ])
                }
            }
        } else if let mlxVariant = MLXTextVariant(rawValue: modelId) {
            let adapter = mlxAdapters[mlxVariant] ?? MLXSwiftTextAdapter(variant: mlxVariant)
            mlxAdapters[mlxVariant] = adapter
            Task {
                do {
                    let result = try await adapter.generate(prompt: prompt) { [weak self] token in
                        Task { @MainActor in
                            self?.emitToJS(requestId: requestId, payload: ["type": "token", "token": token])
                        }
                    }
                    self.emitToJS(requestId: requestId, payload: [
                        "ok": true, "type": "done", "text": result, "modelId": modelId, "costEur": 0
                    ])
                } catch {
                    self.emitToJS(requestId: requestId, payload: [
                        "ok": false, "type": "error", "error": error.localizedDescription
                    ])
                }
            }
        } else if modelId == "gemma-3-4b-it" {
            Task {
                do {
                    let result = try await gemmaAdapter.generate(prompt: prompt) { [weak self] token in
                        Task { @MainActor in
                            self?.emitToJS(requestId: requestId, payload: ["type": "token", "token": token])
                        }
                    }
                    self.emitToJS(requestId: requestId, payload: [
                        "ok": true, "type": "done", "text": result, "modelId": modelId, "costEur": 0
                    ])
                } catch {
                    self.emitToJS(requestId: requestId, payload: [
                        "ok": false, "type": "error", "error": error.localizedDescription
                    ])
                }
            }
        } else {
            emitToJS(requestId: requestId, payload: [
                "ok": false,
                "type": "error",
                "error": "Text-Generierung wird für Modell '\(modelId)' nicht unterstützt."
            ])
        }
    }

    private func handleSynthesize(requestId: String, modelId: String, text: String, voice: String) {
        Task {
            do {
                let wavData: Data
                if modelId == "kokoro-82m" {
                    wavData = try await kokoroAdapter.synthesizeWAV(text: text, voiceName: voice)
                } else {
                    wavData = try await piperAdapter.synthesizeWAV(text: text)
                }
                let b64 = wavData.base64EncodedString()
                self.emitToJS(requestId: requestId, payload: [
                    "ok": true,
                    "type": "done",
                    "audioDataUrl": "data:audio/wav;base64,\(b64)",
                    "modelId": modelId,
                    "costEur": 0
                ])
            } catch {
                self.emitToJS(requestId: requestId, payload: [
                    "ok": false, "type": "error", "error": error.localizedDescription
                ])
            }
        }
    }

    private func handleTranscribe(requestId: String, audioPath: String, language: String) {
        let url = URL(fileURLWithPath: audioPath)
        Task {
            do {
                let res = try await whisperAdapter.transcribe(audioURL: url, languageCode: language)
                self.emitToJS(requestId: requestId, payload: [
                    "ok": true,
                    "type": "done",
                    "text": res.text,
                    "srt": res.srt,
                    "modelId": "whisper-cpp-small",
                    "costEur": 0
                ])
            } catch {
                self.emitToJS(requestId: requestId, payload: [
                    "ok": false, "type": "error", "error": error.localizedDescription
                ])
            }
        }
    }

    private func emitToJS(requestId: String, payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.__zeroCoreMLReceive && window.__zeroCoreMLReceive(\"\(requestId)\", \(json));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}

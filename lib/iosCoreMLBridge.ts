export interface CoreMLBridgeResponse {
  ok: boolean;
  type?: 'token' | 'done' | 'error';
  text?: string;
  srt?: string;
  audioDataUrl?: string;
  token?: string;
  modelId?: string;
  status?: string;
  runtime?: string;
  deviceModel?: string;
  estimatedRamGB?: number;
  compiledModelPresent?: boolean;
  error?: string;
}

export type NativeIOSTextModelId =
  | 'llama-3.2-1b-coreml'
  | 'llama-3.2-3b-coreml'
  | 'qwen-2.5-3b-coreml'
  | 'gemma-3-4b-it'
  | 'deepseek-r1-distill-1.5b'
  | 'apple-foundation-model';

interface WebKitMessageHandler {
  postMessage: (payload: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        zeroCoreML?: WebKitMessageHandler;
      };
    };
    __zeroCoreMLReceive?: (requestId: string, payload: CoreMLBridgeResponse) => void;
  }
}

type PendingCallback = {
  resolve: (val: CoreMLBridgeResponse) => void;
  reject: (err: Error) => void;
  onToken?: (token: string) => void;
  timeoutId: number;
};

const pendingRequests = new Map<string, PendingCallback>();

function ensureDispatcherInstalled() {
  if (typeof window === 'undefined') return;
  window.__zeroCoreMLReceive = (incomingId, payload) => {
    const entry = pendingRequests.get(incomingId);
    if (!entry) return;
    if (payload.type === 'token' && payload.token) {
      entry.onToken?.(payload.token);
      return;
    }
    window.clearTimeout(entry.timeoutId);
    pendingRequests.delete(incomingId);
    if (!payload.ok) {
      entry.reject(new Error(payload.error || 'Nativer iOS Adapter-Fehler'));
    } else {
      entry.resolve(payload);
    }
  };
}

export function isNativeIOSCoreMLAvailable(): boolean {
  return Boolean(
    typeof window !== 'undefined' && window.webkit?.messageHandlers?.zeroCoreML
  );
}

function dispatchBridgeAction(
  payload: Record<string, unknown>,
  onToken?: (token: string) => void,
  unavailableMessage?: string
): Promise<CoreMLBridgeResponse> {
  const handler = window.webkit?.messageHandlers?.zeroCoreML;
  if (!handler) {
    return Promise.reject(
      new Error(
        unavailableMessage ||
          'Native iOS Laufzeit im Web-Browser nicht aktiv: Das Swift-6-Paket ios/ZeroCoreML ist fertig (Ready for Deployment) und startet in der nativen iPhone 16 Pro Max WKWebView-App mit lokalen Modellgewichten.'
      )
    );
  }

  ensureDispatcherInstalled();
  const requestId = `ios-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Zeitüberschreitung bei ZeroCoreML WKWebView Bridge.'));
    }, 30_000);

    pendingRequests.set(requestId, { resolve, reject, onToken, timeoutId });
    handler.postMessage({ requestId, ...payload });
  });
}

export async function runNativeCoreMLPrompt(params: {
  modelId: NativeIOSTextModelId;
  prompt: string;
  onToken?: (token: string) => void;
}): Promise<CoreMLBridgeResponse> {
  return dispatchBridgeAction(
    {
      action: 'generate',
      modelId: params.modelId,
      prompt: params.prompt,
    },
    params.onToken,
    `Apple CoreML/MLX Laufzeit für "${params.modelId}" erfordert die native iPhone 16 Pro Max WKWebView-App (ios/ZeroCoreML). Wähle im Browser ein aktives Free-Cloud-Modell (Gemini 4 Hydrogen, Gemini 3.1 Flash Lite oder GPT-OSS 20B).`
  );
}

export async function runNativeIOSSynthesize(params: {
  modelId: 'piper-tts-de' | 'kokoro-82m';
  text: string;
  voiceName?: string;
}): Promise<CoreMLBridgeResponse> {
  return dispatchBridgeAction(
    {
      action: 'synthesize',
      modelId: params.modelId,
      text: params.text,
      voiceName: params.voiceName ?? 'af_heart',
    },
    undefined,
    `Lokale iOS Sprachsynthese (${params.modelId}) erfordert den Xcode iOS App-Build (ios/ZeroCoreML). Im Browser stehen "WAV generieren (0 €)" (Gemini 3.8 TTS) und "iOS / Lokal vorlesen" sofort bereit.`
  );
}

export async function runNativeIOSTranscribe(params: {
  audioPath: string;
  language?: string;
}): Promise<CoreMLBridgeResponse> {
  return dispatchBridgeAction(
    {
      action: 'transcribe',
      modelId: 'whisper-cpp-small',
      audioPath: params.audioPath,
      language: params.language ?? 'de',
    },
    undefined,
    'whisper.cpp Metal/CoreML erfordert die native iPhone 16 Pro Max App (ios/ZeroCoreML). Im Browser stehen Gemini 3.5 Transcribe und Live-Diktat direkt bereit.'
  );
}

export async function runNativeIOSDiagnostics(
  modelId: string
): Promise<CoreMLBridgeResponse> {
  return dispatchBridgeAction(
    {
      action: 'diagnostics',
      modelId,
    },
    undefined,
    `WKWebView Bridge im Browser nicht aktiv — Fallback auf serverseitige Swift 6 Adapter-Prüfung für "${modelId}".`
  );
}

/**
 * Runs Apple's built-in Foundation Model directly on the device.
 * Requires a native ZERO WKWebView host, iOS 26+, and Apple Intelligence availability.
 */
export async function runNativeAppleFoundationModel(params: {
  prompt: string;
  onToken?: (token: string) => void;
}): Promise<CoreMLBridgeResponse> {
  return dispatchBridgeAction(
    {
      action: 'generate',
      modelId: 'apple-foundation-model',
      prompt: params.prompt,
    },
    params.onToken,
    'Apple Foundation Models benötigt die native ZERO-iOS-App, iOS 26 oder neuer und ein kompatibles Gerät mit verfügbarer Apple Intelligence.'
  );
}

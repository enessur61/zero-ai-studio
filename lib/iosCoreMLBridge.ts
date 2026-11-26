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
  available?: boolean;
  readyForGerman?: boolean;
  germanSupported?: boolean;
  availabilityReason?: string | null;
  contextSize?: number;
  message?: string;
  error?: string;
  importId?: string;
  expiresInSeconds?: number;
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
  unavailableMessage?: string,
  timeoutMs = 30_000
): Promise<CoreMLBridgeResponse> {
  const handler = window.webkit?.messageHandlers?.zeroCoreML;
  if (!handler) {
    return Promise.reject(
      new Error(
        unavailableMessage ||
          'Native iOS Laufzeit im Web-Browser nicht aktiv. Für lokale CoreML-/MLX-Inferenz wird die signierte ZERO-iOS-App mit installierten Modellgewichten benötigt.'
      )
    );
  }

  ensureDispatcherInstalled();
  const requestId = `ios-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Zeitüberschreitung bei ZeroCoreML WKWebView Bridge.'));
    }, timeoutMs);

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
    `Lokale iOS-Laufzeit für "${params.modelId}" erfordert die native ZERO WKWebView-App (ios/ZeroCoreML). Apple Foundation Models benötigt zusätzlich iOS 26+, aktivierte Apple Intelligence und ein bereitgestelltes deutsches On-Device-Modell.`,
    180_000
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
    `Lokale iOS Sprachsynthese (${params.modelId}) erfordert die native ZERO-iOS-App sowie installierte Sprachmodellgewichte.`
  );
}

export async function pickNativeIOSAudio(): Promise<CoreMLBridgeResponse> {
  return dispatchBridgeAction(
    { action: 'pickAudio' },
    undefined,
    'Der native Audio-Dateiimport erfordert die ZERO-iOS-App mit UIDocumentPicker.'
  );
}

export async function runNativeIOSTranscribe(params: {
  importId: string;
  language?: string;
}): Promise<CoreMLBridgeResponse> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.importId)) {
    return Promise.reject(new Error('Ungültige native Audio-Import-ID.'));
  }
  return dispatchBridgeAction(
    {
      action: 'transcribe',
      modelId: 'whisper-cpp-small',
      importId: params.importId,
      language: params.language ?? 'de',
    },
    undefined,
    'whisper.cpp Metal/CoreML erfordert die native ZERO-iOS-App sowie installierte Whisper-Modellgewichte.'
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

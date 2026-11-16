import type { MLCEngineInterface } from '@mlc-ai/web-llm';

export const WEBGPU_LOCAL_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
export const WEBGPU_LOCAL_MODEL_DOWNLOAD_MB = 705;
export const WEBGPU_LOCAL_MODEL_VRAM_MB = 879;

export const WEBGPU_LOCAL_MODELS = [
  // IDs are copied from the installed WebLLM prebuilt registry, not guessed.
  { id: 'webgpu-llama-3.2-1b', modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', name: 'Llama 3.2 1B', downloadMB: 705, vramMB: 879, requiresShaderF16: false },
  { id: 'smollm2-360m-webgpu', modelId: 'SmolLM2-360M-Instruct-q4f32_1-MLC', name: 'SmolLM2 360M · Fallback', vramMB: 580, requiresShaderF16: false },
] as const;

export type WebGPULocalModelId = typeof WEBGPU_LOCAL_MODELS[number]['modelId'];

export interface WebGPULocalModelProgress {
  progress: number;
  text: string;
}

export interface WebGPULocalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type NavigatorWithGPU = Navigator & {
  gpu?: {
    requestAdapter: () => Promise<{
      limits?: {
        maxStorageBufferBindingSize?: number;
      };
      features?: { has: (feature: string) => boolean };
    } | null>;
  };
};

let engine: MLCEngineInterface | null = null;
let enginePromise: Promise<MLCEngineInterface> | null = null;
let modelWorker: Worker | null = null;
let loadedModelId: string | null = null;

export async function checkWebGPULocalModelSupport(): Promise<{
  supported: boolean;
  maxStorageBufferBindingSize: number | null;
  message: string;
}> {
  const gpu = (navigator as NavigatorWithGPU).gpu;
  if (!gpu) {
    return {
      supported: false,
      maxStorageBufferBindingSize: null,
      message: 'WebGPU wird von diesem Browser nicht angeboten. Bitte Safari 26 oder neuer verwenden.',
    };
  }

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        maxStorageBufferBindingSize: null,
        message: 'Der Browser bietet keinen verfügbaren GPU-Adapter an. Lade ZERO neu und prüfe den Energiesparmodus.',
      };
    }
    const maxStorageBufferBindingSize = adapter.limits?.maxStorageBufferBindingSize ?? null;
    return {
      supported: true,
      maxStorageBufferBindingSize,
      message: 'WebGPU-GPU-Adapter erkannt. Das lokale Modell kann geladen werden.',
    };
  } catch {
    return {
      supported: false,
      maxStorageBufferBindingSize: null,
      message: 'Der WebGPU-Adapter konnte nicht initialisiert werden.',
    };
  }
}

export async function loadWebGPULocalModel(
  onProgress?: (progress: WebGPULocalModelProgress) => void,
  requestedModelId: WebGPULocalModelId = WEBGPU_LOCAL_MODEL_ID
): Promise<void> {
  const preset = WEBGPU_LOCAL_MODELS.find((item) => item.modelId === requestedModelId);
  if (!preset) throw new Error(`Nicht unterstütztes lokales Modell: ${requestedModelId}`);
  if (engine && loadedModelId === requestedModelId) return;
  if (engine || enginePromise) await unloadWebGPULocalModel();

  const support = await checkWebGPULocalModelSupport();
  if (!support.supported) throw new Error(support.message);

  if (!enginePromise) {
    enginePromise = (async () => {
      const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('@mlc-ai/web-llm');
      const modelRecord = prebuiltAppConfig.model_list.find((item) => item.model_id === requestedModelId);
      if (!modelRecord) {
        throw new Error(`Das Modell ${requestedModelId} ist in der installierten WebLLM-Version nicht enthalten.`);
      }
      if (preset.requiresShaderF16) {
        const adapter = await (navigator as NavigatorWithGPU).gpu?.requestAdapter();
        if (!adapter?.features?.has('shader-f16')) {
          throw new Error('Dieses Modell benötigt WebGPU shader-f16, das dieser Browser/GPU nicht bereitstellt.');
        }
      }
      modelWorker = new Worker(new URL('./webllmWorker.ts', import.meta.url), {
        type: 'module',
      });
      return CreateWebWorkerMLCEngine(modelWorker, requestedModelId, {
        initProgressCallback: (report: { progress: number; text: string }) => {
          onProgress?.({
            progress: Math.max(0, Math.min(1, report.progress)),
            text: report.text,
          });
        },
      });
    })();
  }

  try {
    engine = await enginePromise;
    loadedModelId = requestedModelId;
  } catch (error) {
    modelWorker?.terminate();
    modelWorker = null;
    enginePromise = null;
    throw new Error(
      error instanceof Error
        ? `Das lokale Modell konnte nicht geladen werden: ${error.message}`
        : 'Das lokale Modell konnte nicht geladen werden.'
    );
  }
}

export function isWebGPULocalModelLoaded(): boolean {
  return engine !== null;
}

export function getLoadedWebGPULocalModelId(): WebGPULocalModelId | null {
  return loadedModelId as WebGPULocalModelId | null;
}

export async function generateWebGPULocalChat(
  messages: WebGPULocalChatMessage[],
  onToken?: (token: string) => void
): Promise<string> {
  if (!engine) {
    throw new Error('Das lokale WebGPU-Modell ist noch nicht geladen.');
  }

  const stream = (await engine.chat.completions.create({
    messages,
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 512,
    stream: true,
  })) as AsyncIterable<{
    choices?: Array<{ delta?: { content?: string } }>;
  }>;

  let answer = '';
  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (typeof token === 'string' && token.length > 0) {
      answer += token;
      onToken?.(token);
    }
  }

  return answer.trim();
}

export async function unloadWebGPULocalModel(): Promise<void> {
  const activeEngine = engine;
  engine = null;
  enginePromise = null;
  loadedModelId = null;

  try {
    await activeEngine?.unload();
  } finally {
    modelWorker?.terminate();
    modelWorker = null;
  }
}

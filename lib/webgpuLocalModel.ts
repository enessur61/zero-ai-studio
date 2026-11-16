import type { MLCEngineInterface } from '@mlc-ai/web-llm';

export const WEBGPU_LOCAL_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
export const WEBGPU_LOCAL_MODEL_DOWNLOAD_MB = 705;
export const WEBGPU_LOCAL_MODEL_VRAM_MB = 879;

// Estimates are admission-control hints, not measurements of free device memory.
export const WEBGPU_LOCAL_MEMORY_BUDGET_MB = 1600;

export const WEBGPU_LOCAL_MODELS = [
  { id: 'webgpu-llama-3.2-1b', modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', name: 'Llama 3.2 1B', downloadMB: 705, vramMB: 879, requiresShaderF16: false },
  { id: 'smollm2-360m-webgpu', modelId: 'SmolLM2-360M-Instruct-q4f32_1-MLC', name: 'SmolLM2 360M · Fallback', downloadMB: 230, vramMB: 580, requiresShaderF16: false },
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
      limits?: { maxStorageBufferBindingSize?: number };
      features?: { has: (feature: string) => boolean };
    } | null>;
  };
};

let engine: MLCEngineInterface | null = null;
let modelWorker: Worker | null = null;
let loadedModelId: WebGPULocalModelId | null = null;
const loadedModelIds = new Set<WebGPULocalModelId>();
let operationQueue: Promise<void> = Promise.resolve();

export function getLoadedWebGPULocalModelIds(): WebGPULocalModelId[] {
  return [...loadedModelIds];
}

export function getWebGPULocalMemoryUsageMB(): number {
  return WEBGPU_LOCAL_MODELS.reduce(
    (total, preset) => total + (loadedModelIds.has(preset.modelId) ? preset.vramMB : 0),
    0
  );
}

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

async function loadModelInternal(
  onProgress: ((progress: WebGPULocalModelProgress) => void) | undefined,
  requestedModelId: WebGPULocalModelId
): Promise<void> {
  const preset = WEBGPU_LOCAL_MODELS.find((item) => item.modelId === requestedModelId);
  if (!preset) throw new Error(`Nicht unterstütztes lokales Modell: ${requestedModelId}`);
  if (loadedModelIds.has(requestedModelId) && engine) {
    loadedModelId = requestedModelId;
    return;
  }

  const projectedUsage = getWebGPULocalMemoryUsageMB() + preset.vramMB;
  if (projectedUsage > WEBGPU_LOCAL_MEMORY_BUDGET_MB) {
    throw new Error(
      `ZERO schützt den GPU-Speicher: ${preset.name} benötigt geschätzt ${projectedUsage} MB zusammen mit den geladenen Modellen; Budget ${WEBGPU_LOCAL_MEMORY_BUDGET_MB} MB. Bitte zuerst ein anderes Modell gezielt entladen.`
    );
  }

  const support = await checkWebGPULocalModelSupport();
  if (!support.supported) throw new Error(support.message);

  if (preset.requiresShaderF16) {
    const adapter = await (navigator as NavigatorWithGPU).gpu?.requestAdapter();
    if (!adapter?.features?.has('shader-f16')) {
      throw new Error('Dieses Modell benötigt WebGPU shader-f16, das dieser Browser/GPU nicht bereitstellt.');
    }
  }

  const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('@mlc-ai/web-llm');
  const modelRecord = prebuiltAppConfig.model_list.find((item) => item.model_id === requestedModelId);
  if (!modelRecord) {
    throw new Error(`Das Modell ${requestedModelId} ist in der installierten WebLLM-Version nicht enthalten.`);
  }

  const progress = (report: { progress: number; text: string }) => {
    onProgress?.({
      progress: Math.max(0, Math.min(1, report.progress)),
      text: report.text,
    });
  };

  if (!engine) {
    modelWorker = new Worker(new URL('./webllmWorker.ts', import.meta.url), { type: 'module' });
    try {
      engine = await CreateWebWorkerMLCEngine(modelWorker, requestedModelId, {
        initProgressCallback: progress,
      });
      loadedModelIds.add(requestedModelId);
      loadedModelId = requestedModelId;
    } catch (error) {
      modelWorker?.terminate();
      modelWorker = null;
      engine = null;
      throw error;
    }
    return;
  }

  // WebLLM supports multiple model IDs in one engine. Its artifact cache also
  // avoids downloading weights again when a model has already been cached.
  await engine.reload([...loadedModelIds, requestedModelId], {
    initProgressCallback: progress,
  });
  loadedModelIds.add(requestedModelId);
  loadedModelId = requestedModelId;
}

export function loadWebGPULocalModel(
  onProgress?: (progress: WebGPULocalModelProgress) => void,
  requestedModelId: WebGPULocalModelId = WEBGPU_LOCAL_MODEL_ID
): Promise<void> {
  const task = operationQueue.then(() => loadModelInternal(onProgress, requestedModelId));
  operationQueue = task.catch(() => undefined);
  return task;
}

export function isWebGPULocalModelLoaded(modelId?: WebGPULocalModelId): boolean {
  return modelId ? loadedModelIds.has(modelId) : loadedModelIds.size > 0;
}

export function getLoadedWebGPULocalModelId(): WebGPULocalModelId | null {
  return loadedModelId;
}

export async function generateWebGPULocalChat(
  messages: WebGPULocalChatMessage[],
  onToken?: (token: string) => void,
  requestedModelId?: WebGPULocalModelId
): Promise<string> {
  if (!engine || loadedModelIds.size === 0) {
    throw new Error('Es ist noch kein lokales WebGPU-Modell geladen.');
  }
  const modelId = requestedModelId ?? loadedModelId;
  if (!modelId || !loadedModelIds.has(modelId)) {
    throw new Error('Das angeforderte lokale Modell ist nicht im GPU-Speicher geladen.');
  }

  const stream = (await engine.chat.completions.create({
    model: modelId,
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

export async function unloadWebGPULocalModel(modelId?: WebGPULocalModelId): Promise<void> {
  const activeEngine = engine;
  if (!activeEngine || loadedModelIds.size === 0) return;

  await operationQueue;
  if (modelId && loadedModelIds.size > 1) {
    const remaining = [...loadedModelIds].filter((id) => id !== modelId);
    await activeEngine.reload(remaining);
    loadedModelIds.delete(modelId);
    if (loadedModelId === modelId) loadedModelId = remaining[0] ?? null;
    return;
  }

  engine = null;
  loadedModelIds.clear();
  loadedModelId = null;
  try {
    await activeEngine.unload();
  } finally {
    modelWorker?.terminate();
    modelWorker = null;
  }
}

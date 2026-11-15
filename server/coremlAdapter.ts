import fs from 'node:fs/promises';
import path from 'node:path';

export interface CoreMLVariantSpec {
  id: 'llama-3.2-1b-coreml' | 'llama-3.2-3b-coreml';
  name: string;
  parameterCount: string;
  bundleFilename: string;
  sizeGB: number;
  ramRequirementGB: number;
  contextLength: number;
  computeUnits: string;
  targetDevice: string;
}

export interface IOSLocalModelSpec {
  modelId: string;
  adapterId: string;
  name: string;
  runtime: string;
  bundleFilename: string;
  sizeGB: number;
  ramRequirementGB: number;
  requiredSwiftFiles: string[];
}

export interface FileCheckResult {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

export interface CoreMLPackageVerification {
  readyForDeployment: boolean;
  packageRoot: string;
  requiredFiles: FileCheckResult[];
  missingFiles: string[];
  variants: CoreMLVariantSpec[];
  bridgeChannel: string;
  notes: string;
}

export interface IOSRuntimeSuiteVerification {
  readyForDeployment: boolean;
  packageRoot: string;
  bridgeChannel: string;
  totalFilesChecked: number;
  allFilesPresent: boolean;
  files: FileCheckResult[];
  missingFiles: string[];
  models: Array<{
    modelId: string;
    adapterId: string;
    name: string;
    runtime: string;
    bundleFilename: string;
    sizeGB: number;
    ramRequirementGB: number;
    readyForDeployment: boolean;
    missingFiles: string[];
  }>;
  notes: string;
}

const COREML_ROOT = path.resolve(process.cwd(), 'ios', 'ZeroCoreML');

export const IOS_SWIFT_ADAPTER_IDS = new Set([
  'coreml-llama-3.2-adapter',
  'ios-mlx-qwen-adapter',
  'ios-mlx-deepseek',
  'ios-mediapipe-gemma',
  'ios-whisper-cpp',
  'ios-piper-onnx',
  'ios-kokoro-mlx',
]);

const REQUIRED_COREML_FILES = [
  'Package.swift',
  'Sources/ZeroCoreML/LlamaCoreMLConfig.swift',
  'Sources/ZeroCoreML/LlamaCoreMLAdapter.swift',
  'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
];

const ALL_SWIFT_PACKAGE_FILES = [
  'Package.swift',
  'Sources/ZeroCoreML/LlamaCoreMLConfig.swift',
  'Sources/ZeroCoreML/LlamaCoreMLAdapter.swift',
  'Sources/ZeroCoreML/MLXSwiftTextAdapter.swift',
  'Sources/ZeroCoreML/MediaPipeGemmaAdapter.swift',
  'Sources/ZeroCoreML/WhisperMetalAdapter.swift',
  'Sources/ZeroCoreML/PiperONNXAdapter.swift',
  'Sources/ZeroCoreML/KokoroMLXAudioAdapter.swift',
  'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
];

export const LLAMA_32_COREML_VARIANTS: CoreMLVariantSpec[] = [
  {
    id: 'llama-3.2-1b-coreml',
    name: 'Llama 3.2 1B Instruct (4-bit LUT CoreML)',
    parameterCount: '1.24B',
    bundleFilename: 'Llama-3.2-1B-Instruct-4bit.mlmodelc',
    sizeGB: 0.72,
    ramRequirementGB: 1.4,
    contextLength: 4096,
    computeUnits: 'MLComputeUnits.cpuAndNeuralEngine',
    targetDevice: 'iPhone 16 Pro Max (A18 Pro · 8 GB Unified RAM)',
  },
  {
    id: 'llama-3.2-3b-coreml',
    name: 'Llama 3.2 3B Instruct (4-bit LUT CoreML)',
    parameterCount: '3.21B',
    bundleFilename: 'Llama-3.2-3B-Instruct-4bit.mlmodelc',
    sizeGB: 1.85,
    ramRequirementGB: 3.4,
    contextLength: 4096,
    computeUnits: 'MLComputeUnits.cpuAndNeuralEngine',
    targetDevice: 'iPhone 16 Pro Max (A18 Pro · 8 GB Unified RAM)',
  },
];

export const ALL_IOS_LOCAL_MODELS: IOSLocalModelSpec[] = [
  {
    modelId: 'llama-3.2-1b-coreml',
    adapterId: 'coreml-llama-3.2-adapter',
    name: 'Llama 3.2 1B Instruct (CoreML)',
    runtime: 'Apple CoreML MLState · A18 Pro Neural Engine',
    bundleFilename: 'Llama-3.2-1B-Instruct-4bit.mlmodelc',
    sizeGB: 0.72,
    ramRequirementGB: 1.4,
    requiredSwiftFiles: REQUIRED_COREML_FILES,
  },
  {
    modelId: 'llama-3.2-3b-coreml',
    adapterId: 'coreml-llama-3.2-adapter',
    name: 'Llama 3.2 3B Instruct (CoreML)',
    runtime: 'Apple CoreML MLState · A18 Pro Neural Engine',
    bundleFilename: 'Llama-3.2-3B-Instruct-4bit.mlmodelc',
    sizeGB: 1.85,
    ramRequirementGB: 3.4,
    requiredSwiftFiles: REQUIRED_COREML_FILES,
  },
  {
    modelId: 'qwen-2.5-3b-coreml',
    adapterId: 'ios-mlx-qwen-adapter',
    name: 'Qwen 2.5 3B Instruct (4-bit MLX)',
    runtime: 'Apple MLX Swift · Metal GPU + Unified RAM',
    bundleFilename: 'Qwen2.5-3B-Instruct-4bit.safetensors',
    sizeGB: 1.9,
    ramRequirementGB: 3.4,
    requiredSwiftFiles: [
      'Package.swift',
      'Sources/ZeroCoreML/MLXSwiftTextAdapter.swift',
      'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
    ],
  },
  {
    modelId: 'deepseek-r1-distill-1.5b',
    adapterId: 'ios-mlx-deepseek',
    name: 'DeepSeek-R1-Distill-Qwen-1.5B (MLX)',
    runtime: 'Apple MLX Swift · Chain-of-Thought Metal',
    bundleFilename: 'DeepSeek-R1-Distill-Qwen-1.5B-4bit.safetensors',
    sizeGB: 1.1,
    ramRequirementGB: 2.1,
    requiredSwiftFiles: [
      'Package.swift',
      'Sources/ZeroCoreML/MLXSwiftTextAdapter.swift',
      'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
    ],
  },
  {
    modelId: 'gemma-3-4b-it',
    adapterId: 'ios-mediapipe-gemma',
    name: 'Gemma 3 4B IT (MediaPipe Tasks GenAI)',
    runtime: 'MediaPipe Tasks GenAI · Multimodal GPU/ANE',
    bundleFilename: 'gemma3-4b-it-int4.task',
    sizeGB: 2.6,
    ramRequirementGB: 4.5,
    requiredSwiftFiles: [
      'Package.swift',
      'Sources/ZeroCoreML/MediaPipeGemmaAdapter.swift',
      'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
    ],
  },
  {
    modelId: 'whisper-cpp-small',
    adapterId: 'ios-whisper-cpp',
    name: 'whisper.cpp (small.q5_1 CoreML/Metal)',
    runtime: 'whisper.cpp Metal + CoreML Encoder',
    bundleFilename: 'ggml-small-q5_1.bin',
    sizeGB: 0.19,
    ramRequirementGB: 0.5,
    requiredSwiftFiles: [
      'Package.swift',
      'Sources/ZeroCoreML/WhisperMetalAdapter.swift',
      'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
    ],
  },
  {
    modelId: 'piper-tts-de',
    adapterId: 'ios-piper-onnx',
    name: 'Piper TTS (de_DE-thorsten-high)',
    runtime: 'ONNX Runtime iOS · CoreML Execution Provider',
    bundleFilename: 'de_DE-thorsten-high.onnx',
    sizeGB: 0.07,
    ramRequirementGB: 0.15,
    requiredSwiftFiles: [
      'Package.swift',
      'Sources/ZeroCoreML/PiperONNXAdapter.swift',
      'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
    ],
  },
  {
    modelId: 'kokoro-82m',
    adapterId: 'ios-kokoro-mlx',
    name: 'Kokoro-82M (CoreML / MLX Audio)',
    runtime: 'Apple CoreML / MLX Audio 24 kHz',
    bundleFilename: 'kokoro-v1_0-82m.mlmodelc',
    sizeGB: 0.32,
    ramRequirementGB: 0.8,
    requiredSwiftFiles: [
      'Package.swift',
      'Sources/ZeroCoreML/KokoroMLXAudioAdapter.swift',
      'Sources/ZeroCoreML/ZeroWKWebViewBridge.swift',
    ],
  },
];

async function checkModelBundle(bundleFilename: string): Promise<FileCheckResult> {
  const rel = 'Models/' + bundleFilename;
  const full = path.join(COREML_ROOT, rel);
  try {
    const st = await fs.stat(full);
    return { path: 'ios/ZeroCoreML/' + rel, exists: st.isFile() || st.isDirectory(), sizeBytes: st.isFile() ? st.size : 0 };
  } catch {
    return { path: 'ios/ZeroCoreML/' + rel, exists: false, sizeBytes: 0 };
  }
}

async function checkFiles(relPaths: string[]): Promise<FileCheckResult[]> {
  return Promise.all(
    relPaths.map(async (rel) => {
      const full = path.join(COREML_ROOT, rel);
      try {
        const st = await fs.stat(full);
        return {
          path: `ios/ZeroCoreML/${rel}`,
          exists: st.isFile() && st.size > 0,
          sizeBytes: st.size,
        };
      } catch {
        return {
          path: `ios/ZeroCoreML/${rel}`,
          exists: false,
          sizeBytes: 0,
        };
      }
    })
  );
}

export async function verifyCoreMLAdapterPackage(): Promise<CoreMLPackageVerification> {
  const checked = await checkFiles(REQUIRED_COREML_FILES);
  const modelBundles = await Promise.all(LLAMA_32_COREML_VARIANTS.map((variant) => checkModelBundle(variant.bundleFilename)));
  const missingFiles = [...checked, ...modelBundles].filter((c) => !c.exists).map((c) => c.path);
  const assetsComplete = missingFiles.length === 0;
  const readyForDeployment = false;

  return {
    readyForDeployment,
    packageRoot: 'ios/ZeroCoreML',
    requiredFiles: checked,
    missingFiles,
    variants: LLAMA_32_COREML_VARIANTS,
    bridgeChannel: 'window.webkit.messageHandlers.zeroCoreML',
    notes: assetsComplete
      ? 'Swift-Quellcode und beide CoreML-Modellgewichte vorhanden. Trotzdem NICHT deploymentbereit: Ein natives iOS-App-Target, Tokenizer-Integration, Xcode-Build und Gerätetest sind noch erforderlich.'
      : `Swift-Adapter-Code geprüft; Modellgewichte fehlen oder sind unvollständig: ${missingFiles.join(', ')}. Zusätzlich fehlen natives iOS-App-Target und Gerätetest.`,
  };
}

export async function verifyIOSAdapterForModel(
  modelId: string,
  adapterId: string
): Promise<{
  readyForDeployment: boolean;
  checkedFiles: FileCheckResult[];
  missingFiles: string[];
  runtime: string;
  bundleFilename: string;
  notes: string;
}> {
  const spec =
    ALL_IOS_LOCAL_MODELS.find((m) => m.modelId === modelId) ??
    ALL_IOS_LOCAL_MODELS.find((m) => m.adapterId === adapterId);

  if (!spec) {
    return {
      readyForDeployment: false,
      checkedFiles: [],
      missingFiles: ['Unbekannte iOS-Adapter-ID'],
      runtime: 'Unbekannt',
      bundleFilename: '',
      notes: `Kein Swift-Adapter für "${modelId}" registriert.`,
    };
  }

  const checkedFiles = await checkFiles(spec.requiredSwiftFiles);
  const modelBundle = await checkModelBundle(spec.bundleFilename);
  const missingFiles = [...checkedFiles.filter((c) => !c.exists).map((c) => c.path), ...(!modelBundle.exists ? [modelBundle.path] : [])];
  const assetsComplete = missingFiles.length === 0;
  const readyForDeployment = false;

  return {
    readyForDeployment,
    checkedFiles,
    missingFiles,
    runtime: spec.runtime,
    bundleFilename: spec.bundleFilename,
    notes: readyForDeployment
      ? `${spec.runtime} · Swift-Quellcode und Modellgewicht vorhanden (Ziel-Bundle: ${spec.bundleFilename}). Nativer iOS-Gerätetest steht noch aus.`
      : `Adapter-Quellcode prüfen; Modellgewicht fehlt oder ist unvollständig: ${missingFiles.join(', ')}`,
  };
}

export async function verifyZeroIOSRuntimeSuite(): Promise<IOSRuntimeSuiteVerification> {
  const checked = await checkFiles(ALL_SWIFT_PACKAGE_FILES);
  const modelBundles = await Promise.all(ALL_IOS_LOCAL_MODELS.map((spec) => checkModelBundle(spec.bundleFilename)));
  const byPath = new Map(checked.map((c) => [c.path, c]));
  const byBundle = new Map(modelBundles.map((c) => [c.path, c]));
  const missingFiles = [...checked, ...modelBundles].filter((c) => !c.exists).map((c) => c.path);

  const models = ALL_IOS_LOCAL_MODELS.map((spec) => {
    const modelMissing = [
      ...spec.requiredSwiftFiles.map((rel) => `ios/ZeroCoreML/${rel}`).filter((p) => !byPath.get(p)?.exists),
      ...(!byBundle.get('ios/ZeroCoreML/Models/' + spec.bundleFilename)?.exists ? ['ios/ZeroCoreML/Models/' + spec.bundleFilename] : []),
    ];
    return {
      modelId: spec.modelId,
      adapterId: spec.adapterId,
      name: spec.name,
      runtime: spec.runtime,
      bundleFilename: spec.bundleFilename,
      sizeGB: spec.sizeGB,
      ramRequirementGB: spec.ramRequirementGB,
      readyForDeployment: false,
      missingFiles: modelMissing,
    };
  });

  const allFilesPresent = missingFiles.length === 0;

  return {
    readyForDeployment: false,
    packageRoot: 'ios/ZeroCoreML',
    bridgeChannel: 'window.webkit.messageHandlers.zeroCoreML',
    totalFilesChecked: checked.length + modelBundles.length,
    allFilesPresent,
    files: [...checked, ...modelBundles],
    missingFiles,
    models,
    notes: allFilesPresent
      ? 'Swift-Quellcode und Modellgewichte sind vorhanden. Trotzdem NICHT deploymentbereit: natives iOS-App-Target, echte Runtime-Abhängigkeiten, Tokenizer/Backends, Xcode-Build und Gerätetest fehlen noch.'
      : `Swift-Quellcode vorhanden; fehlende Modellgewichte oder Adapter-Dateien: ${missingFiles.join(', ')}. Zusätzlich ist das native iOS-App-Target noch nicht integriert.`,
  };
}

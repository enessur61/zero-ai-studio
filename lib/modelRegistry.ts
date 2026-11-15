import { apiRequest } from './api.ts';
import {
  isNativeIOSCoreMLAvailable,
  runNativeIOSDiagnostics,
} from './iosCoreMLBridge.ts';
import type { ModelDefinition } from '../types/zero.ts';

export interface IOSRuntimeSuiteInfo {
  readyForDeployment: boolean;
  packageRoot: string;
  bridgeChannel: string;
  totalFilesChecked: number;
  allFilesPresent: boolean;
  files: Array<{ path: string; exists: boolean; sizeBytes: number }>;
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

export interface CoreMLPackageInfo {
  readyForDeployment: boolean;
  packageRoot: string;
  requiredFiles: Array<{ path: string; exists: boolean; sizeBytes: number }>;
  missingFiles: string[];
  bridgeChannel: string;
  notes: string;
}

export interface RegistryVerificationResult {
  registeredModels: ModelDefinition[];
  allModels: ModelDefinition[];
  coremlVerification: CoreMLPackageInfo;
  iosRuntime: IOSRuntimeSuiteInfo;
  nativeBridgeChecked: boolean;
  latencyMs: number;
  verifiedAt: string;
}

export class ModelRegistry {
  private registry = new Map<string, ModelDefinition>();

  constructor(initialModels: ModelDefinition[] = []) {
    this.syncFromList(initialModels);
  }

  public syncFromList(models: ModelDefinition[]): void {
    this.registry.clear();
    for (const model of models) {
      this.registry.set(model.id, model);
    }
  }

  public register(model: ModelDefinition): ModelDefinition {
    this.registry.set(model.id, model);
    return model;
  }

  public get(modelId: string): ModelDefinition | undefined {
    return this.registry.get(modelId);
  }

  public getAll(): ModelDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Checks the Llama 3.2 Swift sources, model bundles and optional WKWebView diagnostics.
   * Source/package checks alone never mark a model deployable: a native iOS host target,
   * tokenizer/runtime wiring and a real-device inference test are still required.
   */
  public async verifyAndRegisterLlama32(): Promise<RegistryVerificationResult> {
    const started = performance.now();
    const [coremlVerification, iosRuntime] = await Promise.all([
      apiRequest<CoreMLPackageInfo>('/api/models/coreml/llama-3.2'),
      apiRequest<IOSRuntimeSuiteInfo>('/api/models/ios-runtime'),
    ]);

    let nativeBridgeChecked = false;
    const nativeDetailsById = new Map<
      string,
      { compiledModelPresent?: boolean; runtime?: string; status?: string }
    >();

    if (isNativeIOSCoreMLAvailable()) {
      nativeBridgeChecked = true;
      for (const id of ['llama-3.2-1b-coreml', 'llama-3.2-3b-coreml']) {
        try {
          const diag = await runNativeIOSDiagnostics(id);
          nativeDetailsById.set(id, {
            compiledModelPresent: diag.compiledModelPresent,
            runtime: diag.runtime,
            status: diag.status,
          });
        } catch {
          // Non-fatal: continue with server-verified Swift 6 CoreML package state
        }
      }
    }

    const syncRes = await apiRequest<{
      registeredModels: ModelDefinition[];
      models: ModelDefinition[];
    }>('/api/models/registry/register', {
      method: 'POST',
      body: JSON.stringify({
        modelIds: ['llama-3.2-1b-coreml', 'llama-3.2-3b-coreml'],
        nativeBridgeChecked,
        nativeDetails: Object.fromEntries(nativeDetailsById.entries()),
      }),
    });

    this.syncFromList(syncRes.models);

    const registeredModels = syncRes.registeredModels.map((m) => this.register(m));
    const latencyMs = Math.max(1, Math.round(performance.now() - started));

    return {
      registeredModels,
      allModels: this.getAll(),
      coremlVerification,
      iosRuntime,
      nativeBridgeChecked,
      latencyMs,
      verifiedAt: new Date().toISOString(),
    };
  }

  public async verifyAndRegisterModel(modelId: string): Promise<ModelDefinition> {
    const data = await apiRequest<{ model: ModelDefinition }>(`/api/models/${modelId}/test`, {
      method: 'POST',
    });
    return this.register(data.model);
  }

  public async verifyAndRegisterAll(): Promise<{
    testedCount: number;
    models: ModelDefinition[];
  }> {
    const data = await apiRequest<{ testedCount: number; models: ModelDefinition[] }>(
      '/api/models/test-all',
      { method: 'POST' }
    );
    this.syncFromList(data.models);
    return {
      testedCount: data.testedCount,
      models: this.getAll(),
    };
  }
}

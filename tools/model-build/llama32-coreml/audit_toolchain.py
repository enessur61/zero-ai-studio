#!/usr/bin/env python3
"""Resolve, PyPI-hash-verify, install offline, and import-test a CPU-only Core ML toolchain.

This audit never downloads model/tokenizer assets and never invokes model conversion.
Only Python package wheels and their metadata are fetched from PyPI.
"""
from __future__ import annotations

import email
import hashlib
import json
import os
import platform
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def run(args: list[str], *, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        args, check=True, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, env=env
    )
    return completed.stdout


def runtime_tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            digest.update(b"L\0" + relative.encode() + b"\0")
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(b"F\0" + relative.encode() + b"\0")
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
    return digest.hexdigest()


def wheel_metadata(path: Path) -> tuple[str, str]:
    # PEP 427 wheel filenames begin with normalized distribution and version.
    # Select that wheel's own .dist-info record rather than assuming an archive
    # can contain only one METADATA file (vendored packages may add others).
    parts = path.name[:-4].split("-")
    if len(parts) < 5 or not path.name.endswith(".whl"):
        raise RuntimeError(f"Invalid wheel filename: {path.name}")
    canonical_metadata = f"{parts[0]}-{parts[1]}.dist-info/METADATA"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        matches = [name for name in names if name == canonical_metadata]
        if len(matches) != 1:
            candidates = [name for name in names if name.endswith(".dist-info/METADATA")]
            raise RuntimeError(
                f"Expected canonical wheel METADATA {canonical_metadata} in "
                f"{path.name}; found {candidates}"
            )
        message = email.message_from_bytes(archive.read(matches[0]))
    name, version = message.get("Name"), message.get("Version")
    if not name or not version:
        raise RuntimeError(f"Missing Name/Version metadata in {path.name}")
    return name, version


def pypi_file_metadata(name: str, version: str, filename: str) -> dict:
    project = urllib.parse.quote(name, safe="")
    release = urllib.parse.quote(version, safe="")
    url = f"https://pypi.org/pypi/{project}/{release}/json"
    request = urllib.request.Request(
        url, headers={"User-Agent": "ZERO-CoreML-Toolchain-Audit/1.0"}
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.load(response)
    matches = [item for item in payload.get("urls", []) if item.get("filename") == filename]
    if len(matches) != 1:
        raise RuntimeError(f"PyPI did not return one exact file record for {filename}")
    return matches[0]


def main() -> int:
    if sys.version_info[:3] != (3, 12, 10):
        raise RuntimeError(f"Expected CPython 3.12.10, got {sys.version}")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError(
            f"Expected macOS ARM64, got {platform.system()} {platform.machine()}"
        )

    output = Path(os.environ["RUNNER_TEMP"]) / "zero-coreml-toolchain-audit"
    wheelhouse = output / "wheelhouse"
    output.mkdir(parents=True, exist_ok=True)
    wheelhouse.mkdir(parents=True, exist_ok=True)
    lock_path = output / "requirements.lock"
    report_path = output / "toolchain-audit.json"

    pip_version = run([sys.executable, "-m", "pip", "--version"]).strip()
    if not pip_version.startswith("pip 25.0.1 "):
        raise RuntimeError(f"Expected bootstrap pip 25.0.1, got {pip_version}")
    run([
        sys.executable, "-m", "pip", "download",
        "--disable-pip-version-check", "--no-cache-dir",
        "--only-binary=:all:", "--dest", str(wheelhouse),
        "-r", str(ROOT / "candidate-requirements.in"),
    ])

    wheel_records = []
    seen = set()
    for wheel in sorted(wheelhouse.glob("*.whl")):
        name, version = wheel_metadata(wheel)
        normalized = name.lower().replace("_", "-").replace(".", "-")
        if normalized in seen:
            raise RuntimeError(f"More than one wheel selected for {name}")
        seen.add(normalized)
        actual_hash = hashlib.sha256(wheel.read_bytes()).hexdigest()
        pypi = pypi_file_metadata(name, version, wheel.name)
        expected_hash = pypi.get("digests", {}).get("sha256")
        if not expected_hash or actual_hash != expected_hash:
            raise RuntimeError(f"PyPI SHA-256 mismatch for {wheel.name}")
        wheel_records.append({
            "name": name,
            "version": version,
            "filename": wheel.name,
            "sha256": actual_hash,
            "size_bytes": wheel.stat().st_size,
            "pypi_upload_time": pypi.get("upload_time_iso_8601"),
            "pypi_provenance": bool(pypi.get("provenance")),
        })

    if not wheel_records:
        raise RuntimeError("Resolver produced no wheels")
    lock_path.write_text(
        "".join(
            f"{item['name']}=={item['version']} --hash=sha256:{item['sha256']}\n"
            for item in sorted(wheel_records, key=lambda x: x["name"].lower())
        ),
        encoding="utf-8",
    )

    run([
        sys.executable, "-m", "pip", "install",
        "--disable-pip-version-check", "--no-index",
        "--find-links", str(wheelhouse), "--require-hashes",
        "-r", str(lock_path),
    ])
    pip_check = run([sys.executable, "-m", "pip", "check"]).strip()

    offline_env = os.environ.copy()
    offline_env.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "CUDA_VISIBLE_DEVICES": "",
        "PYTORCH_ENABLE_MPS_FALLBACK": "0",
    })
    import_test = r'''
import coremltools
import torch
import transformers
import safetensors
import tokenizers
from transformers.models.llama.configuration_llama import LlamaConfig

assert coremltools.__version__ == "9.0", coremltools.__version__
assert torch.__version__.split("+")[0] == "2.7.0", torch.__version__
assert transformers.__version__ == "5.24.1", transformers.__version__
assert safetensors.__version__ == "0.8.0", safetensors.__version__
assert tokenizers.__version__ == "0.23.3", tokenizers.__version__
assert LlamaConfig.__name__ == "LlamaConfig"
cpu_result = torch.tensor([1, 2, 3], device="cpu").sum().item()
assert cpu_result == 6, cpu_result
assert callable(coremltools.convert)
print({
    "coremltools": coremltools.__version__,
    "torch": torch.__version__,
    "transformers": transformers.__version__,
    "safetensors": safetensors.__version__,
    "tokenizers": tokenizers.__version__,
    "llama_config_import": "passed",
    "cpu_tensor_smoke": cpu_result,
    "coreml_convert_api_imported_not_invoked": True,
    "model_assets_downloaded": False,
    "conversion_invoked": False,
    "gpu_provider_invoked": False,
})
'''
    import_output = run([sys.executable, "-c", import_test], env=offline_env)

    report = {
        "schema_version": 1,
        "purpose": "candidate toolchain resolver and import compatibility audit only",
        "python": {
            "version": sys.version,
            "implementation": platform.python_implementation(),
            "machine": platform.machine(),
            "base_prefix": sys.base_prefix,
            "base_runtime_tree_sha256": runtime_tree_sha256(Path(sys.base_prefix)),
            "pip": pip_version,
        },
        "platform": platform.platform(),
        "wheel_count": len(wheel_records),
        "wheels": wheel_records,
        "requirements_lock_sha256": hashlib.sha256(lock_path.read_bytes()).hexdigest(),
        "pip_check": pip_check,
        "import_test_output": import_output,
        "model_assets_downloaded": False,
        "conversion_invoked": False,
        "gpu_or_provider_invoked": False,
        "production_approval": False,
    }
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "wheel_count": len(wheel_records),
        "requirements_lock": str(lock_path),
        "requirements_lock_sha256": report["requirements_lock_sha256"],
        "runtime_tree_sha256": report["python"]["base_runtime_tree_sha256"],
        "import_test_output": import_output,
        "report": str(report_path),
        "production_approval": False,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

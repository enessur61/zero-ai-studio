#!/usr/bin/env python3
"""Generate a tiny deterministic stateful Core ML K/V-cache fixture for XCTest."""
from __future__ import annotations

import argparse
from pathlib import Path

import coremltools as ct
from coremltools.converters.mil.mil import Builder as mb
from coremltools.converters.mil.mil import types


def build_model():
    mask_width = ct.RangeDim(lower_bound=1, upper_bound=4096, default=1)

    @mb.program(
        opset_version=ct.target.iOS18,
        input_specs=[
            mb.TensorSpec(shape=(1, 1), dtype=types.int32),
            mb.TensorSpec(
                shape=(
                    1,
                    1,
                    1,
                    mask_width.symbol,
                ),
                dtype=types.fp16,
            ),
            mb.StateTensorSpec(shape=(1,), dtype=types.fp16),
            mb.StateTensorSpec(shape=(1,), dtype=types.fp16),
        ],
    )
    def stateful_kv_cache(inputIds, causalMask, k_cache, v_cache):
        previous_k = mb.read_state(input=k_cache)
        previous_v = mb.read_state(input=v_cache)
        token_values = mb.cast(x=inputIds, dtype="fp16")
        token_sum = mb.reduce_sum(x=token_values, axes=[0, 1])
        mask_sum = mb.reduce_sum(x=causalMask, axes=[0, 1, 2, 3])
        increment = mb.add(x=token_sum, y=mask_sum)
        increment_vector = mb.reshape(x=increment, shape=[1])
        updated_k = mb.add(x=previous_k, y=increment_vector)
        doubled_increment = mb.add(x=increment, y=increment)
        updated_v = mb.add(
            x=previous_v,
            y=mb.reshape(x=doubled_increment, shape=[1]),
        )
        mb.coreml_update_state(state=k_cache, value=updated_k)
        mb.coreml_update_state(state=v_cache, value=updated_v)
        return mb.reshape(x=updated_k, shape=[1, 1], name="logits")

    # The final causal-mask dimension is flexible (1...4096) so XCTest can
    # pass the growing attention window from successive decode positions.
    # Core ML Tools 8.3.0's default canonicalize_inplace_pattern pass crashes
    # when canonicalizing the two independent state updates in this model.
    model = ct.convert(
        stateful_kv_cache,
        inputs=[
            ct.TensorType(name="inputIds", shape=(1, 1), dtype=types.int32),
            ct.TensorType(
                name="causalMask",
                shape=(1, 1, 1, mask_width),
                dtype=types.fp16,
            ),
        ],
        minimum_deployment_target=ct.target.iOS18,
        pass_pipeline=ct.PassPipeline.EMPTY,
    )

    # MIL symbolic dimensions alone are not sufficient: assert that the exported
    # Core ML feature contract retained the requested runtime range.
    mask_feature = next(
        (feature for feature in model.get_spec().description.input if feature.name == "causalMask"),
        None,
    )
    if mask_feature is None:
        raise RuntimeError("Core ML model is missing its causalMask input.")
    mask_ranges = mask_feature.type.multiArrayType.shapeRange.sizeRanges
    if len(mask_ranges) != 4:
        raise RuntimeError(f"Unexpected causalMask rank/range metadata: {len(mask_ranges)}")
    final_range = mask_ranges[3]
    if final_range.lowerBound != 1 or final_range.upperBound != 4096:
        raise RuntimeError(
            "Core ML causalMask width range was not preserved: "
            f"{final_range.lowerBound}...{final_range.upperBound}"
        )
    return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    model = build_model()
    model.save(str(args.output))
    if not args.output.is_dir() or not (args.output / "Manifest.json").is_file():
        raise RuntimeError(f"Core ML model package was not created: {args.output}")
    print(f"Generated stateful Core ML K/V fixture: {args.output}")


if __name__ == "__main__":
    main()

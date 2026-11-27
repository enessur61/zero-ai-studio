#!/usr/bin/env python3
"""Generate a tiny real stateful Core ML model used only by XCTest.

The model is deliberately not a language model. Its one-element accumulator is
an observable stand-in for an independently owned KV-cache state buffer.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import coremltools as ct
from coremltools.converters.mil.mil import Builder as mb
from coremltools.converters.mil.mil import types


def build_model():
    @mb.program(
        input_specs=[
            mb.TensorSpec(shape=(1, 1), dtype=types.int32),
            mb.TensorSpec(shape=(1, 1, 1, 1), dtype=types.fp16),
            mb.StateTensorSpec(shape=(1,), dtype=types.fp32),
        ]
    )
    def stateful_accumulator(inputIds, causalMask, accumulator):
        previous = mb.read_state(input=accumulator)
        token_values = mb.cast(x=inputIds, dtype=types.fp32)
        token_sum = mb.reduce_sum(x=token_values, axes=[0, 1])
        mask_sum = mb.cast(
            x=mb.reduce_sum(x=causalMask, axes=[0, 1, 2, 3]),
            dtype=types.fp32,
        )
        increment = mb.add(x=token_sum, y=mask_sum)
        updated = mb.add(x=previous, y=mb.reshape(x=increment, shape=[1]))
        mb.coreml_update_state(state=accumulator, value=updated)
        return mb.reshape(x=updated, shape=[1, 1], name="logits")

    return ct.convert(
        stateful_accumulator,
        minimum_deployment_target=ct.target.iOS18,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    model = build_model()
    model.save(str(args.output))
    if not args.output.is_dir() or not (args.output / "Manifest.json").is_file():
        raise RuntimeError(f"Core ML model package was not created: {args.output}")
    print(f"Generated stateful Core ML fixture: {args.output}")


if __name__ == "__main__":
    main()

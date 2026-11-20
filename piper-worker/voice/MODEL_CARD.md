# Model card for thorsten (medium)

- Language: de_DE (German, Germany)
- Speakers: 1
- Quality: medium
- Sample rate: 22,050 Hz

## Dataset

- URL: https://github.com/thorstenMueller/Thorsten-Voice
- License: CC0

## Training

Fine-tuned from the rdh base model (medium quality; nl_BE, one Flemish speaker, CC0), with MRD and SDP.

Default inference settings: noise_scale 0.5 and noise_w 0.333.

Requires Piper 1.5 or higher.

## Pin

- Repository: https://huggingface.co/rhasspy/piper-voices
- Revision: cf910fb59f1d79ab3b625a63993a108751c6c25d
- ONNX SHA-256: fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f
- ONNX size: 63,221,984 bytes

The upstream model card identifies the dataset and rdh base as CC0. This notice records provenance; it is not a legal opinion or a blanket commercial-use clearance.

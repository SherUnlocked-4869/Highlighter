# OCR models

The `ppocr-v4-ch` profile uses the mobile PaddleOCR v4 models published by
RapidOCR:

- `ch_PP-OCRv4_det_mobile.onnx`
- `ch_ppocr_mobile_v2.0_cls_mobile.onnx`
- `ch_PP-OCRv4_rec_mobile.onnx`

Source: https://www.modelscope.cn/models/RapidAI/RapidOCR/tree/master/onnx/PP-OCRv4

The upstream model repository is distributed under the Apache License 2.0.
`model.json` records the expected size and SHA-256 digest for each file so the
desktop process can reject incomplete or corrupted model downloads.

Files for the stronger photo reader, served from this site so a photo never leaves the phone.
- ch_PP-OCRv4_det_infer.onnx (finds where the text is) and ch_PP-OCRv4_rec_infer.onnx (reads it), with ppocr_keys_v1.txt (the characters it knows):
  PaddleOCR PP-OCRv4 models, Apache License 2.0, taken unchanged from the npm package @gutenye/ocr-models 1.4.2.
- ort.wasm.min.mjs, ort-wasm-simd-threaded.mjs, ort-wasm-simd-threaded.wasm: ONNX Runtime Web 1.30.0 (MIT License, LICENSE-onnxruntime.txt),
  the engine that runs the models in the browser.

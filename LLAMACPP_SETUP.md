# llama.cpp Video Support — Server Setup Primer

## What the SillyTavern extension sends

The extension injects an `input_video` content part into the last user message before the request reaches the server. The request body looks like:

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "describe the video" },
        {
          "type": "input_video",
          "input_video": { "url": "data:video/mp4;base64,AAAA..." }
        }
      ]
    }
  ]
}
```

The video is sent as a base64-encoded data URI (`data:video/mp4;base64,...`). This is the format llama.cpp's mtmd subsystem expects.

---

## Requirements

### 1. llama.cpp build

Video support requires the **mtmd** (multimodal) subsystem, merged June 2026 (PR #24269). You need a build from that date or later. Confirm by checking startup logs for output mentioning `mtmd` or by verifying the build date.

### 2. ffmpeg

llama.cpp delegates video decoding to ffmpeg as a subprocess. ffmpeg **must be installed and accessible in the PATH of the process running the llama.cpp server**. Verify:

```bash
ffmpeg -version
```

Run this in the same shell/environment as the server, not just your login shell — if the server runs as a systemd service or in a container, PATH may differ.

### 3. A video-capable multimodal model + mmproj

Not all multimodal models support video. The model must have a vision encoder trained on video, and the corresponding mmproj file must be loaded. Confirmed working in llama.cpp:

- **Qwen2-VL** (7B, 72B) — recommended, well-tested video support
- **LLaVA-Video**
- **InternVL2**

The model currently in use (**Qwen3.8-27B**) may not have video support implemented in llama.cpp's mtmd layer even if the upstream model supports it. If Qwen3.8 video support is not yet merged, switch to Qwen2-VL-7B as a drop-in alternative.

### 4. Server launch flags

```bash
llama-server \
  --model path/to/model.gguf \
  --mmproj path/to/mmproj.gguf \
  --host 0.0.0.0 \
  --port 8080
```

No additional flags are required for video — ffmpeg is invoked automatically when an `input_video` content part is received.

---

## Diagnosing silent video drops

If the model responds as if no video was attached, check the prompt eval token count in the server logs:

```
prompt eval time = 191.35 ms / 4 tokens
```

**4 tokens = text only.** Video frames, once decoded, produce hundreds to thousands of additional visual tokens. The prompt eval token count will be significantly higher and take several seconds if video is being processed correctly.

Common causes of silent drops:

| Symptom | Cause |
|---|---|
| Low token count, no ffmpeg output in logs | ffmpeg not found in server PATH |
| Low token count, server started without errors | Build predates mtmd video support |
| Low token count, mmproj loaded successfully | mmproj/model doesn't support video |
| Error in server logs mentioning MOOV | MP4 missing faststart flag — re-encode: `ffmpeg -i input.mp4 -movflags +faststart -c copy output.mp4` |

---

## Verifying it works

When video is processed correctly you will see in the server logs:

- ffmpeg subprocess invocation (decoding frames)
- Significantly higher prompt eval token count (hundreds+)
- The model describing actual video content

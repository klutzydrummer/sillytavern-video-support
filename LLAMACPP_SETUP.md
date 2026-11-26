# Video in SillyTavern with llama.cpp — Setup Primer

The extension has two modes. Both only touch the main chat generation request of the **Custom (OpenAI-compatible)** chat-completion source, and only for the user message that owns the video (including its regenerate/swipe). Later turns do not re-send it.

| Mode | What is sent | Server needs |
|---|---|---|
| Frontend (default) | N JPEG frames as `image_url` parts, extracted in the browser with ffmpeg.wasm | Any vision model that accepts images (e.g. Gemma 4). No video support needed. |
| Backend | One `input_video` part with a `data:video/mp4;base64,...` URI | llama.cpp build including **PR #27921** (server accepts video as `input_video`/`video_url` and data URIs), on top of mtmd video support (#24269), plus `ffmpeg`/`ffprobe` in the server's PATH |

```json
{ "type": "image_url",   "image_url":   { "url": "data:image/jpeg;base64,..." } }
{ "type": "input_video", "input_video": { "url": "data:video/mp4;base64,..." } }
```

## Context cost (the important part)

Context used = frames x tokens per frame.

- **Frontend mode:** frames = min(duration x fps, Max frames). Defaults are 1 fps and 24 frames max (~24.6k tokens at 1024/frame). The settings panel shows the worst-case estimate; "Tokens per frame" is only used for that estimate.
- **Tokens per frame** depends on the server. With vastai-llmrunner, `models.json` forces `image_min_tokens = image_max_tokens = 1024`, so every frame costs 1024 tokens regardless of the "Max frame dimension" setting. For other servers set `--image-min-tokens`/`--image-max-tokens` (llama-server) lower to make frames cheaper (Gemma 4 guidance for video is small budgets, ~70–280 tokens/frame, and at most ~60 frames).
- **Backend mode:** llama-server samples at `--video-fps` (default 4.0), i.e. roughly 4 x tokens-per-frame per second of video (about 4096 tokens/s at 1024). Pass `--video-fps 1` (or lower) when launching. The extension's fps/frame settings do not apply in this mode.
- SillyTavern's own token counter does not see the video parts (they are added when the request is sent), so ST will not trim chat history to make room. Keep video budgets well under your context size.

## Audio

By default the extension sends no audio. In frontend mode, tick "Also send the video's audio" to decode the soundtrack in the browser (mono, 16 kHz WAV, ~1.9 MB base64 per minute) and send it as an `input_audio` part after the frames. This needs an audio-capable model (e.g. **LFM3-Omni**) behind a server that accepts `input_audio`; other servers may reject the request. Videos without a decodable audio track are sent frames-only.

## Requirements (backend mode)

1. llama.cpp built after #27921 (2026-09-23). Check `llama-server --help` for `--video-fps`.
2. `ffmpeg` and `ffprobe` on the PATH of the server process (systemd/containers may differ from your shell): `ffmpeg -version`.
3. A vision-capable model plus its `--mmproj`.

```bash
llama-server --model model.gguf --mmproj mmproj.gguf --video-fps 1 --host 0.0.0.0 --port 8080
```

Older builds reject `video_url`/`input_video` with HTTP 400; use frontend mode there.

## Size limits and storage

- Videos are saved through ST's file upload (`/api/files/upload`), so the chat file stores only a path. If the upload fails the video is stored inline as base64 (slow chat load/save).
- Files over **Max video size** (default 50 MB) are refused. Backend mode sends the full file base64-encoded (+33%) through ST and any tunnel; proxies such as Cloudflare have request body limits (100 MB on lower plans — verify).
- Frontend mode downloads ffmpeg.wasm (~30 MB) from jsDelivr on first use; change the source in settings to self-host.

## Diagnosing silent video drops

Check the server's prompt eval token count: a few tokens means text only; a video should add thousands.

| Symptom | Cause |
|---|---|
| Low token count, nothing in the extension console | Request wasn't injected: source isn't Custom, quiet/impersonate request, or the newest user message has no video |
| HTTP 400 mentioning video (backend mode) | Build predates #27921 |
| No ffmpeg activity (backend mode) | ffmpeg not in the server's PATH |
| Error mentioning MOOV | MP4 missing faststart: `ffmpeg -i in.mp4 -movflags +faststart -c copy out.mp4` |
| "Frame extraction failed" toast | Browser couldn't load ffmpeg.wasm (offline/CDN blocked) or file too large for wasm memory |

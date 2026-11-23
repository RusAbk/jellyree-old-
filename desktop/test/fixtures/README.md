`preview.webm` (VP8) and `preview.mp4` (H.264) are two-second, silent 320×180 test videos generated from FFmpeg's `testsrc` pattern. They contain no user media.

To regenerate from this directory:

```sh
ffmpeg -f lavfi -i testsrc=size=320x180:rate=10 -t 2 -c:v libvpx -pix_fmt yuv420p -an -y preview.webm
ffmpeg -f lavfi -i testsrc=size=320x180:rate=10 -t 2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an -y preview.mp4
```

Smoke tests serve the fixtures from a mocked cross-origin R2 URL without CORS headers. FFmpeg is only used to regenerate these fixtures; the application and tests do not require it.

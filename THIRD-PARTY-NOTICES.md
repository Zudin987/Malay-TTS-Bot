# Portable runtime notices

The application source does not contain runtime binaries. The CLEAN release builder downloads and verifies these exact distributions:

- Node.js 24.19.0 Windows x64, including npm and the distribution's LICENSE: https://nodejs.org/download/release/v24.19.0/
- FFmpeg 9.0.1 essentials Windows build from Gyan Doshi, including its distribution license/readme: https://github.com/GyanD/codexffmpeg/releases/tag/9.0.1

FFmpeg source and license information: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html. FFmpeg is a separate executable invoked by the bot. The selected Windows build may include GPL components; its shipped license and build notices govern that binary.

`release-manifest.json` records the source commit, exact upstream archive URLs and SHA-256 values, and a checksum for every other package file. Node archive/executable hashes are pinned from the Node project's published SHASUMS256.txt. The FFmpeg archive hash is pinned from the build publisher's release asset digest.

Application dependencies are installed using package-lock.json and retain their respective package licenses. No local AI model or paid Google Cloud TTS dependency is bundled.

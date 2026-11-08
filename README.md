# Pluralsight Scraper Enhanced

An enhanced, offline-first Pluralsight downloader for **ILX courses, legacy video courses, learning paths, hands-on lab guides and practice exams**.

This is a fork of [knyzorg/pluralsight-scraper](https://github.com/knyzorg/pluralsight-scraper) (via [ikeboy/pluralsight-scraper](https://github.com/ikeboy/pluralsight-scraper)), heavily extended for modern Pluralsight, Jellyfin, MEGA and Android.

> **This project requires a valid Pluralsight account.** It does not endorse piracy. Downloading content may violate Pluralsight's Terms of Service. Use at your own risk.

## What's new in Enhanced

- **Modern ILX API** support (courses, learning paths, 1080p HLS, transcription)
- **Legacy `video-course` support** through `VideoCourseByClipId` and the legacy course API
- **Quality selection**: `--quality best|1080|720`
- **Subtitles**: English/German/Spanish, `--subs all|none|en,de`, embedded soft tracks, optional `.srt`
- **Chapter markers** in every MP4
- **Hands-on labs** saved as Markdown + interactive HTML with checkboxes and progress
- **Practice exams** saved as Markdown + JSON + interactive HTML quiz with answer key and explanations
- **Course resources** and **searchable transcripts**
- **Searchable offline catalog** (`index.html`) with video, transcript, lab and exam search
- **Jellyfin integration**: NFO metadata, posters, thumbnails, TV layout, hardlink library builder and auto-refresh
- **MEGA integration** via rclone: full sync or on-demand mount (no permanent PC copy)
- **Local web portal**: player, resume, progress, notes, interactive transcript, Anki export, verify and download queue
- **Android companion app** (WebView, phone + Android TV, D-pad support)
- **Configuration file**, retries, duration checks, version manifests, desktop notifications and webhooks
- Fixes for Chromium 80/Cloudflare, login redirects, modern URL formats, HLS `.part` output, subtitle language matching and idempotent re-runs

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Requirements

- Node.js **18+**
- `ffmpeg` and `ffprobe`
- Linux (tested on Ubuntu/Kubuntu), macOS or Windows
- A modern Chrome/Chromium for login (the script can install Chrome for Testing locally)
- Optional: Jellyfin, rclone, Android SDK for the companion app

## Quick start

```bash
git clone https://github.com/DarkyGuld/pluralsight-scraper-enhanced.git
cd pluralsight-scraper-enhanced
npm install
npm run login
npm run get -- "https://app.pluralsight.com/learning-paths/<path-id>"
```

`npm run login` opens a browser window. Log in normally; cookies are saved to `cookies.txt` with mode `600`.

## Usage

### Courses and learning paths

```bash
# ILX course
npm run get -- "https://app.pluralsight.com/ilx/<course-slug>"

# Legacy video course
npm run get -- "https://app.pluralsight.com/library/courses/<course-slug>/table-of-contents"

# Whole learning path (all courses + labs + exams)
npm run get -- "https://app.pluralsight.com/learning-paths/<path-id>"
```

### Quality

```bash
npm run get -- "<url>" --quality best   # default, normally 1080p
npm run get -- "<url>" --quality 1080
npm run get -- "<url>" --quality 720
```

1080p uses Pluralsight's HLS stream with `ffmpeg`; 720p uses the direct MP4 rendition. Existing videos are upgraded automatically when they are below the requested quality.

### Subtitles

```bash
npm run get -- "<url>" --subs all       # default, all available languages
npm run get -- "<url>" --subs en        # English only
npm run get -- "<url>" --subs en,de     # English and German
npm run get -- "<url>" --subs none      # no subtitle tracks
```

Subtitles are embedded as `mov_text` soft tracks. External `.srt` files are removed after a successful embed; use `--keep-srt` to keep them.

### Labs and practice exams

```bash
npm run get -- "https://app.pluralsight.com/hands-on/labs/<lab-id>?ilx=true"
npm run get -- "https://app.pluralsight.com/assessment-pe/<exam-slug>"
```

Practice exam downloads create and submit one automatically answered attempt to unlock the answer key. Existing exam files are skipped, so re-running does not create new attempts.

### Other options

```bash
--delay <seconds>      Pause between clips/courses (default 10)
--retries <count>      Retry failed requests/downloads (default 3)
--output <directory>   Output directory (default videos)
--keep-srt             Keep external .srt files
--no-chapters          Disable chapter markers
--no-resources         Disable resources
--no-transcripts       Disable transcripts
--no-nfo               Disable Kodi/Jellyfin NFO files
--no-poster            Disable course posters
--no-playlist          Disable .m3u playlists
--no-index             Disable index.html catalogs
--no-thumbnails        Disable video thumbnails
--no-tv-layout         Disable Jellyfin/Kodi TV layout
--no-notify            Disable desktop notifications
```

## Output structure

```
videos/
└── <path-or-course>/
    ├── 01. Course Name/
    │   ├── 1. Clip.mp4
    │   ├── 1. Clip.nfo
    │   ├── playlist.m3u
    │   ├── index.html
    │   ├── manifest.json
    │   ├── poster.jpg
    │   ├── transcripts/
    │   ├── thumbnails/
    │   ├── resources/
    │   └── tv/
    ├── labs/
    ├── exams/
    ├── playlist.m3u
    └── index.html
```

Every course also gets a `manifest.json` with content versions for update checks.

## Interactive HTML pages

- `labs/*.html`: lab guide with checkboxes, progress and reset
- `exams/*.html`: timer, study mode, question navigator, flagging, scoring and full review
- `index.html`: searchable catalog across courses, videos, transcripts, labs, exams and resources

Open them directly in a browser. They are fully self-contained.

## Jellyfin (recommended Android/TV app)

Jellyfin provides a real native app for Android and Android TV, with offline downloads, progress and subtitles.

1. Install Jellyfin server (portable tarball or packages).
2. Point a **Shows** library at the generated `videos/jellyfin-tv` folder.
3. Build the library from the downloaded courses:

```bash
npm run jellyfin-library
```

The library builder creates hardlinks, so it does not duplicate video data.

Example user service files:

```bash
cp scripts/jellyfin.service.example ~/.config/systemd/user/jellyfin.service
systemctl --user daemon-reload
systemctl --user enable --now jellyfin
```

Official apps:

- **Phone:** [Jellyfin Android](https://play.google.com/store/apps/details?id=org.jellyfin.mobile) or [GitHub releases](https://github.com/jellyfin/jellyfin-android/releases)
- **Android TV:** [Jellyfin Android TV](https://play.google.com/store/apps/details?id=org.jellyfin.androidtv) or [GitHub releases](https://github.com/jellyfin/jellyfin-androidtv/releases)

Add your server URL (`http://<PC-IP>:8096`) and log in. For access outside your home network, use Tailscale or a VPN; do not expose port 8096 directly.

## MEGA and other cloud storage

`rclone` is the practical bridge between MEGA and Jellyfin. Jellyfin has no native MEGA support.

### Full local copy

```bash
~/.local/bin/rclone config   # create a remote named "mega"
npm run mega-sync
```

This syncs `mega:Pluralsight` to `videos/mega`, rebuilds the Jellyfin library and triggers a scan.

### On-demand mount (no permanent PC copy)

```bash
cp scripts/rclone-mega.service.example ~/.config/systemd/user/rclone-mega.service
systemctl --user daemon-reload
systemctl --user enable --now rclone-mega
```

MEGA is mounted at `~/mega`. Add `~/mega/Pluralsight` as a Jellyfin library folder. Only the chunks needed for playback are fetched and cached temporarily (20 GB / 24 h by default).

## Android companion app

`android-app/` contains a small native WebView app for the local portal:

- Phone and Android TV
- D-pad navigation and focus outlines
- Server address setting via the gear button or the in-app Jellyfin/portal settings
- Fullscreen video

Build it with the Android SDK:

```bash
export JAVA_HOME=<path-to-jdk17>
export ANDROID_HOME=<path-to-android-sdk>
gradle -p android-app assembleDebug
```

The APK is written to `android-app/app/build/outputs/apk/debug/app-debug.apk`.

**Jellyfin is the recommended app for watching courses.** The WebView app is a lightweight companion for the local portal.

## Configuration

Copy `config.example.json` to `config.json`:

```json
{
  "quality": "best",
  "delay": 10,
  "subs": "all",
  "keepSrt": false,
  "outputDir": "videos",
  "retries": 3,
  "chapters": true,
  "resources": true,
  "transcripts": true,
  "nfo": true,
  "poster": true,
  "playlist": true,
  "index": true,
  "notify": true,
  "thumbnails": true,
  "tvLayout": true,
  "serverPort": 4545,
  "serverHost": "0.0.0.0",
  "webhookUrl": ""
}
```

Command-line flags override the config. `config.json` is gitignored.

### Local portal

```bash
npm run serve
```

Opens `http://localhost:4545` with:

- Native-style video player with resume and speed control
- Progress tracking and "continue watching"
- Interactive transcript with clickable timestamps
- Notes and bookmarks
- Search across transcripts, labs and exams
- Anki TSV export and notes/progress Markdown export
- Integrity verification
- Download queue

## Troubleshooting

- **Cloudflare / "Just a moment"**: use the login flow with the bundled modern Chrome; the old Chromium 80 is not supported by Cloudflare.
- **Session expired**: run `npm run login` again.
- **`ffmpeg` missing**: install `ffmpeg` and `ffprobe`.
- **Jellyfin does not show new episodes**: run `npm run jellyfin-library`, then rescan the library.
- **MEGA mount fails**: check `rclone config`, then `systemctl --user status rclone-mega`.

## Legal

This project is provided for personal offline use with a valid Pluralsight subscription. It may violate Pluralsight's Terms of Service, including Section 5, which restricts downloading or storing Proprietary Materials. Your account may be flagged. You are responsible for how you use it.

## Credits and license

Original project by Slava Knyazev, with contributions from the community. Enhanced fork maintained by [DarkyGuld](https://github.com/DarkyGuld).

Licensed under the GNU General Public License v2.0. See [LICENSE](LICENSE).

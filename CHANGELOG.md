# Changelog

## 3.0.0 – Pluralsight Scraper Enhanced

This release turns the original ILX/video downloader into a complete offline course toolkit.

### Added

- **Modern Pluralsight ILX support**
  - Experience API for courses and learning paths
  - `VideoCourseByClipId` support for legacy `video-course` entries
  - 1080p HLS download via `ffmpeg`
  - Direct 720p MP4 fallback
  - Automatic subtitle language detection

- **Quality selection**
  - `--quality best` (default)
  - `--quality 1080`
  - `--quality 720`
  - Existing videos are upgraded automatically when below the requested quality

- **Subtitles**
  - English, German and Spanish support
  - `--subs all|none|en,de,...`
  - Embedded `mov_text` soft tracks
  - Optional external `.srt` files with `--keep-srt`
  - Automatic trimming of unwanted existing subtitle tracks
  - Language alias matching (`en` ↔ `eng`, `de` ↔ `deu`, etc.)

- **Labs and practice exams**
  - Hands-on lab guides as Markdown and interactive HTML
  - Checkboxes, progress bar and reset for lab steps
  - Practice exams as Markdown, JSON and interactive HTML
  - Timer, study mode, question navigator, flagging, scoring and answer review
  - Practice exam downloads create and submit one automatically answered attempt to unlock the answer key

- **Metadata and offline catalog**
  - Chapter markers in every MP4
  - Kodi/Jellyfin NFO files
  - Course posters and per-video thumbnails
  - Searchable transcripts (`.txt`, `.json`, `transcript.md`)
  - `playlist.m3u` per course and per path
  - Searchable `index.html` per course and path
  - `manifest.json` with content versions for update checks
  - Course resources (links and downloadable files)

- **Jellyfin integration**
  - TV layout with `tvshow.nfo`, `season.nfo`, episode NFOs and episode thumbnails
  - Hardlink-based library builder (`npm run jellyfin-library`) without duplicating video data
  - Automatic library rebuild and refresh after downloads
  - Example systemd user service

- **MEGA / cloud**
  - `rclone` sync helper (`npm run mega-sync`)
  - On-demand MEGA mount service example
  - Jellyfin can read directly from a MEGA mount with a bounded VFS cache

- **Local portal**
  - `npm run serve`
  - Native-style HTML5 player with resume, speed and next/previous
  - Progress tracking and "continue watching"
  - Interactive transcript with clickable timestamps
  - Notes and bookmarks
  - Global search across videos, transcripts, labs, exams and resources
  - Anki TSV export
  - Notes/progress Markdown export
  - Integrity verification
  - Download queue with live log
  - PWA manifest and icon

- **Android companion app**
  - Native WebView app for the local portal
  - Phone and Android TV support
  - Leanback launcher entry and TV banner
  - D-pad spatial navigation and large focus outlines
  - Server address setting
  - Fullscreen video support

- **Reliability**
  - Retry with exponential backoff for API, metadata and downloads
  - Duration checks after download
  - Idempotent re-runs: existing files are skipped
  - Stale/failed clip markers in manifests
  - Desktop notifications and optional webhook notifications
  - Config file with CLI overrides
  - Output directory selection

### Fixed

- Bundled Chromium 80 crashing on modern kernels; modern Chrome is used when available
- Chromium 80 being blocked by Cloudflare; modern Chrome passes the login challenge
- Login loop assuming an exact `/library/` URL
- Modern `/ilx/...` URLs failing the old `/library/courses/...` regex
- Legacy `/video/clips/v3/viewclip` returning 502/Cloudflare blocks
- HLS output failing because the temporary file ended in `.part`
- Subtitle trimming removing all tracks because `en` did not match `eng`
- Duplicate labs/exams in the portal catalog
- Incorrect Jellyfin episode discovery when using symlinks; hardlinks are now used
- `--help` not showing command-specific options
- Duplicate/incorrect metadata when re-running downloads
- `cookies.txt` permissions are now restricted to the current user

### Changed

- Default quality is `best` (normally 1080p)
- Default subtitle behaviour is `all`
- External `.srt` files are removed after embedding unless `--keep-srt`
- Output now includes chapters, NFO, posters, thumbnails, transcripts, resources, playlists and indexes
- Node.js 18+ is required
- The Android app is a companion for the local portal; Jellyfin is the recommended Android/TV app

### Notes

- Learning path durations on Pluralsight include interactive labs and exams; downloaded video duration is usually shorter.
- Practice exams are randomized. One download captures one 60-question attempt, not the entire question bank.
- Pluralsight may flag accounts that use this tool. Use a valid subscription and your own judgement.

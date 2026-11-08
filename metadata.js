const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_CONFIG = {
  quality: "best",
  delay: 10,
  subs: "all",
  keepSrt: false,
  outputDir: "videos",
  retries: 3,
  chapters: true,
  resources: true,
  transcripts: true,
  nfo: true,
  poster: true,
  playlist: true,
  index: true,
  notify: true,
  thumbnails: true,
  tvLayout: true,
  serverPort: 4545,
  serverHost: "0.0.0.0",
  webhookUrl: ""
};

function loadConfig(file) {
  let userConfig = {};
  try {
    if (fs.existsSync(file)) {
      userConfig = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (error) {
    console.error(`Could not read ${file}: ${error.message}`);
  }
  return { ...DEFAULT_CONFIG, ...userConfig };
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripMarkdown(value) {
  return String(value == null ? "" : value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function getVideoDuration(file) {
  try {
    const output = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      file
    ], { encoding: "utf8" });
    return parseFloat(output.trim()) || 0;
  } catch (error) {
    return 0;
  }
}

function getSubtitleLanguages(file) {
  try {
    const output = execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "s",
      "-show_entries", "stream_tags=language",
      "-of", "csv=p=0",
      file
    ], { encoding: "utf8" });
    return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function hasChapters(file) {
  try {
    const output = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "chapter=id",
      "-of", "csv=p=0",
      file
    ], { encoding: "utf8" });
    return output.trim().length > 0;
  } catch (error) {
    return false;
  }
}

function escapeFfmetadata(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, " ")
    .replace(/=/g, "\\=")
    .replace(/;/g, "\\;")
    .replace(/#/g, "\\#");
}

function addChapters(videoFile, title, duration) {
  if (hasChapters(videoFile)) {
    return false;
  }

  const seconds = duration || getVideoDuration(videoFile);
  if (!seconds) {
    return false;
  }

  const metadataFile = videoFile + ".chapters.txt";
  const tempFile = videoFile + ".chapters.mp4";
  const millis = Math.max(1, Math.round(seconds * 1000));
  fs.writeFileSync(metadataFile, [
    ";FFMETADATA1",
    "[CHAPTER]",
    "TIMEBASE=1/1000",
    "START=0",
    `END=${millis}`,
    `title=${escapeFfmetadata(title)}`,
    ""
  ].join("\n"));

  try {
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", videoFile,
      "-i", metadataFile,
      "-map", "0",
      "-map_metadata", "0",
      "-map_chapters", "1",
      "-c", "copy",
      tempFile
    ], { stdio: "pipe", timeout: 10 * 60 * 1000 });
    fs.renameSync(tempFile, videoFile);
    return true;
  } catch (error) {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    throw new Error(`Could not add chapters: ${String(error.stderr || error.message).slice(0, 300)}`);
  } finally {
    if (fs.existsSync(metadataFile)) {
      fs.unlinkSync(metadataFile);
    }
  }
}

function writeNfo(videoFile, meta) {
  const nfoFile = videoFile.replace(/\.[^.]+$/, "") + ".nfo";
  const runtime = Math.max(1, Math.round((meta.duration || 0) / 60));
  const title = meta.module ? `${meta.module} - ${meta.title}` : meta.title;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<movie>",
    `  <title>${xmlEscape(title)}</title>`,
    `  <originaltitle>${xmlEscape(meta.title)}</originaltitle>`,
    `  <plot>${xmlEscape(meta.description || meta.courseTitle || "")}</plot>`,
    `  <runtime>${runtime}</runtime>`,
    "  <genre>Education</genre>",
    "  <genre>Technology</genre>",
    "  <studio>Pluralsight</studio>",
    "  <tag>Pluralsight</tag>",
    meta.year ? `  <year>${xmlEscape(meta.year)}</year>` : "",
    "</movie>",
    ""
  ].filter(Boolean).join("\n");
  fs.writeFileSync(nfoFile, xml);
  return nfoFile;
}

function writePlaylist(playlistFile, entries) {
  const lines = ["#EXTM3U"];
  const directory = path.dirname(playlistFile);
  for (const entry of entries) {
    lines.push(`#EXTINF:${Math.round(entry.duration || 0)},${entry.title}`);
    lines.push(path.relative(directory, entry.file));
  }
  fs.writeFileSync(playlistFile, lines.join("\n") + "\n");
  return playlistFile;
}

function safeName(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/[:?*'|&;$%@"<>()+,\/#\\]/g, "")
    .replace(/\s+/g, " ");
}

function generateThumbnail(videoFile, thumbnailFile, duration) {
  if (fs.existsSync(thumbnailFile)) {
    return thumbnailFile;
  }
  fs.mkdirSync(path.dirname(thumbnailFile), { recursive: true });
  const seconds = Number(duration) || getVideoDuration(videoFile);
  const seek = Math.max(1, Math.min(seconds * 0.1, Math.max(1, seconds - 1)));
  try {
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-ss", seek.toFixed(2),
      "-i", videoFile,
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-q:v", "3",
      thumbnailFile
    ], { stdio: "pipe", timeout: 120000 });
    return thumbnailFile;
  } catch (error) {
    return null;
  }
}

function writeTvLayout(coursePath, course, clips, manifestClips, courseMeta = {}) {
  const showDirectory = path.join(coursePath, "tv", safeName(course.title));
  const seasonDirectory = path.join(showDirectory, "Season 01");
  fs.mkdirSync(seasonDirectory, { recursive: true });
  const year = String(courseMeta.updatedAt || "").slice(0, 4);
  const description = courseMeta.description || course.description || "";

  fs.writeFileSync(path.join(showDirectory, "tvshow.nfo"), [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<tvshow>",
    `  <title>${xmlEscape(course.title)}</title>`,
    `  <plot>${xmlEscape(description)}</plot>`,
    year ? `  <year>${xmlEscape(year)}</year>` : "",
    "  <studio>Pluralsight</studio>",
    "  <genre>Education</genre>",
    "  <genre>Technology</genre>",
    "</tvshow>",
    ""
  ].filter(Boolean).join("\n"));

  fs.writeFileSync(path.join(seasonDirectory, "season.nfo"), [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<season>",
    "  <seasonnumber>1</seasonnumber>",
    "  <title>Season 1</title>",
    `  <plot>${xmlEscape(description)}</plot>`,
    "</season>",
    ""
  ].join("\n"));

  clips.forEach((clip, index) => {
    const manifestClip = manifestClips[index];
    if (!manifestClip || !manifestClip.file) {
      return;
    }
    const videoFile = path.join(coursePath, manifestClip.file);
    if (!fs.existsSync(videoFile)) {
      return;
    }
    const episode = String(index + 1).padStart(2, "0");
    const linkName = `S01E${episode} - ${safeName(clip.title)}.mp4`;
    const linkPath = path.join(seasonDirectory, linkName);
    const target = path.relative(seasonDirectory, videoFile);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const existing = fs.readlinkSync(linkPath);
        if (existing !== target) {
          fs.unlinkSync(linkPath);
          fs.symlinkSync(target, linkPath);
        }
      }
    } catch (error) {
      fs.symlinkSync(target, linkPath);
    }

    const episodeNfo = path.join(seasonDirectory, `S01E${episode} - ${safeName(clip.title)}.nfo`);
    fs.writeFileSync(episodeNfo, [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      "<episodedetails>",
      `  <title>${xmlEscape(clip.title)}</title>`,
      `  <showtitle>${xmlEscape(course.title)}</showtitle>`,
      "  <season>1</season>",
      `  <episode>${index + 1}</episode>`,
      `  <plot>${xmlEscape(description)}</plot>`,
      `  <runtime>${Math.max(1, Math.round((clip.duration || 0) / 60))}</runtime>`,
      "  <studio>Pluralsight</studio>",
      "  <genre>Education</genre>",
      "</episodedetails>",
      ""
    ].join("\n"));

    if (manifestClip.thumbnail) {
      const thumbnailFile = path.join(coursePath, manifestClip.thumbnail);
      if (fs.existsSync(thumbnailFile)) {
        const thumbnailLink = path.join(seasonDirectory, `S01E${episode} - ${safeName(clip.title)}-thumb.jpg`);
        try {
          if (!fs.existsSync(thumbnailLink)) {
            fs.symlinkSync(path.relative(seasonDirectory, thumbnailFile), thumbnailLink);
          }
        } catch (error) {
          // Ignore thumbnail symlink errors
        }
      }
    }
  });

  return showDirectory;
}

async function sendWebhook(url, payload) {
  if (!url) {
    return false;
  }
  try {
    const fetch = require("node-fetch");
    const message = payload.message || payload.title || "Pluralsight download finished";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: message,
        text: message,
        ...payload
      })
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

function catalogHtml(title, subtitle, items, playlistHref) {
  const data = JSON.stringify(items).replace(/</g, "\\u003c");
  const safeTitle = xmlEscape(title);
  const safeSubtitle = xmlEscape(subtitle);
  const safePlaylist = playlistHref ? xmlEscape(playlistHref) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root { color-scheme: light; --bg:#f6f7fb; --card:#fff; --ink:#1c2333; --muted:#667085; --line:#e4e7ec; --accent:#5b3df5; --accent-soft:#ece8ff; --good:#067647; --warn:#b54708; }
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--ink); line-height:1.55; }
header { background:linear-gradient(135deg,#20124d,#4b2fd6); color:#fff; padding:38px 20px 30px; }
.wrap { max-width:1100px; margin:0 auto; padding:0 20px; }
h1 { margin:0 0 6px; font-size:clamp(26px,4vw,40px); line-height:1.15; }
.sub { margin:0 0 20px; color:#d9d2ff; }
.searchbox { display:flex; gap:10px; flex-wrap:wrap; }
.searchbox input { flex:1 1 320px; padding:12px 14px; border-radius:10px; border:0; font:inherit; }
.searchbox a { padding:12px 16px; border-radius:10px; background:rgba(255,255,255,.16); color:#fff; text-decoration:none; font-weight:600; }
.stats { margin-top:12px; color:#e8e3ff; font-size:14px; }
main { padding:26px 0 60px; }
.group { margin-bottom:28px; }
.group h2 { margin:0 0 10px; font-size:20px; }
.item { display:block; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:9px 0; text-decoration:none; color:inherit; box-shadow:0 6px 18px rgba(16,24,40,.04); }
.item:hover { border-color:#c9bfff; }
.badge { display:inline-block; font-size:11px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; padding:3px 7px; border-radius:5px; background:var(--accent-soft); color:var(--accent); margin-right:8px; }
.badge.lab { background:#fff4e5; color:var(--warn); }
.badge.exam { background:#ecfdf3; color:var(--good); }
.badge.resource { background:#eef4ff; color:#175cd3; }
.item h3 { display:inline; font-size:16px; margin:0; }
.meta { color:var(--muted); font-size:13px; margin-top:4px; }
.snippet { color:var(--muted); font-size:14px; margin-top:6px; }
.empty { background:var(--card); border:1px dashed var(--line); border-radius:12px; padding:24px; color:var(--muted); }
mark { background:#fff1a8; padding:0 2px; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>${safeTitle}</h1>
    <p class="sub">${safeSubtitle}</p>
    <div class="searchbox">
      <input id="q" type="search" placeholder="Search courses, videos, transcripts, labs and exam questions..." autocomplete="off">
      ${safePlaylist ? `<a href="${safePlaylist}">Play all</a>` : ""}
    </div>
    <div class="stats" id="stats"></div>
  </div>
</header>
<main class="wrap"><div id="results"></div></main>
<script>
var items = ${data};
var input = document.getElementById('q');
var results = document.getElementById('results');
var stats = document.getElementById('stats');
var typeLabels = { video: 'Video', lab: 'Lab', exam: 'Exam', resource: 'Resource' };

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}
function snippet(text, query) {
  if (!text) { return ''; }
  var lower = text.toLowerCase();
  var index = query ? lower.indexOf(query) : -1;
  var start = index > 80 ? index - 80 : 0;
  var value = text.slice(start, start + 240);
  if (start > 0) { value = '...' + value; }
  if (start + 240 < text.length) { value += '...'; }
  if (query && index !== -1) {
    var re = new RegExp('(' + escapeRegExp(query) + ')', 'ig');
    return escapeHtml(value).replace(re, '<mark>$1</mark>');
  }
  return escapeHtml(value);
}
function render() {
  var query = input.value.trim().toLowerCase();
  var filtered = items.filter(function (item) {
    if (!query) { return true; }
    return (item.title + ' ' + (item.subtitle || '') + ' ' + (item.text || '') + ' ' + (item.course || '')).toLowerCase().indexOf(query) !== -1;
  });
  stats.textContent = filtered.length + ' of ' + items.length + ' items' + (query ? ' matching "' + input.value.trim() + '"' : '');
  if (!filtered.length) {
    results.innerHTML = '<div class="empty">No matches. Try another search term.</div>';
    return;
  }
  var groups = { video: [], lab: [], exam: [], resource: [] };
  filtered.forEach(function (item) { (groups[item.type] || groups.video).push(item); });
  var html = '';
  ['video', 'lab', 'exam', 'resource'].forEach(function (type) {
    if (!groups[type].length) { return; }
    html += '<section class="group"><h2>' + typeLabels[type] + 's (' + groups[type].length + ')</h2>';
    groups[type].forEach(function (item) {
      var meta = [item.course, item.duration ? Math.round(item.duration / 60) + ' min' : ''].filter(Boolean).join(' · ');
      html += '<a class="item" href="' + encodeURI(item.href || '#') + '">'
        + '<span class="badge ' + type + '">' + typeLabels[type] + '</span>'
        + '<h3>' + escapeHtml(item.title) + '</h3>'
        + (meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : '')
        + (query && item.text ? '<div class="snippet">' + snippet(item.text, query) + '</div>' : '')
        + '</a>';
    });
    html += '</section>';
  });
  results.innerHTML = html;
}
input.addEventListener('input', render);
render();
</script>
</body>
</html>`;
}

function writeCatalog(file, title, subtitle, items, playlistHref) {
  fs.writeFileSync(file, catalogHtml(title, subtitle, items, playlistHref));
  return file;
}

function notify(title, message) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  try {
    execFileSync("notify-send", ["-a", "Pluralsight", title, message], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  ensureDir,
  xmlEscape,
  stripMarkdown,
  getVideoDuration,
  getSubtitleLanguages,
  hasChapters,
  addChapters,
  writeNfo,
  writePlaylist,
  writeCatalog,
  generateThumbnail,
  writeTvLayout,
  sendWebhook,
  notify
};

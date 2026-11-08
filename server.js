const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const metadata = require("./metadata");

const CONFIG = metadata.loadConfig(path.join(__dirname, "config.json"));
const ROOT = path.resolve(__dirname, CONFIG.outputDir);
const PORT = Number(CONFIG.serverPort) || 4545;
const HOST = CONFIG.serverHost || "0.0.0.0";
const DATA_DIR = path.join(ROOT, ".portal");
const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const PORTAL_FILE = path.join(__dirname, "portal.html");

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".m3u": "audio/x-mpegurl",
  ".nfo": "text/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8"
};

const LANGUAGE_NAMES = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  "fr-CA": "Français (Canada)",
  pt: "Português",
  "pt-BR": "Português (Brasil)",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  tr: "Türkçe",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
  "zh-Hans": "中文（简体）",
  "zh-Hant": "中文（繁體）",
  ar: "العربية"
};

const ISO_TO_LANGUAGE = {
  eng: "en",
  deu: "de",
  spa: "es",
  fra: "fr",
  por: "pt",
  ita: "it",
  nld: "nl",
  pol: "pl",
  tur: "tr",
  rus: "ru",
  jpn: "ja",
  kor: "ko",
  hin: "hi",
  zho: "zh-Hans",
  ara: "ar"
};

let catalogCache = null;
let catalogCacheAt = 0;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function readProgress() {
  return readJson(PROGRESS_FILE, {});
}

function readNotes() {
  return readJson(NOTES_FILE, {});
}

function encodePath(relative) {
  return String(relative)
    .split(/[\\/]/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function mediaUrl(relative) {
  return "/media/" + encodePath(relative);
}

function rel(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function walk(dir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === "tv" || entry.name === "node_modules" || entry.name === ".git" || entry.name === ".portal") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && entry.name === "manifest.json") {
      results.push(full);
    }
  }
  return results;
}

function buildCourse(manifestFile) {
  const courseDir = path.dirname(manifestFile);
  const data = readJson(manifestFile, {});
  const course = data.course || {};
  const folder = rel(ROOT, courseDir);
  const resourcesJson = readJson(path.join(courseDir, "resources.json"), []);
  const resources = (Array.isArray(resourcesJson) ? resourcesJson : []).map(resource => {
    let href = resource.url || "";
    let external = /^https?:\/\//i.test(href);
    if (resource.resourceType === "FILE" && resource.filename) {
      const file = path.join(courseDir, "resources", resource.filename);
      if (fileExists(file)) {
        href = mediaUrl(rel(ROOT, file));
        external = false;
      }
    }
    return {
      title: resource.title || resource.filename || "Resource",
      type: resource.resourceType || "LINK",
      href,
      external
    };
  });

  const videos = (data.clips || []).map(clip => {
    const file = path.join(courseDir, clip.file);
    const transcriptPath = clip.transcriptJson ? path.join(courseDir, clip.transcriptJson) : null;
    const transcriptTextPath = clip.transcript ? path.join(courseDir, "transcripts", clip.transcript) : null;
    let transcriptText = "";
    if (transcriptTextPath && fileExists(transcriptTextPath)) {
      transcriptText = fs.readFileSync(transcriptTextPath, "utf8");
    }
    const subtitleLanguages = (clip.subtitles || []).map(iso => {
      const lang = ISO_TO_LANGUAGE[iso] || iso;
      return {
        lang,
        label: LANGUAGE_NAMES[lang] || lang,
        url: transcriptPath ? `/api/subtitles?file=${encodeURIComponent(rel(ROOT, transcriptPath))}&lang=${encodeURIComponent(lang)}` : null
      };
    }).filter(track => track.url);

    return {
      id: `${folder}/${clip.file}`,
      title: clip.title,
      module: clip.module || "",
      duration: Number(clip.duration) || 0,
      media: mediaUrl(rel(ROOT, file)),
      thumbnail: clip.thumbnail ? mediaUrl(rel(ROOT, path.join(courseDir, clip.thumbnail))) : null,
      transcript: transcriptPath ? mediaUrl(rel(ROOT, transcriptPath)) : null,
      transcriptText,
      subtitles: subtitleLanguages,
      height: clip.height || 0
    };
  });

  const totalDuration = videos.reduce((sum, video) => sum + video.duration, 0);
  const totalBytes = videos.reduce((sum, video) => {
    try {
      return sum + fs.statSync(path.join(ROOT, video.id)).size;
    } catch (error) {
      return sum;
    }
  }, 0);

  return {
    title: course.title || path.basename(courseDir),
    slug: course.slug || path.basename(courseDir),
    description: course.description || "",
    folder,
    manifest: mediaUrl(rel(ROOT, manifestFile)),
    playlist: fileExists(path.join(courseDir, "playlist.m3u")) ? mediaUrl(rel(ROOT, path.join(courseDir, "playlist.m3u"))) : null,
    index: fileExists(path.join(courseDir, "index.html")) ? mediaUrl(rel(ROOT, path.join(courseDir, "index.html"))) : null,
    poster: ["poster.png", "poster.jpg"].map(name => path.join(courseDir, name)).find(fileExists)
      ? mediaUrl(rel(ROOT, ["poster.png", "poster.jpg"].map(name => path.join(courseDir, name)).find(fileExists)))
      : null,
    videos,
    resources,
    totalDuration,
    totalBytes
  };
}

function buildLabs(dir) {
  const labsDir = path.join(dir, "labs");
  if (!fs.existsSync(labsDir)) {
    return [];
  }
  return fs.readdirSync(labsDir)
    .filter(name => name.endsWith(".html"))
    .sort()
    .map(name => {
      const htmlFile = path.join(labsDir, name);
      const mdFile = htmlFile.replace(/\.html$/, ".md");
      const title = name.replace(/^\d+\.\s*/, "").replace(/\.html$/, "");
      const text = fileExists(mdFile) ? metadata.stripMarkdown(fs.readFileSync(mdFile, "utf8")) : "";
      return {
        title,
        href: mediaUrl(rel(ROOT, htmlFile)),
        markdown: fileExists(mdFile) ? mediaUrl(rel(ROOT, mdFile)) : null,
        searchText: text
      };
    });
}

function buildExams(dir) {
  const examsDir = path.join(dir, "exams");
  if (!fs.existsSync(examsDir)) {
    return [];
  }
  return fs.readdirSync(examsDir)
    .filter(name => name.endsWith(".html"))
    .sort()
    .map(name => {
      const htmlFile = path.join(examsDir, name);
      const jsonFile = htmlFile.replace(/\.html$/, ".json");
      const title = name.replace(/^\d+\.\s*/, "").replace(/\.html$/, "");
      let searchText = "";
      let key = title;
      if (fileExists(jsonFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
          key = (data.assessment && data.assessment.slug) || title;
          searchText = (data.questions || []).map(question => {
            const options = (question.options || []).map(option => `${option.content || option} ${option.rationale || ""}`).join(" ");
            return `${question.stem || ""} ${options}`;
          }).join(" ");
        } catch (error) {
          searchText = "";
        }
      }
      return {
        title,
        key,
        href: mediaUrl(rel(ROOT, htmlFile)),
        json: fileExists(jsonFile) ? mediaUrl(rel(ROOT, jsonFile)) : null,
        searchText
      };
    });
}

function buildCatalog() {
  const manifests = walk(ROOT);
  const pathManifests = [];
  const courseManifests = [];

  for (const file of manifests) {
    const data = readJson(file, null);
    if (!data) {
      continue;
    }
    if (data.path) {
      pathManifests.push({ file, data });
    } else if (data.course) {
      courseManifests.push(file);
    }
  }

  const courseByDir = new Map(courseManifests.map(file => [path.dirname(file), file]));
  const claimed = new Set();
  const paths = [];

  for (const { file, data } of pathManifests) {
    const pathDir = path.dirname(file);
    const entry = {
      title: data.path.title || path.basename(pathDir),
      slug: data.path.slug || path.basename(pathDir),
      folder: rel(ROOT, pathDir),
      playlist: fileExists(path.join(pathDir, "playlist.m3u")) ? mediaUrl(rel(ROOT, path.join(pathDir, "playlist.m3u"))) : null,
      index: fileExists(path.join(pathDir, "index.html")) ? mediaUrl(rel(ROOT, path.join(pathDir, "index.html"))) : null,
      courses: [],
      labs: buildLabs(pathDir),
      exams: buildExams(pathDir)
    };

    for (const course of data.courses || []) {
      const courseDir = path.join(pathDir, course.folder);
      const manifest = courseByDir.get(courseDir);
      if (manifest) {
        entry.courses.push(buildCourse(manifest));
        claimed.add(courseDir);
      }
    }
    paths.push(entry);
  }

  const standalone = courseManifests
    .filter(file => !claimed.has(path.dirname(file)))
    .map(file => buildCourse(file))
    .sort((a, b) => a.title.localeCompare(b.title));

  const allCourses = [...paths.flatMap(item => item.courses), ...standalone];
  const allVideos = allCourses.flatMap(course => course.videos);
  const pathLabs = paths.flatMap(item => item.labs);
  const pathExams = paths.flatMap(item => item.exams);
  const rootLabs = buildLabs(ROOT).filter(lab => !pathLabs.some(item => item.title === lab.title));
  const pathExamKeys = new Set(pathExams.map(exam => exam.key));
  const rootExams = buildExams(ROOT).filter(exam => !pathExamKeys.has(exam.key));
  const allLabs = [...pathLabs, ...rootLabs];
  const allExams = [...pathExams, ...rootExams];

  return {
    title: "Pluralsight Offline",
    generatedAt: new Date().toISOString(),
    root: ROOT,
    paths,
    standalone,
    standaloneLabs: rootLabs,
    standaloneExams: rootExams,
    stats: {
      paths: paths.length,
      courses: allCourses.length,
      videos: allVideos.length,
      labs: allLabs.length,
      exams: allExams.length,
      duration: allVideos.reduce((sum, video) => sum + video.duration, 0),
      bytes: allCourses.reduce((sum, course) => sum + course.totalBytes, 0)
    }
  };
}

function getCatalog(force = false) {
  if (force || !catalogCache || Date.now() - catalogCacheAt > 5000) {
    catalogCache = buildCatalog();
    catalogCacheAt = Date.now();
  }
  return catalogCache;
}

function vttTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function transcriptToVtt(data, language) {
  const segments = data[language] || data.en || Object.values(data)[0] || [];
  const lines = ["WEBVTT", ""];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const next = segments[index + 1];
    const start = Number(segment.start) || 0;
    let end = next ? Number(next.start) : start + Math.max(2, Math.min(8, String(segment.text).split(/\s+/).length / 2.5));
    if (end <= start) {
      end = start + 0.5;
    }
    lines.push(`${vttTime(start)} --> ${vttTime(end)}`, String(segment.text || ""), "");
  }
  return lines.join("\n");
}

function safeResolve(relative) {
  const decoded = decodeURIComponent(relative);
  const resolved = path.resolve(ROOT, decoded);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

function serveFile(req, res, file) {
  const extension = path.extname(file).toLowerCase();
  const contentType = MIME[extension] || "application/octet-stream";
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(file, { start, end }).pipe(res);
      }
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache"
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(file).pipe(res);
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function jsonResponse(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const jobs = [];
let activeJob = null;

function appendJobLog(job, chunk) {
  const text = chunk.toString();
  job.log.push(text);
  if (job.log.length > 300) {
    job.log.shift();
  }
}

function startNextJob() {
  if (activeJob) {
    return;
  }
  const job = jobs.find(item => item.status === "queued");
  if (!job) {
    return;
  }
  activeJob = job;
  job.status = "running";
  job.startedAt = Date.now();
  job.log = [];

  const args = [
    path.join(__dirname, "index.js"),
    "get",
    job.url,
    "--delay", "0",
    "--quality", job.quality,
    "--subs", job.subs,
    "--no-notify"
  ];
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env }
  });
  child.stdout.on("data", chunk => appendJobLog(job, chunk));
  child.stderr.on("data", chunk => appendJobLog(job, chunk));
  child.on("error", error => {
    appendJobLog(job, `Error: ${error.message}\n`);
  });
  child.on("exit", code => {
    job.status = code === 0 ? "done" : "failed";
    job.exitCode = code;
    job.finishedAt = Date.now();
    activeJob = null;
    catalogCache = null;
    startNextJob();
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/catalog") {
    return jsonResponse(res, getCatalog(url.searchParams.get("refresh") === "1"));
  }

  if (url.pathname === "/api/progress" && req.method === "GET") {
    return jsonResponse(res, readProgress());
  }
  if (url.pathname === "/api/progress" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const progress = readProgress();
    Object.assign(progress, body);
    writeJsonAtomic(PROGRESS_FILE, progress);
    return jsonResponse(res, { ok: true });
  }

  if (url.pathname === "/api/notes" && req.method === "GET") {
    return jsonResponse(res, readNotes());
  }
  if (url.pathname === "/api/notes" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const notes = readNotes();
    notes[body.key] = { text: String(body.text || ""), updatedAt: Date.now() };
    writeJsonAtomic(NOTES_FILE, notes);
    return jsonResponse(res, { ok: true });
  }

  if (url.pathname === "/api/status") {
    const catalog = getCatalog();
    const progress = readProgress();
    const watched = Object.values(progress).filter(entry => entry.watched).length;
    return jsonResponse(res, {
      ...catalog.stats,
      watched,
      progressEntries: Object.keys(progress).length,
      generatedAt: catalog.generatedAt
    });
  }

  if (url.pathname === "/api/verify") {
    const catalog = getCatalog(true);
    const failures = [];
    let checked = 0;
    for (const course of [...catalog.paths.flatMap(item => item.courses), ...catalog.standalone]) {
      for (const video of course.videos) {
        checked++;
        const file = safeResolve(video.media.replace(/^\/media\//, ""));
        if (!file || !fileExists(file)) {
          failures.push({ course: course.title, video: video.title, error: "missing file" });
          continue;
        }
        try {
          const probe = JSON.parse(execFileSync("ffprobe", [
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,height:stream_tags=language:chapter=id",
            "-of", "json",
            file
          ], { encoding: "utf8" }));
          const videoStream = (probe.streams || []).find(stream => stream.codec_type === "video");
          const subtitles = (probe.streams || []).filter(stream => stream.codec_type === "subtitle");
          if (!videoStream || videoStream.height < 720) {
            failures.push({ course: course.title, video: video.title, error: `height ${videoStream && videoStream.height}` });
          }
          if (!subtitles.length) {
            failures.push({ course: course.title, video: video.title, error: "no subtitle tracks" });
          }
          if (!probe.chapters || !probe.chapters.length) {
            failures.push({ course: course.title, video: video.title, error: "no chapters" });
          }
        } catch (error) {
          failures.push({ course: course.title, video: video.title, error: error.message });
        }
      }
    }
    return jsonResponse(res, { checked, failures, ok: failures.length === 0 });
  }

  if (url.pathname === "/api/anki") {
    const catalog = getCatalog();
    const lines = [];
    const exams = [
      ...catalog.paths.flatMap(item => item.exams),
      ...catalog.standaloneExams
    ];
    for (const exam of exams) {
      if (!exam.json) {
        continue;
      }
      const file = safeResolve(exam.json.replace(/^\/media\//, ""));
      if (!file || !fileExists(file)) {
        continue;
      }
      const data = readJson(file, {});
      for (const question of data.questions || []) {
        const correct = (question.options || []).filter(option => option.isKey).map(option => option.content).join(" | ");
        const rationale = (question.options || []).filter(option => option.isKey).map(option => option.rationale).filter(Boolean).join(" ");
        const front = String(question.stem || "").replace(/\s+/g, " ").trim();
        const back = `${correct}${rationale ? "\n\n" + rationale : ""}`;
        const tags = `Pluralsight ${exam.title}`.replace(/\s+/g, "_");
        lines.push(`${front}\t${back}\t${tags}`);
      }
    }
    const body = lines.join("\n");
    res.writeHead(200, {
      "Content-Type": "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pluralsight-anki.tsv"',
      "Content-Length": Buffer.byteLength(body)
    });
    return res.end(body);
  }

  if (url.pathname === "/api/export/notes.md") {
    const catalog = getCatalog();
    const notes = readNotes();
    const progress = readProgress();
    const titles = new Map();
    for (const course of [...catalog.paths.flatMap(item => item.courses), ...catalog.standalone]) {
      for (const video of course.videos) {
        titles.set(video.id, `${course.title} — ${video.title}`);
      }
    }
    const lines = ["# Pluralsight notes", "", `Generated: ${new Date().toISOString()}`, ""];
    for (const [key, note] of Object.entries(notes)) {
      if (!note.text) {
        continue;
      }
      lines.push(`## ${titles.get(key) || key}`, "", note.text, "");
    }
    lines.push("## Progress", "");
    for (const [key, entry] of Object.entries(progress)) {
      lines.push(`- ${titles.get(key) || key}: ${entry.watched ? "watched" : Math.round(entry.position || 0) + "s"}`);
    }
    const body = lines.join("\n");
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pluralsight-notes.md"',
      "Content-Length": Buffer.byteLength(body)
    });
    return res.end(body);
  }

  if (url.pathname === "/api/subtitles") {
    const file = safeResolve(url.searchParams.get("file") || "");
    if (!file || !fileExists(file)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const data = readJson(file, {});
    const body = transcriptToVtt(data, url.searchParams.get("lang") || "en");
    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache"
    });
    return res.end(body);
  }

  if (url.pathname === "/api/download" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    if (!body.url) {
      return jsonResponse(res, { error: "url is required" }, 400);
    }
    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      url: body.url,
      quality: body.quality || CONFIG.quality || "best",
      subs: body.subs || CONFIG.subs || "all",
      status: "queued",
      createdAt: Date.now(),
      log: []
    };
    jobs.unshift(job);
    startNextJob();
    return jsonResponse(res, { ok: true, job });
  }

  if (url.pathname === "/api/jobs") {
    return jsonResponse(res, jobs.slice(0, 20).map(job => ({
      ...job,
      log: job.log.join("").split("\n").slice(-80).join("\n")
    })));
  }

  res.writeHead(404);
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/portal") {
      return serveFile(req, res, PORTAL_FILE);
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === "/icon.svg") {
      const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><path d="M190 140l190 116-190 116z" fill="#fff"/></svg>`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": Buffer.byteLength(icon) });
      return res.end(icon);
    }

    if (url.pathname === "/manifest.webmanifest") {
      const manifest = {
        name: "Pluralsight Offline",
        short_name: "PS Offline",
        start_url: "/",
        display: "standalone",
        background_color: "#0f1117",
        theme_color: "#0f1117",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }]
      };
      return jsonResponse(res, manifest);
    }

    if (url.pathname === "/app.apk") {
      const apk = path.join(__dirname, "android-app", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
      if (!fileExists(apk)) {
        res.writeHead(404);
        return res.end("APK not found");
      }
      const stat = fs.statSync(apk);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="pluralsight-offline.apk"',
        "Content-Length": stat.size,
        "Cache-Control": "no-cache"
      });
      return fs.createReadStream(apk).pipe(res);
    }

    if (url.pathname.startsWith("/media/")) {
      const file = safeResolve(url.pathname.slice("/media/".length));
      if (!file) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      return serveFile(req, res, file);
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server error: " + error.message);
  }
});

server.listen(PORT, HOST, () => {
  const addresses = ["http://localhost:" + PORT];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(`http://${entry.address}:${PORT}`);
      }
    }
  }
  console.log("Pluralsight portal running:");
  for (const address of addresses) {
    console.log("  " + address);
  }
  console.log(`Content root: ${ROOT}`);
});

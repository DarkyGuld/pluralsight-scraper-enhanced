const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const pluginStealth = require('puppeteer-extra-plugin-stealth');
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fetch = require("node-fetch");
const MarkdownIt = require("markdown-it");
const metadata = require("./metadata");
const mdRenderer = new MarkdownIt({ html: false, linkify: true });

const CONFIG = metadata.loadConfig(path.join(__dirname, "config.json"));
let OUTPUT_ROOT = path.resolve(__dirname, CONFIG.outputDir);

const SUBTITLE_LANGUAGES = {
    en: { iso: "eng", label: "English" },
    de: { iso: "deu", label: "Deutsch" },
    es: { iso: "spa", label: "Español" },
    fr: { iso: "fra", label: "Français" },
    "fr-CA": { iso: "fra", label: "Français (Canada)" },
    pt: { iso: "por", label: "Português" },
    "pt-BR": { iso: "por", label: "Português (Brasil)" },
    it: { iso: "ita", label: "Italiano" },
    nl: { iso: "nld", label: "Nederlands" },
    pl: { iso: "pol", label: "Polski" },
    tr: { iso: "tur", label: "Türkçe" },
    ru: { iso: "rus", label: "Русский" },
    ja: { iso: "jpn", label: "日本語" },
    ko: { iso: "kor", label: "한국어" },
    hi: { iso: "hin", label: "हिन्दी" },
    "zh-Hans": { iso: "zho", label: "中文（简体）" },
    "zh-Hant": { iso: "zho", label: "中文（繁體）" },
    ar: { iso: "ara", label: "العربية" }
};

const SUBTITLE_ALIASES = {};
for (const [code, info] of Object.entries(SUBTITLE_LANGUAGES)) {
    const aliases = new Set([code.toLowerCase(), info.iso.toLowerCase()]);
    SUBTITLE_ALIASES[code.toLowerCase()] = aliases;
    SUBTITLE_ALIASES[info.iso.toLowerCase()] = aliases;
}

function languageMatches(requested, actual) {
    const requestedCode = String(requested || "").toLowerCase();
    const actualCode = String(actual || "").toLowerCase();
    if (!requestedCode || !actualCode) {
        return false;
    }
    if (requestedCode === actualCode) {
        return true;
    }
    const aliases = SUBTITLE_ALIASES[requestedCode];
    return !!(aliases && aliases.has(actualCode));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function courseIdFromUrl(url) {
    return /library\/courses\/([a-z0-9\-]+)/gi.exec(url)[1];
}


async function downloadCourse(courseId, cookie) {
    async function getVideoUrl(clipId) {
        let clipData = await fetch("https://app.pluralsight.com/video/clips/v3/viewclip", {
            "headers": {
                "Content-Type": "application/json",
                cookie
            },
            "body": JSON.stringify({ "clipId": clipId, "mediaType": "mp4", "quality": "1280x720", "online": true, "boundedContext": "course", "versionId": "" }),
            "method": "POST"
        }).then((response) => response.json());

        return clipData.urls[0].url;
    }

    const courseData = await fetch("https://app.pluralsight.com/learner/content/courses/" + courseId, {
        headers: { cookie }
    }).then((response) => response.json());

    let videos = courseData.modules
        // Get video items
        .map(module => module.clips)
        // Flatten from module structure
        .reduce((a, b) => [...a, ...b], [])
        // Reformat a bit, get rid of all the unncessary information, generate title
        .map(async (video, index) => {
            // Wait 137 seconds after each request to avoid throttling
            await wait(137000 * index);
            // Add numbering for proper sequencing
            // Strip title of illegal chars
            const title = `${index + 1}. ${video.title.trim().replace(/[:?*'|&;$%@"<>()+,\/]/g, "")}`;

            console.log(`Retrieving metadata for: ${title}`);

            // Get video url
            const url = await getVideoUrl(video.clipId);

            return {
                title,
                url
            };
        });

    const videoFeed = {
        [Symbol.asyncIterator]() {
            return {
                index: 0,
                async next() {
                    return { value: (await videos[this.index++]), done: this.index - 1 == videos.length };
                }
            };
        }
    };

    const videoPath = OUTPUT_ROOT;
    const coursePath = path.join(videoPath, courseId.replace(/[:?*'|&;$%@"<>()+,\/]/g, ""));

    if (!fs.existsSync(videoPath)) {
        fs.mkdirSync(videoPath);
    }
    if (!fs.existsSync(coursePath)) {
        fs.mkdirSync(coursePath);
    }

    for await (let video of videoFeed) {
        const file = path.join(coursePath, video.title + ".mp4");

        if (!fs.existsSync(file)) {
            console.log(`Downloading video file for: ${video.title + ".mp4"}`);
            const data = await fetch(video.url);
            const fileStream = fs.createWriteStream(file);
            data.body.pipe(fileStream);
        }
    }


}

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

function ilxSlugFromUrl(url) {
    return decodeURIComponent(/\/ilx\/([^/?#]+)/.exec(url)[1]);
}

function isIlxUrl(url) {
    return /\/ilx\//.test(url);
}

function sanitizeTitle(title) {
    return title.trim().replace(/[:?*'|&;$%@"<>()+,\/#\\]/g, "").replace(/\s+/g, " ");
}

function ilxHeaders(cookie) {
    return {
        "Content-Type": "application/json",
        "cookie": cookie,
        "User-Agent": USER_AGENT,
        "Origin": "https://app.pluralsight.com",
        "Referer": "https://app.pluralsight.com/ilx/",
        "x-team": "video-services"
    };
}

async function ilxGraphQL(cookie, query, operationName, variables) {
    const response = await fetch("https://app.pluralsight.com/ilx/course-builder/api/graphql", {
        method: "POST",
        headers: ilxHeaders(cookie),
        body: JSON.stringify({ query, operationName, variables })
    });

    if (!response.ok) {
        throw new Error(`GraphQL request failed with HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.errors && result.errors.length) {
        throw new Error(result.errors.map(error => error.message).join("; "));
    }

    return result.data;
}

async function getIlxDelivery(cookie, clipId, versionId, boundedContext = "ilx") {
    const response = await fetch(`https://app.pluralsight.com/video/delivery/api/v1/clips/${clipId}/versions/${versionId}`, {
        method: "POST",
        headers: ilxHeaders(cookie),
        body: JSON.stringify({ online: true, boundedContext, preferredAudioLanguage: "en" })
    });

    if (!response.ok) {
        throw new Error(`Delivery API failed with HTTP ${response.status}`);
    }

    return response.json();
}

async function getIlxVideoUrl(cookie, clipId, versionId, quality = 720, boundedContext = "ilx") {
    const data = await getIlxDelivery(cookie, clipId, versionId, boundedContext);
    const mp4s = (data.renditions || []).filter(rendition => rendition.format === "mp4");
    const english = mp4s.filter(rendition => rendition.languageCode === "en");
    const candidates = english.length ? english : mp4s;

    const exact = candidates.find(rendition => rendition.height === quality);
    const lower = candidates
        .filter(rendition => rendition.height && rendition.height <= quality)
        .sort((a, b) => b.height - a.height)[0];
    const best = exact || lower || candidates.sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    if (!best) {
        throw new Error("No MP4 rendition available for this clip");
    }

    return best.urls[0].url;
}

function normalizeQuality(quality) {
    const value = String(quality || "best").toLowerCase();
    if (["best", "max", "highest"].includes(value)) {
        return "best";
    }
    if (["1080", "1080p"].includes(value)) {
        return 1080;
    }
    if (["720", "720p"].includes(value)) {
        return 720;
    }
    throw new Error(`Invalid quality "${quality}". Use 720, 1080 or best.`);
}

function parseSubtitleSelection(value) {
    const raw = String(value || "all").trim();
    if (raw.toLowerCase() === "all") {
        return null;
    }
    if (raw.toLowerCase() === "none") {
        return [];
    }
    return raw.split(",").map(language => language.trim()).filter(Boolean);
}

async function withRetry(label, operation, attempts) {
    const tries = Math.max(1, Number(attempts) || 1);
    let lastError;

    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt < tries) {
                const delay = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
                console.error(`${label} failed (attempt ${attempt}/${tries}), retrying in ${Math.round(delay / 1000)}s: ${error.message}`);
                await wait(delay);
            }
        }
    }

    throw lastError;
}

function resolveOutputDir(value) {
    const expanded = String(value || "videos").replace(/^~(?=$|\/|\\)/, os.homedir());
    return path.resolve(__dirname, expanded);
}

async function getIlxHlsUrl(cookie, clipId, versionId, boundedContext = "ilx") {
    const data = await getIlxDelivery(cookie, clipId, versionId, boundedContext);
    const hls = (data.renditions || []).filter(rendition => rendition.format === "m3u8");
    const english = hls.filter(rendition => rendition.languageCode === "en");
    const chosen = english[0] || hls[0];

    if (!chosen) {
        throw new Error("No HLS rendition available for this clip");
    }

    return chosen.urls[0].url;
}

function parseHlsVariants(manifest) {
    const lines = manifest.split(/\r?\n/);
    const variants = [];
    let program = -1;

    for (const line of lines) {
        if (!line.startsWith("#EXT-X-STREAM-INF:")) {
            continue;
        }
        program++;
        const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
        const bandwidth = /BANDWIDTH=(\d+)/.exec(line);
        variants.push({
            program,
            width: resolution ? parseInt(resolution[1], 10) : 0,
            height: resolution ? parseInt(resolution[2], 10) : 0,
            bandwidth: bandwidth ? parseInt(bandwidth[1], 10) : 0
        });
    }

    return variants;
}

async function getHlsVariant(cookie, manifestUrl, quality) {
    const response = await fetch(manifestUrl, {
        headers: {
            "User-Agent": USER_AGENT,
            "cookie": cookie
        }
    });

    if (!response.ok) {
        throw new Error(`HLS manifest failed with HTTP ${response.status}`);
    }

    const variants = parseHlsVariants(await response.text()).filter(variant => variant.height > 0);
    if (!variants.length) {
        throw new Error("No HLS variants found");
    }

    const allowed = quality === "best"
        ? variants
        : variants.filter(variant => variant.height <= quality);
    const candidates = allowed.length ? allowed : variants;
    candidates.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));

    return {
        manifestUrl,
        ...candidates[0]
    };
}

function getVideoHeight(file) {
    try {
        const output = execFileSync("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=height",
            "-of", "csv=p=0",
            file
        ], { encoding: "utf8" });
        return parseInt(output.trim(), 10) || 0;
    } catch (error) {
        return 0;
    }
}

function downloadHlsClip(manifestUrl, program, file) {
    const partFile = file + ".part.mp4";
    const args = [
        "-y", "-loglevel", "error", "-nostdin",
        "-user_agent", USER_AGENT,
        "-i", manifestUrl,
        "-map", `0:p:${program}`,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        partFile
    ];

    try {
        execFileSync("ffmpeg", args, { stdio: "pipe", timeout: 30 * 60 * 1000 });
        fs.renameSync(partFile, file);
    } catch (error) {
        if (fs.existsSync(partFile)) {
            fs.unlinkSync(partFile);
        }
        throw new Error(`ffmpeg HLS download failed: ${String(error.stderr || error.message).slice(0, 500)}`);
    }
}

async function downloadFile(url, file) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}`);
    }

    const partFile = file + ".part";
    try {
        await new Promise((resolve, reject) => {
            const fileStream = fs.createWriteStream(partFile);
            response.body.pipe(fileStream);
            response.body.on("error", reject);
            fileStream.on("finish", resolve);
            fileStream.on("error", reject);
        });
        fs.renameSync(partFile, file);
    } catch (error) {
        if (fs.existsSync(partFile)) {
            fs.unlinkSync(partFile);
        }
        throw error;
    }
}

async function getIlxTranscription(cookie, experienceId, languageCode, isVideoCourse = false) {
    const query = `query Transcription($experienceId: ID!, $isVideoCourse: Boolean, $languageCode: String) {
        transcription(experienceId: $experienceId, isVideoCourse: $isVideoCourse, languageCode: $languageCode) {
            modules {
                clips {
                    id
                    title
                    segments {
                        text
                        displayTime
                    }
                }
            }
        }
    }`;

    const data = await ilxGraphQL(cookie, query, "Transcription", {
        experienceId,
        isVideoCourse,
        languageCode
    });
    return data.transcription;
}

function formatSrtTime(seconds) {
    const total = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const secs = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function transcriptionToSrt(segments, duration) {
    const sorted = segments
        .slice()
        .sort((a, b) => Number(a.displayTime) - Number(b.displayTime));
    const lines = [];
    let cue = 1;

    for (let index = 0; index < sorted.length; index++) {
        const segment = sorted[index];
        const text = String(segment.text || "").trim();
        if (!text) {
            continue;
        }

        const start = Number(segment.displayTime) || 0;
        const next = sorted[index + 1];
        let end;
        if (next) {
            end = Number(next.displayTime) || start + 0.5;
        } else {
            const estimated = Math.max(2, Math.min(8, text.split(/\s+/).length / 2.5));
            end = start + estimated;
        }
        if (duration && end > Number(duration)) {
            end = Number(duration);
        }
        if (end <= start) {
            end = start + 0.5;
        }

        lines.push(String(cue++), `${formatSrtTime(start)} --> ${formatSrtTime(end)}`, text, "");
    }

    return lines.join("\n");
}

async function getCourseTranscriptions(cookie, experienceId, firstClip, selection, isVideoCourse = false) {
    let detected = ["en"];
    try {
        const delivery = await getIlxDelivery(cookie, firstClip.clipId, firstClip.versionId, isVideoCourse ? "course" : "ilx");
        const languages = [...new Set((delivery.renditions || []).map(rendition => rendition.languageCode).filter(Boolean))];
        if (languages.length) {
            detected = languages;
        }
    } catch (error) {
        console.error(`Could not detect subtitle languages: ${error.message}`);
    }

    let requested;
    if (selection === null) {
        requested = detected.slice();
    } else if (selection.length === 0) {
        requested = [];
    } else {
        requested = selection.slice();
    }

    // Always fetch English for transcripts and search
    const languages = [];
    for (const language of ["en", ...requested]) {
        if (!languages.some(existing => languageMatches(existing, language))) {
            languages.push(language);
        }
    }

    const tracks = {};
    for (const language of languages) {
        try {
            const transcription = await getIlxTranscription(cookie, experienceId, language, isVideoCourse);
            const clips = {};
            for (const module of (transcription && transcription.modules) || []) {
                for (const clip of module.clips || []) {
                    if (clip.segments && clip.segments.length) {
                        clips[clip.id] = clip.segments;
                    }
                }
            }
            if (Object.keys(clips).length) {
                tracks[language] = clips;
            }
        } catch (error) {
            console.error(`Could not fetch ${language} subtitles: ${error.message}`);
        }
    }

    return tracks;
}

function filterSubtitleTracks(tracks, selection) {
    if (selection === null) {
        return tracks;
    }
    if (!selection.length) {
        return {};
    }

    const filtered = {};
    for (const [language, clips] of Object.entries(tracks)) {
        if (selection.some(requested => languageMatches(requested, language))) {
            filtered[language] = clips;
        }
    }
    return filtered;
}

async function getCourseResources(cookie, experienceId) {
    const query = `query Resources($experienceId: ID!, $page: Int!, $perPage: Int!, $sortField: String, $sortDirection: String) {
        resources(experienceId: $experienceId, page: $page, perPage: $perPage, sortField: $sortField, sortDirection: $sortDirection) {
            count
            data {
                resourceType
                title
                url
                filename
                type
                userId
                contentId
                parent
            }
        }
    }`;

    const data = await ilxGraphQL(cookie, query, "Resources", {
        experienceId,
        page: 1,
        perPage: 200,
        sortField: null,
        sortDirection: null
    });

    return (data.resources && data.resources.data) || [];
}

function writeClipTranscript(directory, title, segments) {
    const text = segments.map(segment => String(segment.text || "").trim()).filter(Boolean).join(" ").trim();
    if (!text) {
        return { text: "", file: null };
    }
    const file = path.join(directory, title + ".txt");
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, text + "\n");
    }
    return { text, file };
}

async function downloadResourceFile(resource, directory, retries) {
    if (!resource.url || resource.resourceType !== "FILE") {
        return null;
    }

    let urlName = "";
    try {
        urlName = path.basename(new URL(resource.url).pathname);
    } catch (error) {
        urlName = "";
    }

    const filename = sanitizeTitle(resource.filename || urlName || resource.title || "resource");
    if (!filename) {
        return null;
    }

    const file = path.join(directory, filename);
    if (fs.existsSync(file)) {
        return file;
    }

    try {
        await withRetry(`Resource "${resource.title}"`, () => downloadFile(resource.url, file), retries);
        return file;
    } catch (error) {
        console.error(`Could not download resource "${resource.title}": ${error.message}`);
        return null;
    }
}

async function writeCourseResources(coursePath, resources, retries) {
    if (!resources.length) {
        return { items: [] };
    }

    const resourcesDirectory = path.join(coursePath, "resources");
    fs.mkdirSync(resourcesDirectory, { recursive: true });
    fs.writeFileSync(path.join(coursePath, "resources.json"), JSON.stringify(resources, null, 2));

    const items = [];
    const lines = ["# Resources", ""];

    for (const resource of resources) {
        const title = resource.title || resource.filename || "Resource";
        let href = resource.url;
        let external = true;

        if (resource.resourceType === "FILE") {
            const file = await downloadResourceFile(resource, resourcesDirectory, retries);
            if (file) {
                href = path.relative(coursePath, file);
                external = false;
            }
        }

        if (!href) {
            continue;
        }

        lines.push(`- [${title}](${href})`);
        items.push({
            type: "resource",
            title,
            subtitle: resource.resourceType || "Resource",
            text: title,
            href,
            external,
            duration: 0,
            course: ""
        });
    }

    fs.writeFileSync(path.join(coursePath, "resources.md"), lines.join("\n") + "\n");
    return { items };
}

async function downloadPoster(coursePath, posterUrl, retries) {
    if (!posterUrl) {
        return null;
    }

    const existing = ["poster.jpg", "poster.png", "folder.jpg", "folder.png"]
        .map(name => path.join(coursePath, name))
        .find(file => fs.existsSync(file));
    if (existing) {
        return existing;
    }

    try {
        return await withRetry("Poster", async () => {
            const response = await fetch(posterUrl, { headers: { "User-Agent": USER_AGENT } });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const contentType = response.headers.get("content-type") || "";
            const extension = contentType.includes("png") ? "png" : "jpg";
            const file = path.join(coursePath, `poster.${extension}`);
            fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
            return file;
        }, retries);
    } catch (error) {
        console.error(`Could not download poster: ${error.message}`);
        return null;
    }
}

function hasSubtitleStream(file) {
    try {
        const output = execFileSync("ffprobe", [
            "-v", "error",
            "-select_streams", "s",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            file
        ], { encoding: "utf8" });
        return output.trim().length > 0;
    } catch (error) {
        return false;
    }
}

function embedSubtitles(videoFile, subtitleFiles) {
    const tempFile = videoFile + ".subtitles.mp4";
    const args = ["-y", "-loglevel", "error", "-i", videoFile];

    for (const subtitle of subtitleFiles) {
        args.push("-i", subtitle.file);
    }
    args.push("-map", "0");
    for (let index = 0; index < subtitleFiles.length; index++) {
        args.push("-map", String(index + 1));
    }
    args.push("-c", "copy", "-c:s", "mov_text");
    for (let index = 0; index < subtitleFiles.length; index++) {
        args.push(`-metadata:s:s:${index}`, `language=${subtitleFiles[index].iso}`);
        args.push(`-metadata:s:s:${index}`, `handler_name=${subtitleFiles[index].label}`);
    }
    args.push(tempFile);

    try {
        execFileSync("ffmpeg", args, { stdio: "pipe" });
        fs.renameSync(tempFile, videoFile);
    } catch (error) {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        throw new Error(`ffmpeg failed: ${error.message}`);
    }
}

function prepareSubtitleFiles(videoFile, clip, subtitleTracks) {
    const subtitleFiles = [];
    const baseName = path.basename(videoFile, path.extname(videoFile));
    const directory = path.dirname(videoFile);

    for (const [language, clips] of Object.entries(subtitleTracks)) {
        const segments = clips[clip.clipId];
        if (!segments || !segments.length) {
            continue;
        }
        const info = SUBTITLE_LANGUAGES[language] || { iso: language.slice(0, 3), label: language };
        const srtFile = path.join(directory, `${baseName}.${language}.srt`);
        if (!fs.existsSync(srtFile)) {
            fs.writeFileSync(srtFile, transcriptionToSrt(segments, clip.duration));
        }
        subtitleFiles.push({ file: srtFile, iso: info.iso, label: info.label });
    }

    return subtitleFiles;
}

function addSubtitlesToVideo(videoFile, clip, subtitleTracks, keepSrt = false) {
    const alreadyEmbedded = hasSubtitleStream(videoFile);
    if (alreadyEmbedded && !keepSrt) {
        return { embedded: false, languages: [], files: [] };
    }

    const subtitleFiles = prepareSubtitleFiles(videoFile, clip, subtitleTracks);

    if (!subtitleFiles.length) {
        return { embedded: false, languages: [], files: [] };
    }
    if (alreadyEmbedded) {
        return { embedded: false, languages: subtitleFiles.map(subtitle => subtitle.label), files: subtitleFiles };
    }

    embedSubtitles(videoFile, subtitleFiles);
    return { embedded: true, languages: subtitleFiles.map(subtitle => subtitle.label), files: subtitleFiles };
}

function removeSubtitleFiles(subtitleFiles) {
    for (const subtitle of subtitleFiles) {
        if (fs.existsSync(subtitle.file)) {
            fs.unlinkSync(subtitle.file);
        }
    }
}

function trimSubtitleTracks(videoFile, selection) {
    if (selection === null) {
        return false;
    }

    let probe;
    try {
        probe = JSON.parse(execFileSync("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=index,codec_type:stream_tags=language",
            "-of", "json",
            videoFile
        ], { encoding: "utf8" }));
    } catch (error) {
        return false;
    }

    const streams = probe.streams || [];
    const subtitleStreams = streams.filter(stream => stream.codec_type === "subtitle");
    if (!subtitleStreams.length) {
        return false;
    }

    const desired = subtitleStreams.filter(stream => {
        if (!selection.length) {
            return false;
        }
        const language = (stream.tags && stream.tags.language) || "";
        return selection.some(requested => languageMatches(requested, language));
    });

    if (desired.length === subtitleStreams.length) {
        return false;
    }

    const tempFile = videoFile + ".trim.mp4";
    const args = ["-y", "-loglevel", "error", "-i", videoFile];
    for (const stream of streams) {
        if (stream.codec_type === "subtitle" && !desired.includes(stream)) {
            continue;
        }
        args.push("-map", `0:${stream.index}`);
    }
    args.push("-c", "copy", "-map_chapters", "0", tempFile);

    try {
        execFileSync("ffmpeg", args, { stdio: "pipe", timeout: 10 * 60 * 1000 });
        fs.renameSync(tempFile, videoFile);
        return true;
    } catch (error) {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        throw new Error(`Could not trim subtitle tracks: ${String(error.stderr || error.message).slice(0, 300)}`);
    }
}

async function getLegacyCourse(cookie, slug) {
    const response = await fetch(`https://app.pluralsight.com/learner/content/courses/${slug}`, {
        headers: {
            "cookie": cookie,
            "User-Agent": USER_AGENT,
            "Origin": "https://app.pluralsight.com",
            "Referer": `https://app.pluralsight.com/library/courses/${slug}/table-of-contents`
        }
    });

    if (!response.ok) {
        throw new Error(`Legacy course API failed with HTTP ${response.status}`);
    }

    return response.json();
}

async function getVideoCourse(cookie, clipId) {
    const query = `query VideoCourseByClipId($clipId: String!) {
        videoCourseByClipId(clipId: $clipId) {
            courseId
            title
            shortDescription
            longDescription
            status
            level
            availableLanguages
            updatedAt
            publishedDate
            authors {
                displayName
            }
            paths {
                pathId
                pathTitle
                urlSlug
            }
            modules {
                moduleId
                title
                order
                duration
                clips {
                    clipId
                    title
                    order
                    duration
                    version
                    type
                    source
                    url
                    replacementClipId
                    description
                    isAuthorized
                    watched
                }
            }
        }
    }`;

    const data = await ilxGraphQL(cookie, query, "VideoCourseByClipId", { clipId });
    return data.videoCourseByClipId;
}

async function downloadVideoCourse(course, cookie, options = {}, coursePath = null, courseMeta = {}) {
    const retries = Number(options.retries ?? CONFIG.retries);
    const legacy = await withRetry(`Fetching legacy course ${course.slug}`, () => getLegacyCourse(cookie, course.slug), retries);
    const legacyClips = (legacy.modules || []).flatMap(module => module.clips || []);
    const firstClip = legacyClips.find(clip => clip.trailer === false) || legacyClips[0];

    if (!firstClip) {
        throw new Error("No clips found in video course");
    }

    const videoCourse = await withRetry(`Fetching video course ${course.title}`, () => getVideoCourse(cookie, firstClip.clipId), retries);
    if (!videoCourse) {
        throw new Error("Video course not found");
    }

    const clips = [];
    for (const module of videoCourse.modules || []) {
        for (const clip of module.clips || []) {
            if (clip.type !== "clip" || !clip.version) {
                continue;
            }
            clips.push({
                module: module.title,
                title: clip.title,
                clipId: clip.clipId,
                versionId: clip.version,
                duration: clip.duration
            });
        }
    }

    const preloadedCourse = {
        id: videoCourse.courseId,
        slug: course.slug || videoCourse.courseId,
        title: videoCourse.title,
        description: videoCourse.longDescription || videoCourse.shortDescription || "",
        updatedAt: videoCourse.updatedAt
    };

    return downloadIlxCourse(course.slug || videoCourse.courseId, cookie, options, coursePath, {
        posterUrl: courseMeta.posterUrl || course.posterUrl,
        description: courseMeta.description || preloadedCourse.description,
        updatedAt: courseMeta.updatedAt || preloadedCourse.updatedAt
    }, {
        course: preloadedCourse,
        clips,
        isVideoCourse: true
    });
}

async function downloadIlxCourse(slug, cookie, options = {}, coursePath = null, courseMeta = {}, preloaded = null) {
    const delaySeconds = Number(options.delay ?? CONFIG.delay);
    const requestedQuality = normalizeQuality(options.quality ?? CONFIG.quality);
    const keepSrt = !!options.keepSrt;
    const retries = Number(options.retries ?? CONFIG.retries);
    const subtitleSelection = parseSubtitleSelection(options.subs ?? CONFIG.subs);
    const wantChapters = options.chapters !== false;
    const wantResources = options.resources !== false;
    const wantTranscripts = options.transcripts !== false;
    const wantNfo = options.nfo !== false;
    const wantPoster = options.poster !== false;
    const wantPlaylist = options.playlist !== false;
    const wantIndex = options.index !== false;
    const wantThumbnails = options.thumbnails !== false;
    const wantTvLayout = options.tvLayout !== false;

    let course;
    let clips = [];
    let isVideoCourse = false;

    if (preloaded) {
        course = preloaded.course;
        clips = preloaded.clips || [];
        isVideoCourse = !!preloaded.isVideoCourse;
    } else {
        const query = `query Experience($idOrSlug: String!) {
            experienceBySlug: experience(idOrSlug: $idOrSlug) {
                id
                slug
                title
                description
                updatedAt: contentUpdatedAt
                segments {
                    title
                    segmentContent {
                        content {
                            id
                            title
                            type
                            duration
                            extra
                        }
                    }
                }
            }
        }`;

        const data = await withRetry(`Fetching course ${slug}`, () => ilxGraphQL(cookie, query, "Experience", { idOrSlug: slug }), retries);
        course = data.experienceBySlug;

        if (!course) {
            throw new Error("Course not found");
        }

        for (const module of course.segments || []) {
            for (const item of module.segmentContent || []) {
                const content = item.content;
                const version = content && content.extra && content.extra.version;
                if (!content || content.type !== "clip" || !version) {
                    continue;
                }
                clips.push({
                    module: module.title,
                    title: content.title,
                    clipId: content.id,
                    versionId: version.id,
                    duration: content.duration
                });
            }
        }
    }

    console.log(`Course: ${course.title} (${clips.length} clips)`);

    coursePath = coursePath || path.join(OUTPUT_ROOT, sanitizeTitle(slug));
    fs.mkdirSync(coursePath, { recursive: true });

    const manifestFile = path.join(coursePath, "manifest.json");
    let previousManifest = {};
    try {
        if (fs.existsSync(manifestFile)) {
            previousManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        }
    } catch (error) {
        previousManifest = {};
    }
    const previousClips = new Map(((previousManifest && previousManifest.clips) || []).map(clip => [clip.clipId, clip]));

    let transcriptionTracks = {};
    let subtitleTracks = {};
    if (clips.length && (subtitleSelection === null || subtitleSelection.length > 0 || wantTranscripts)) {
        console.log("Fetching subtitles and transcripts...");
        transcriptionTracks = await withRetry("Fetching transcriptions", () => getCourseTranscriptions(cookie, course.id, clips[0], subtitleSelection, isVideoCourse), retries);
        subtitleTracks = filterSubtitleTracks(transcriptionTracks, subtitleSelection);
        const subtitleLanguages = Object.keys(subtitleTracks);
        console.log(subtitleLanguages.length
            ? `Subtitles: ${subtitleLanguages.join(", ")}`
            : "No subtitles selected or available.");
    }

    const transcriptsDirectory = path.join(coursePath, "transcripts");
    if (wantTranscripts) {
        fs.mkdirSync(transcriptsDirectory, { recursive: true });
    }
    const thumbnailsDirectory = path.join(coursePath, "thumbnails");
    if (wantThumbnails) {
        fs.mkdirSync(thumbnailsDirectory, { recursive: true });
    }
    const transcriptLines = [];

    let resourceItems = [];
    if (wantResources) {
        try {
            const resources = await withRetry("Fetching resources", () => getCourseResources(cookie, course.id), retries);
            const result = await writeCourseResources(coursePath, resources, retries);
            resourceItems = result.items;
            console.log(`Resources: ${resources.length}`);
        } catch (error) {
            console.error(`Could not fetch resources: ${error.message}`);
        }
    }

    if (wantPoster && courseMeta.posterUrl) {
        await downloadPoster(coursePath, courseMeta.posterUrl, retries);
    }

    const manifestClips = [];
    const playlistEntries = [];
    const catalogItems = [];
    const courseDescription = courseMeta.description || course.description || "";
    const year = String(courseMeta.updatedAt || course.updatedAt || "").slice(0, 4);

    for (let index = 0; index < clips.length; index++) {
        const clip = clips[index];
        const title = `${index + 1}. ${sanitizeTitle(clip.title)}`;
        const file = path.join(coursePath, title + ".mp4");
        const exists = fs.existsSync(file);
        const currentHeight = exists ? getVideoHeight(file) : 0;
        const previousClip = previousClips.get(clip.clipId);
        const versionChanged = !!(previousClip && previousClip.versionId !== clip.versionId);
        const stale = !!(previousClip && previousClip.stale);

        let needsDownload = !exists || versionChanged || stale;
        let hls = null;

        if (exists && !needsDownload) {
            if (requestedQuality === 720) {
                needsDownload = currentHeight < 720;
            } else {
                const targetHeight = requestedQuality === "best" ? 1080 : requestedQuality;
                if (currentHeight < targetHeight) {
                    try {
                        const hlsUrl = await getIlxHlsUrl(cookie, clip.clipId, clip.versionId, isVideoCourse ? "course" : "ilx");
                        hls = await getHlsVariant(cookie, hlsUrl, requestedQuality);
                        needsDownload = hls.height > currentHeight;
                    } catch (error) {
                        console.error(`Could not check higher quality for ${title}: ${error.message}`);
                    }
                }
            }
        }

        let downloadFailed = false;

        if (needsDownload) {
            if (index > 0 && delaySeconds > 0) {
                console.log(`Waiting ${delaySeconds}s before the next request...`);
                await wait(delaySeconds * 1000);
            }

            console.log(`[${index + 1}/${clips.length}] ${clip.module} - ${clip.title}`);
            const tempFile = file + ".download.mp4";

            try {
                if (requestedQuality === 720) {
                    const url = await withRetry(`Metadata for ${title}`, () => getIlxVideoUrl(cookie, clip.clipId, clip.versionId, 720, isVideoCourse ? "course" : "ilx"), retries);
                    console.log(`Downloading: ${title}.mp4 (720p)`);
                    await withRetry(`Download ${title}`, () => downloadFile(url, tempFile), retries);
                } else {
                    if (!hls) {
                        const hlsUrl = await withRetry(`HLS metadata for ${title}`, () => getIlxHlsUrl(cookie, clip.clipId, clip.versionId, isVideoCourse ? "course" : "ilx"), retries);
                        hls = await getHlsVariant(cookie, hlsUrl, requestedQuality);
                    }
                    console.log(`Downloading: ${title}.mp4 (${hls.height}p HLS)`);
                    await withRetry(`HLS download ${title}`, () => downloadHlsClip(hls.manifestUrl, hls.program, tempFile), retries);
                }

                const actualDuration = metadata.getVideoDuration(tempFile);
                const expectedDuration = Number(clip.duration) || 0;
                if (actualDuration <= 0 || (expectedDuration > 0 && Math.abs(actualDuration - expectedDuration) > Math.max(5, expectedDuration * 0.03))) {
                    throw new Error(`duration check failed (got ${actualDuration.toFixed(1)}s, expected ${expectedDuration.toFixed(1)}s)`);
                }

                const subtitleFiles = prepareSubtitleFiles(file, clip, subtitleTracks);
                if (subtitleFiles.length && !hasSubtitleStream(tempFile)) {
                    embedSubtitles(tempFile, subtitleFiles);
                }
                fs.renameSync(tempFile, file);
                if (!keepSrt && subtitleFiles.length) {
                    removeSubtitleFiles(subtitleFiles);
                }
                console.log(`Saved: ${title}.mp4 (${hls ? hls.height + "p" : "720p"})`);
            } catch (error) {
                downloadFailed = true;
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
                console.error(`Could not download ${title}.mp4: ${error.message}`);
            }
        } else {
            console.log(`Skipping existing file: ${title}.mp4 (${currentHeight}p)`);
        }

        if (fs.existsSync(file) && Object.keys(subtitleTracks).length) {
            try {
                const result = addSubtitlesToVideo(file, clip, subtitleTracks, keepSrt);
                if (result.embedded) {
                    console.log(`Embedded subtitles: ${result.languages.join(", ")}`);
                }
                if (!keepSrt && result.files.length) {
                    removeSubtitleFiles(result.files);
                }
            } catch (error) {
                console.error(`Could not embed subtitles in ${title}.mp4: ${error.message}`);
            }
        }

        if (fs.existsSync(file) && subtitleSelection !== null) {
            try {
                if (trimSubtitleTracks(file, subtitleSelection)) {
                    console.log(`Trimmed subtitle tracks: ${title}`);
                }
            } catch (error) {
                console.error(`Could not trim subtitle tracks in ${title}.mp4: ${error.message}`);
            }
        }

        if (fs.existsSync(file) && wantChapters) {
            try {
                if (metadata.addChapters(file, `${clip.module} - ${clip.title}`, clip.duration)) {
                    console.log(`Added chapter: ${title}`);
                }
            } catch (error) {
                console.error(`Could not add chapters to ${title}.mp4: ${error.message}`);
            }
        }

        if (fs.existsSync(file) && wantNfo) {
            try {
                metadata.writeNfo(file, {
                    title: clip.title,
                    module: clip.module,
                    courseTitle: course.title,
                    duration: clip.duration,
                    description: courseDescription,
                    year
                });
            } catch (error) {
                console.error(`Could not write NFO for ${title}: ${error.message}`);
            }
        }

        let transcriptText = "";
        let transcriptFile = null;
        let transcriptJson = null;
        if (wantTranscripts && fs.existsSync(file)) {
            const transcriptData = {};
            for (const [language, languageClips] of Object.entries(transcriptionTracks)) {
                const segments = languageClips[clip.clipId];
                if (segments && segments.length) {
                    transcriptData[language] = segments
                        .map(segment => ({
                            start: Number(segment.displayTime) || 0,
                            text: String(segment.text || "").trim()
                        }))
                        .filter(segment => segment.text);
                }
            }
            if (Object.keys(transcriptData).length) {
                const transcriptJsonFile = path.join(transcriptsDirectory, title + ".json");
                fs.writeFileSync(transcriptJsonFile, JSON.stringify(transcriptData, null, 2));
                transcriptJson = path.relative(coursePath, transcriptJsonFile);
            }

            const english = transcriptionTracks.en && transcriptionTracks.en[clip.clipId];
            const fallback = english || Object.values(transcriptionTracks).map(track => track[clip.clipId]).find(Boolean);
            if (fallback) {
                const written = writeClipTranscript(transcriptsDirectory, title, fallback);
                transcriptText = written.text;
                transcriptFile = written.file;
                if (transcriptText) {
                    transcriptLines.push(`## ${title}`, "", transcriptText, "");
                }
            }
        }

        let thumbnail = null;
        if (wantThumbnails && fs.existsSync(file)) {
            const thumbnailFile = path.join(thumbnailsDirectory, title + ".jpg");
            const generated = metadata.generateThumbnail(file, thumbnailFile, clip.duration);
            if (generated) {
                thumbnail = path.relative(coursePath, generated);
            }
        }

        if (fs.existsSync(file)) {
            const duration = Number(clip.duration) || metadata.getVideoDuration(file);
            const manifestClip = {
                index: index + 1,
                module: clip.module,
                title: clip.title,
                file: path.basename(file),
                clipId: clip.clipId,
                versionId: clip.versionId,
                duration,
                height: getVideoHeight(file),
                subtitles: metadata.getSubtitleLanguages(file),
                transcript: transcriptFile ? path.basename(transcriptFile) : null,
                transcriptJson,
                thumbnail
            };
            if (downloadFailed) {
                manifestClip.stale = true;
            }
            manifestClips.push(manifestClip);

            playlistEntries.push({ file, title: `${index + 1}. ${clip.title}`, duration });
            catalogItems.push({
                type: "video",
                title: `${index + 1}. ${clip.title}`,
                subtitle: [course.title, clip.module].filter(Boolean).join(" · "),
                text: transcriptText,
                href: path.basename(file),
                external: false,
                duration,
                course: course.title
            });
        }
    }

    if (wantTranscripts && transcriptLines.length) {
        fs.writeFileSync(path.join(coursePath, "transcript.md"), `# ${course.title} — transcript\n\n${transcriptLines.join("\n")}`);
    }

    const manifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        course: {
            id: course.id,
            slug,
            title: course.title,
            description: courseDescription
        },
        clips: manifestClips
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    if (wantTvLayout) {
        try {
            metadata.writeTvLayout(coursePath, course, clips, manifestClips, {
                description: courseDescription,
                updatedAt: course.updatedAt
            });
        } catch (error) {
            console.error(`Could not create TV layout: ${error.message}`);
        }
    }

    if (wantPlaylist && playlistEntries.length) {
        metadata.writePlaylist(path.join(coursePath, "playlist.m3u"), playlistEntries);
    }

    if (wantIndex) {
        const items = [...catalogItems, ...resourceItems];
        metadata.writeCatalog(
            path.join(coursePath, "index.html"),
            course.title,
            `Offline course catalog · ${clips.length} videos`,
            items,
            wantPlaylist && playlistEntries.length ? "playlist.m3u" : ""
        );
    }

    return {
        course,
        coursePath,
        items: [...catalogItems, ...resourceItems],
        playlistEntries,
        manifest
    };
}

function isLearningPathUrl(url) {
    return /\/learning-paths\//.test(url);
}

function pathIdFromUrl(url) {
    return /\/learning-paths\/([0-9a-f-]+)/i.exec(url)[1];
}

function isLabUrl(url) {
    return /\/hands-on\/labs\//.test(url);
}

function labIdFromUrl(url) {
    return /\/hands-on\/labs\/([0-9a-f-]+)/i.exec(url)[1];
}

function isExamUrl(url) {
    return /\/assessment-pe\//.test(url);
}

function examSlugFromUrl(url) {
    return /\/assessment-pe\/([^/?#]+)/.exec(url)[1];
}

async function getLabGuide(uid, cookie) {
    const query = `query LabKeep_getLab($uid: String!) {
        LabKeep_getLab(uid: $uid) {
            name
            description
            guide
            instructions
        }
    }`;

    const response = await fetch("https://labs.pluralsight.com/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "cookie": cookie,
            "User-Agent": USER_AGENT,
            "Origin": "https://app.pluralsight.com",
            "Referer": "https://app.pluralsight.com/hands-on/labs/" + uid
        },
        body: JSON.stringify({ operationName: "LabKeep_getLab", variables: { uid }, query })
    });

    if (!response.ok) {
        throw new Error(`Lab API failed with HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.errors && result.errors.length) {
        throw new Error(result.errors.map(error => error.message).join("; "));
    }

    return result.data.LabKeep_getLab;
}

function formatLabGuide(lab, url) {
    return [
        `# ${lab.name}`,
        "",
        lab.description || "",
        "",
        `Source: ${url}`,
        "",
        "## Lab guide",
        "",
        lab.guide || "_No guide available._",
        "",
        "## Instructions and resources",
        "",
        lab.instructions || "_No additional resources._",
        "",
        "---",
        "",
        "This is a static copy of the lab guide. The lab itself is an interactive cloud environment and must be started on Pluralsight."
    ].join("\n");
}

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function createLabPage(title, markdown, sourceUrl) {
    const body = markdown.replace(/^#\s+.*\r?\n/, "");
    const rendered = mdRenderer.render(body);
    const safeTitle = escapeHtml(title);
    const safeUrl = escapeHtml(sourceUrl);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} - Lab guide</title>
<style>
:root { color-scheme: light; --bg:#f6f7fb; --card:#fff; --ink:#1c2333; --muted:#667085; --line:#e4e7ec; --accent:#5b3df5; --accent-soft:#ece8ff; }
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--ink); line-height:1.65; }
.topbar { background:linear-gradient(135deg,#20124d,#4b2fd6); color:#fff; padding:40px 20px 28px; }
.wrap { max-width:900px; margin:0 auto; padding:0 20px; }
.eyebrow { text-transform:uppercase; letter-spacing:.14em; font-size:12px; font-weight:700; opacity:.75; }
h1 { margin:8px 0 10px; font-size:clamp(28px,5vw,42px); line-height:1.15; }
.sub { margin:0 0 18px; color:#d9d2ff; max-width:720px; }
.progress { height:8px; background:rgba(255,255,255,.22); border-radius:999px; overflow:hidden; }
.bar { height:100%; width:0; background:#b9a8ff; transition:width .2s ease; }
.meta { display:flex; flex-wrap:wrap; gap:14px; align-items:center; margin-top:12px; font-size:14px; color:#e8e3ff; }
.meta a { color:#fff; }
.meta button { background:transparent; color:#fff; border:1px solid rgba(255,255,255,.4); padding:6px 12px; border-radius:8px; cursor:pointer; }
main.wrap { padding-top:30px; padding-bottom:50px; }
#content { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:clamp(20px,4vw,40px); box-shadow:0 10px 30px rgba(16,24,40,.06); }
#content h2 { margin-top:34px; padding-bottom:8px; border-bottom:1px solid var(--line); }
#content h2:first-child { margin-top:0; }
#content h3 { margin-top:24px; }
#content code { background:#f2f4f7; padding:2px 6px; border-radius:5px; font-size:.92em; }
#content pre { background:#101828; color:#f9fafb; padding:16px; border-radius:10px; overflow:auto; }
#content pre code { background:none; padding:0; color:inherit; }
#content blockquote { margin:18px 0; padding:12px 16px; border-left:4px solid var(--accent); background:var(--accent-soft); border-radius:0 8px 8px 0; }
#content a { color:var(--accent); }
#content table { width:100%; border-collapse:collapse; }
#content th, #content td { border:1px solid var(--line); padding:8px 10px; text-align:left; }
li.has-check { list-style:none; position:relative; padding-left:1.9em; margin:.35em 0; }
li.has-check > input { position:absolute; left:0; top:.42em; width:1.05em; height:1.05em; accent-color:var(--accent); }
li.has-check.done { color:var(--muted); text-decoration:line-through; text-decoration-color:#b9b3d9; }
footer { color:var(--muted); font-size:13px; padding:0 0 40px; }
@media print { .topbar { background:#fff; color:#000; } .meta, .progress { display:none; } #content { box-shadow:none; border:0; padding:0; } }
</style>
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <div class="eyebrow">Hands-on lab</div>
    <h1>${safeTitle}</h1>
    <p class="sub">Interactive offline lab guide. The real lab is a temporary cloud environment and must be started on Pluralsight.</p>
    <div class="progress" aria-hidden="true"><div class="bar" id="bar"></div></div>
    <div class="meta">
      <span id="progressText">0 / 0 steps completed</span>
      <button type="button" id="reset">Reset progress</button>
      <a href="${safeUrl}" target="_blank" rel="noreferrer">Open lab on Pluralsight</a>
    </div>
  </div>
</header>
<main class="wrap">
  <article id="content">${rendered}</article>
</main>
<footer class="wrap">Static copy generated from Pluralsight. Progress is stored locally in this browser.</footer>
<script>
(function () {
  var content = document.getElementById('content');
  var items = Array.prototype.slice.call(content.querySelectorAll('li'));
  var key = 'ps-lab:' + document.title;
  var state = {};
  try { state = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { state = {}; }
  var boxes = [];
  function update() {
    var done = 0;
    boxes.forEach(function (cb) {
      if (cb.checked) { done++; }
      cb.parentElement.classList.toggle('done', cb.checked);
    });
    var pct = items.length ? Math.round(done / items.length * 100) : 0;
    document.getElementById('bar').style.width = pct + '%';
    document.getElementById('progressText').textContent = done + ' / ' + items.length + ' steps completed';
  }
  items.forEach(function (li, i) {
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state[i];
    cb.setAttribute('aria-label', 'Mark step ' + (i + 1) + ' complete');
    li.classList.add('has-check');
    li.insertBefore(cb, li.firstChild);
    cb.addEventListener('change', function () {
      state[i] = cb.checked;
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
      update();
    });
    boxes.push(cb);
  });
  document.getElementById('reset').addEventListener('click', function () {
    state = {};
    boxes.forEach(function (cb) { cb.checked = false; });
    try { localStorage.removeItem(key); } catch (e) {}
    update();
  });
  update();
})();
</script>
</body>
</html>`;
}

function stripHtml(value) {
    if (value == null) {
        return "";
    }
    return String(value)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function createExamClient(cookie, slug) {
    let sessionCookie = cookie;
    let csrfToken;
    let correlationId = crypto.randomUUID();

    function mergeCookies(setCookies) {
        for (const setCookie of setCookies || []) {
            const pair = setCookie.split(";")[0];
            const name = pair.split("=")[0];
            const pattern = new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=[^;]*");
            sessionCookie = pattern.test(sessionCookie)
                ? sessionCookie.replace(pattern, match => (match.startsWith("; ") ? "; " : "") + pair)
                : sessionCookie + "; " + pair;
        }
    }

    return {
        async request(endpoint, options = {}) {
            const method = options.method || "GET";
            const headers = {
                "Content-Type": "application/json",
                "cookie": sessionCookie,
                "User-Agent": USER_AGENT,
                "Origin": "https://app.pluralsight.com",
                "Referer": `https://app.pluralsight.com/assessment-pe/${slug}/intro`,
                "x-correlation-id": correlationId
            };
            if (csrfToken) {
                headers["csrf-token"] = csrfToken;
            }

            const response = await fetch("https://app.pluralsight.com/assessment-pe/api" + endpoint, {
                method,
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined
            });

            mergeCookies(response.headers.raw()["set-cookie"]);
            if (response.headers.get("csrf-token")) {
                csrfToken = response.headers.get("csrf-token");
            }
            if (response.headers.get("x-correlation-id")) {
                correlationId = response.headers.get("x-correlation-id");
            }

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`Assessment API ${method} ${endpoint} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
            }
            return text ? JSON.parse(text) : null;
        }
    };
}

function formatExamMarkdown(data, slug) {
    const lines = [
        `# ${data.assessment.title}`,
        "",
        `Source: https://app.pluralsight.com/assessment-pe/${slug}`,
        `Questions: ${data.attempt.totalQuestions}`,
        `Attempt status: ${data.attempt.status}`,
        `Score: ${data.attempt.correctQuestions}/${data.attempt.totalQuestions}`,
        "",
        "> Generated from one randomized practice-exam attempt. The attempt was automatically answered to unlock the answer key.",
        ""
    ];

    for (const question of data.questions) {
        lines.push(`## Question ${question.order}`, "", question.stem, "");
        for (const option of question.options) {
            lines.push(`- [${option.isKey ? "x" : " "}] ${option.content}`);
            if (option.rationale) {
                lines.push(`  - _${option.rationale}_`);
            }
        }
        if (question.contentMapping && question.contentMapping.title) {
            lines.push("", `Related: ${question.contentMapping.title}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

function createExamPage(data, slug) {
    const exam = {
        assessment: {
            title: data.assessment.title,
            slug,
            duration: data.assessment.duration || 6000
        },
        attempt: data.attempt || {},
        questions: (data.questions || []).map(question => ({
            id: question.id,
            order: question.order,
            format: question.format,
            stem: question.stem,
            options: (question.options || []).map(option => {
                if (typeof option === "string") {
                    return { content: option, isKey: false, rationale: "" };
                }
                return {
                    content: option.content,
                    isKey: !!option.isKey,
                    rationale: option.rationale || ""
                };
            })
        }))
    };

    const examJson = JSON.stringify(exam).replace(/</g, "\\u003c");
    const safeTitle = escapeHtml(exam.assessment.title || slug);
    const safeSlug = escapeHtml(slug);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} - Practice exam</title>
<style>
:root { color-scheme: light; --bg:#f6f7fb; --card:#fff; --ink:#1c2333; --muted:#667085; --line:#e4e7ec; --accent:#5b3df5; --accent-soft:#ece8ff; --good:#067647; --good-soft:#ecfdf3; --bad:#b42318; --bad-soft:#fef3f2; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--ink); line-height:1.6; }
.wrap { max-width:1100px; margin:0 auto; padding:0 20px; }
.topbar { background:linear-gradient(135deg,#20124d,#4b2fd6); color:#fff; padding:34px 0 26px; }
.eyebrow { text-transform:uppercase; letter-spacing:.14em; font-size:12px; font-weight:700; opacity:.75; }
.eyebrow.dark { color:var(--muted); opacity:1; }
h1 { margin:8px 0 6px; font-size:clamp(26px,4vw,38px); line-height:1.15; }
.sub { margin:0; color:#d9d2ff; }
main { padding-top:26px; padding-bottom:60px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:clamp(20px,4vw,36px); box-shadow:0 10px 30px rgba(16,24,40,.06); }
.start h2 { margin:0 0 8px; }
.toggles { display:flex; flex-direction:column; gap:10px; margin:20px 0; }
.toggles label { display:flex; gap:9px; align-items:center; cursor:pointer; }
.toggles input { accent-color:var(--accent); width:16px; height:16px; }
.buttons { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
button { font:inherit; border-radius:9px; padding:10px 16px; cursor:pointer; border:1px solid transparent; font-weight:600; }
button:disabled { opacity:.45; cursor:not-allowed; }
.primary { background:var(--accent); color:#fff; }
.primary:hover:not(:disabled) { background:#4527d9; }
.secondary { background:#fff; color:var(--accent); border-color:#c9bfff; }
.ghost { background:#fff; color:var(--ink); border-color:var(--line); }
.ghost.active { background:var(--accent-soft); border-color:#c9bfff; color:var(--accent); }
.danger { background:var(--bad); color:#fff; }
.muted { color:var(--muted); font-size:14px; }
.exambar { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:16px; }
.exambarActions { display:flex; gap:8px; }
.timer { margin-left:10px; color:var(--accent); font-variant-numeric:tabular-nums; }
.examLayout { display:grid; grid-template-columns:230px minmax(0,1fr); gap:18px; align-items:start; }
.navCard { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; position:sticky; top:16px; }
.navTitle { font-weight:700; margin-bottom:10px; }
.navigator { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }
.navBtn { padding:6px 0; border:1px solid var(--line); background:#fff; border-radius:6px; font-size:13px; position:relative; }
.navBtn.answered { background:var(--accent-soft); border-color:#c9bfff; color:var(--accent); }
.navBtn.flagged:after { content:""; position:absolute; top:3px; right:3px; width:6px; height:6px; border-radius:50%; background:#f79009; }
.navBtn.current { outline:2px solid var(--accent); outline-offset:1px; }
.legend { margin-top:14px; display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--muted); }
.legend span { display:flex; align-items:center; gap:6px; }
.dot { width:9px; height:9px; border-radius:50%; background:#fff; border:1px solid var(--line); display:inline-block; }
.dot.answered { background:var(--accent-soft); border-color:#c9bfff; }
.dot.flagged { background:#f79009; border-color:#f79009; }
.questionCard { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:clamp(18px,3vw,30px); box-shadow:0 10px 30px rgba(16,24,40,.05); }
.stem { font-size:1.08rem; font-weight:600; white-space:pre-wrap; margin-bottom:20px; }
.options { display:flex; flex-direction:column; gap:10px; }
.option { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; background:#fff; transition:border-color .15s, background .15s; }
.option:hover { border-color:#c9bfff; background:#fbfaff; }
.option input { margin-top:4px; width:16px; height:16px; accent-color:var(--accent); flex:none; }
.optionText { white-space:pre-wrap; }
.qActions { display:flex; justify-content:space-between; gap:10px; margin-top:22px; }
.study { margin-top:22px; border-top:1px dashed var(--line); padding-top:16px; }
.study summary { cursor:pointer; font-weight:700; color:var(--accent); }
.answerLine { margin-top:10px; padding:10px 12px; background:var(--good-soft); border:1px solid #abefc6; border-radius:8px; color:var(--good); }
.rationale { color:var(--muted); font-size:14px; margin:8px 0 0; }
.resultHead h2 { margin:6px 0 10px; }
.scoreBig { font-size:clamp(38px,7vw,64px); font-weight:800; line-height:1.1; color:var(--accent); }
.reviewItem { background:var(--card); border:1px solid var(--line); border-radius:12px; margin-top:12px; overflow:hidden; }
.reviewItem summary { cursor:pointer; padding:14px 18px; font-weight:700; list-style:none; display:flex; justify-content:space-between; gap:10px; }
.reviewItem summary::-webkit-details-marker { display:none; }
.reviewItem.correct summary { border-left:5px solid #12b76a; }
.reviewItem.incorrect summary { border-left:5px solid #f04438; }
.reviewBody { padding:0 18px 18px; }
.reviewStem { font-weight:600; white-space:pre-wrap; margin:6px 0 14px; }
.reviewOption { border:1px solid var(--line); border-radius:8px; padding:9px 12px; margin:8px 0; display:flex; gap:10px; }
.reviewOption.correct { background:var(--good-soft); border-color:#abefc6; }
.reviewOption.wrong { background:var(--bad-soft); border-color:#fecdca; }
.reviewIcon { font-weight:800; flex:none; }
.reviewOption.correct .reviewIcon { color:var(--good); }
.reviewOption.wrong .reviewIcon { color:var(--bad); }
.reviewRationale { color:var(--muted); font-size:14px; margin:4px 0 0 26px; }
@media (max-width:760px) { .examLayout { grid-template-columns:1fr; } .navCard { position:static; order:2; } .exambar { align-items:flex-start; flex-direction:column; } .exambarActions { width:100%; } .exambarActions button { flex:1; } }
@media print { .topbar { background:#fff; color:#000; } .navCard, .exambarActions, .buttons, .study { display:none !important; } .card, .questionCard, .reviewItem { box-shadow:none; } }
</style>
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <div class="eyebrow">Practice exam</div>
    <h1>${safeTitle}</h1>
    <p class="sub">Offline practice exam with ${exam.questions.length} questions, answer key and explanations.</p>
  </div>
</header>
<main class="wrap">
  <section id="startScreen" class="card start">
    <h2>Ready to practice?</h2>
    <p id="startInfo" class="muted"></p>
    <div class="toggles">
      <label><input type="checkbox" id="timerToggle"> Use timer (<span id="durationLabel"></span> minutes)</label>
      <label><input type="checkbox" id="studyToggle"> Study mode &ndash; allow revealing answers while practicing</label>
    </div>
    <div class="buttons">
      <button id="startBtn" class="primary" type="button">Start exam</button>
      <button id="resumeBtn" class="secondary" type="button" hidden>Resume previous attempt</button>
    </div>
    <p class="muted">The questions, correct answers and explanations come from one randomized Pluralsight attempt. This page works fully offline.</p>
  </section>

  <section id="examScreen" hidden>
    <div class="exambar">
      <div><strong id="qCounter"></strong><span id="timer" class="timer"></span></div>
      <div class="exambarActions">
        <button id="flagBtn" class="ghost" type="button">Flag for review</button>
        <button id="submitBtn" class="danger" type="button">Submit exam</button>
      </div>
    </div>
    <div class="examLayout">
      <aside class="navCard">
        <div class="navTitle">Questions</div>
        <div id="navigator" class="navigator"></div>
        <div class="legend">
          <span><i class="dot answered"></i>Answered</span>
          <span><i class="dot flagged"></i>Flagged</span>
          <span><i class="dot"></i>Unanswered</span>
        </div>
      </aside>
      <section class="questionCard">
        <div id="questionStem" class="stem"></div>
        <div id="optionList" class="options"></div>
        <div class="qActions">
          <button id="prevBtn" class="ghost" type="button">Previous</button>
          <button id="nextBtn" class="primary" type="button">Next</button>
        </div>
        <details id="studyAnswer" class="study" hidden>
          <summary>Show correct answer</summary>
          <div id="studyAnswerBody"></div>
        </details>
      </section>
    </div>
  </section>

  <section id="resultsScreen" hidden>
    <div class="card resultHead">
      <div class="eyebrow dark">Result</div>
      <h2 id="resultTitle"></h2>
      <div id="scoreBig" class="scoreBig"></div>
      <div id="scoreMeta" class="muted"></div>
      <div class="buttons"><button id="retakeBtn" class="primary" type="button">Retake exam</button></div>
    </div>
    <div id="reviewList"></div>
  </section>
</main>
<script>
var exam = ${examJson};
var answers = {};
var flags = {};
var current = 0;
var submitted = false;
var timerId = null;
var remaining = exam.assessment.duration || 6000;
var useTimer = false;
var studyMode = false;
var storageKey = 'ps-exam:${safeSlug}';
var correctCount = 0;

function byId(id) { return document.getElementById(id); }
function pad(value) { return value < 10 ? '0' + value : String(value); }
function formatTime(seconds) { return pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60); }
function saveState() {
  if (submitted) { return; }
  try { localStorage.setItem(storageKey, JSON.stringify({ answers: answers, flags: flags, current: current })); } catch (e) {}
}
function loadState() {
  try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (e) { return null; }
}
function clearState() {
  try { localStorage.removeItem(storageKey); } catch (e) {}
}
function hasAnswered(question) {
  return answers[question.id] && answers[question.id].length > 0;
}
function isCorrect(question) {
  var selected = (answers[question.id] || []).slice().sort(function (a, b) { return a - b; });
  var key = [];
  question.options.forEach(function (option, index) { if (option.isKey) { key.push(index); } });
  key.sort(function (a, b) { return a - b; });
  if (selected.length !== key.length) { return false; }
  for (var i = 0; i < key.length; i++) { if (selected[i] !== key[i]) { return false; } }
  return true;
}
function renderNavigator() {
  var nav = byId('navigator');
  nav.innerHTML = '';
  exam.questions.forEach(function (question, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'navBtn';
    button.textContent = String(index + 1);
    if (index === current) { button.classList.add('current'); }
    if (hasAnswered(question)) { button.classList.add('answered'); }
    if (flags[question.id]) { button.classList.add('flagged'); }
    button.addEventListener('click', function () { current = index; renderQuestion(); saveState(); });
    nav.appendChild(button);
  });
}
function renderStudyAnswer(question) {
  var body = byId('studyAnswerBody');
  body.innerHTML = '';
  var correct = question.options.filter(function (option) { return option.isKey; });
  var answer = document.createElement('div');
  answer.className = 'answerLine';
  answer.textContent = correct.length ? 'Correct answer: ' + correct.map(function (option) { return option.content; }).join('  |  ') : 'No answer key available for this question.';
  body.appendChild(answer);
  question.options.forEach(function (option) {
    if (option.rationale) {
      var rationale = document.createElement('p');
      rationale.className = 'rationale';
      rationale.textContent = option.content + ' — ' + option.rationale;
      body.appendChild(rationale);
    }
  });
}
function renderQuestion() {
  var question = exam.questions[current];
  byId('qCounter').textContent = 'Question ' + (current + 1) + ' of ' + exam.questions.length;
  byId('questionStem').textContent = question.stem;
  var list = byId('optionList');
  list.innerHTML = '';
  var selected = answers[question.id] || [];
  var multi = question.format === 'MULTI_SELECT';
  question.options.forEach(function (option, index) {
    var label = document.createElement('label');
    label.className = 'option';
    var input = document.createElement('input');
    input.type = multi ? 'checkbox' : 'radio';
    input.name = 'question-' + question.id;
    input.checked = selected.indexOf(index) !== -1;
    input.addEventListener('change', function () {
      if (!multi) {
        answers[question.id] = [index];
      } else {
        var values = (answers[question.id] || []).slice();
        if (input.checked) {
          if (values.indexOf(index) === -1) { values.push(index); }
        } else {
          values = values.filter(function (value) { return value !== index; });
        }
        answers[question.id] = values;
      }
      saveState();
      renderNavigator();
    });
    var text = document.createElement('span');
    text.className = 'optionText';
    text.textContent = option.content;
    label.appendChild(input);
    label.appendChild(text);
    list.appendChild(label);
  });
  byId('prevBtn').disabled = current === 0;
  byId('nextBtn').textContent = current === exam.questions.length - 1 ? 'Finish' : 'Next';
  byId('flagBtn').textContent = flags[question.id] ? 'Unflag' : 'Flag for review';
  byId('flagBtn').classList.toggle('active', !!flags[question.id]);
  byId('studyAnswer').hidden = !studyMode;
  if (studyMode) { renderStudyAnswer(question); }
  renderNavigator();
}
function startTimer() {
  clearInterval(timerId);
  var end = Date.now() + remaining * 1000;
  function tick() {
    remaining = Math.max(0, Math.round((end - Date.now()) / 1000));
    byId('timer').textContent = formatTime(remaining);
    if (remaining <= 0) {
      clearInterval(timerId);
      submitExam(true);
    }
  }
  tick();
  timerId = setInterval(tick, 1000);
}
function startExam(resume) {
  var saved = resume ? loadState() : null;
  if (saved) {
    answers = saved.answers || {};
    flags = saved.flags || {};
    current = saved.current || 0;
  }
  useTimer = byId('timerToggle').checked;
  studyMode = byId('studyToggle').checked;
  submitted = false;
  byId('startScreen').hidden = true;
  byId('resultsScreen').hidden = true;
  byId('examScreen').hidden = false;
  current = Math.min(current, exam.questions.length - 1);
  if (useTimer) { remaining = exam.assessment.duration || 6000; startTimer(); } else { clearInterval(timerId); byId('timer').textContent = ''; }
  renderQuestion();
  saveState();
}
function submitExam(automatic) {
  if (submitted) { return; }
  var unanswered = exam.questions.filter(function (question) { return !hasAnswered(question); }).length;
  if (!automatic) {
    var message = unanswered > 0 ? unanswered + ' question(s) are unanswered. Submit anyway?' : 'Submit the exam and see your result?';
    if (!confirm(message)) { return; }
  }
  submitted = true;
  clearInterval(timerId);
  correctCount = 0;
  exam.questions.forEach(function (question) { if (isCorrect(question)) { correctCount++; } });
  byId('examScreen').hidden = true;
  byId('resultsScreen').hidden = false;
  renderResults();
  clearState();
  window.scrollTo(0, 0);
}
function optionReview(question, option, index) {
  var selected = (answers[question.id] || []).indexOf(index) !== -1;
  var row = document.createElement('div');
  row.className = 'reviewOption';
  if (option.isKey) { row.classList.add('correct'); }
  else if (selected) { row.classList.add('wrong'); }
  var icon = document.createElement('span');
  icon.className = 'reviewIcon';
  icon.textContent = option.isKey ? '✓' : (selected ? '✗' : '·');
  var text = document.createElement('div');
  var content = document.createElement('div');
  content.textContent = option.content;
  text.appendChild(content);
  if (option.rationale) {
    var rationale = document.createElement('div');
    rationale.className = 'reviewRationale';
    rationale.textContent = option.rationale;
    text.appendChild(rationale);
  }
  row.appendChild(icon);
  row.appendChild(text);
  return row;
}
function renderResults() {
  var total = exam.questions.length;
  var percent = total ? Math.round(correctCount / total * 100) : 0;
  byId('resultTitle').textContent = percent >= 70 ? 'Passing range' : 'Keep practicing';
  byId('scoreBig').textContent = correctCount + ' / ' + total;
  byId('scoreMeta').textContent = percent + '% correct';
  var list = byId('reviewList');
  list.innerHTML = '';
  exam.questions.forEach(function (question, index) {
    var correct = isCorrect(question);
    var details = document.createElement('details');
    details.className = 'reviewItem ' + (correct ? 'correct' : 'incorrect');
    details.open = !correct;
    var summary = document.createElement('summary');
    var label = document.createElement('span');
    label.textContent = 'Question ' + (index + 1) + ' — ' + (correct ? 'Correct' : 'Incorrect');
    var hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = hasAnswered(question) ? 'Your answer recorded' : 'Unanswered';
    summary.appendChild(label);
    summary.appendChild(hint);
    details.appendChild(summary);
    var body = document.createElement('div');
    body.className = 'reviewBody';
    var stem = document.createElement('div');
    stem.className = 'reviewStem';
    stem.textContent = question.stem;
    body.appendChild(stem);
    question.options.forEach(function (option, optionIndex) {
      body.appendChild(optionReview(question, option, optionIndex));
    });
    if (!question.options.length) {
      var missing = document.createElement('p');
      missing.className = 'muted';
      missing.textContent = 'No answer data available for this question.';
      body.appendChild(missing);
    }
    details.appendChild(body);
    list.appendChild(details);
  });
}
byId('durationLabel').textContent = String(Math.round((exam.assessment.duration || 6000) / 60));
byId('startInfo').textContent = exam.questions.length + ' questions' + (exam.attempt && exam.attempt.completedOn ? ' · generated ' + new Date(exam.attempt.completedOn).toLocaleDateString() : '');
var savedState = loadState();
if (savedState && Object.keys(savedState.answers || {}).length) { byId('resumeBtn').hidden = false; }
byId('startBtn').addEventListener('click', function () {
  clearState();
  answers = {};
  flags = {};
  current = 0;
  startExam(false);
});
byId('resumeBtn').addEventListener('click', function () { startExam(true); });
byId('prevBtn').addEventListener('click', function () { if (current > 0) { current--; renderQuestion(); saveState(); } });
byId('nextBtn').addEventListener('click', function () {
  if (current < exam.questions.length - 1) { current++; renderQuestion(); saveState(); }
  else { submitExam(false); }
});
byId('flagBtn').addEventListener('click', function () {
  var question = exam.questions[current];
  flags[question.id] = !flags[question.id];
  saveState();
  renderQuestion();
});
byId('submitBtn').addEventListener('click', function () { submitExam(false); });
byId('retakeBtn').addEventListener('click', function () {
  clearState();
  answers = {};
  flags = {};
  current = 0;
  submitted = false;
  byId('resultsScreen').hidden = true;
  byId('startScreen').hidden = false;
  byId('timerToggle').checked = false;
  byId('studyToggle').checked = false;
  byId('timer').textContent = '';
});
document.addEventListener('keydown', function (event) {
  if (byId('examScreen').hidden) { return; }
  if (event.key === 'ArrowRight' && current < exam.questions.length - 1) { current++; renderQuestion(); saveState(); }
  if (event.key === 'ArrowLeft' && current > 0) { current--; renderQuestion(); saveState(); }
});
</script>
</body>
</html>`;
}

async function downloadPracticeExam(slug, cookie, outputDir, baseName, retries = CONFIG.retries) {
    const markdownFile = path.join(outputDir, baseName + ".md");
    const jsonFile = path.join(outputDir, baseName + ".json");
    const htmlFile = path.join(outputDir, baseName + ".html");

    if (fs.existsSync(jsonFile)) {
        if (!fs.existsSync(htmlFile)) {
            const existing = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
            fs.writeFileSync(htmlFile, createExamPage(existing, slug));
            console.log(`Created interactive page: ${baseName}.html`);
        }
        console.log(`Skipping existing practice exam: ${baseName}`);
        return;
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const client = createExamClient(cookie, slug);
    const request = (endpoint, options) => withRetry(`Exam API ${endpoint}`, () => client.request(endpoint, options), retries);
    const bootstrap = await request(`/bootstrap/${slug}`);
    const session = await request("/session", {
        method: "POST",
        body: { assessmentSlug: slug, isTimed: false, userId: bootstrap.userId }
    });

    console.log(`Practice exam: ${bootstrap.assessment.title} (${session.interactions.length} questions)`);
    if (!session.newSession) {
        console.log("An existing practice-exam attempt is already in progress. Finish or discard it on Pluralsight, then run the download again.");
        return;
    }
    console.log("Creating one automatically answered attempt to unlock the answer key...");

    const questions = [];
    for (let index = 0; index < session.interactions.length; index++) {
        const interaction = session.interactions[index];
        const question = await request(`/question-interaction/${interaction.id}`);
        questions.push({
            id: question.id,
            order: question.order,
            format: question.format,
            stem: stripHtml(question.stem),
            stemHtml: question.stem,
            contentMapping: question.contentMapping || null,
            options: (question.options || []).map(option => ({
                content: stripHtml(option),
                contentHtml: option
            }))
        });
        await wait(200);
    }

    for (let index = 0; index < questions.length; index++) {
        const question = questions[index];
        const selectedOptions = question.options.length ? [question.options[0].contentHtml] : [];
        try {
            await request(`/question-interaction/${question.id}`, {
                method: "PUT",
                body: { flagged: false, selectedOptions, timeRemaining: 0 }
            });
        } catch (error) {
            console.error(`Could not answer question ${index + 1}: ${error.message}`);
        }
        if ((index + 1) % 10 === 0) {
            console.log(`Answered ${index + 1}/${questions.length}`);
        }
        await wait(200);
    }

    await request("/save", {
        method: "POST",
        body: { sessionId: session.sessionId, submit: true, timeRemaining: 0 }
    });

    const summary = await request(`/session/summary/${slug}`);

    for (let index = 0; index < questions.length; index++) {
        const question = questions[index];
        try {
            const questionSummary = await request(`/question-interaction/summary/${question.id}`);
            questions[index].stem = stripHtml(questionSummary.stem || question.stemHtml);
            questions[index].contentMapping = questionSummary.contentMapping || questions[index].contentMapping;
            questions[index].options = (questionSummary.options || []).map(option => {
                if (typeof option === "string") {
                    return { content: stripHtml(option), contentHtml: option, isKey: false, selected: false, rationale: "" };
                }
                return {
                    content: stripHtml(option.content),
                    contentHtml: option.content,
                    isKey: !!option.isKey,
                    selected: !!option.selected,
                    rationale: stripHtml(option.rationale)
                };
            });
        } catch (error) {
            console.error(`Could not fetch feedback for question ${question.order}: ${error.message}`);
        }
        await wait(200);
    }

    const data = {
        assessment: {
            title: bootstrap.assessment.title,
            slug,
            questionCount: bootstrap.assessment.questionCount,
            duration: bootstrap.assessment.duration
        },
        attempt: {
            sessionId: summary.sessionId,
            status: summary.sessionStatus,
            score: summary.score,
            correctQuestions: summary.correctQuestions,
            totalQuestions: summary.totalQuestions,
            completedOn: summary.completedOn
        },
        questions
    };

    fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2));
    fs.writeFileSync(markdownFile, formatExamMarkdown(data, slug));
    fs.writeFileSync(htmlFile, createExamPage(data, slug));
    console.log(`Saved practice exam: ${markdownFile}`);
}

async function downloadLearningPath(pathId, cookie, options = {}) {
    const delaySeconds = Number(options.delay ?? CONFIG.delay);
    const retries = Number(options.retries ?? CONFIG.retries);
    const wantPlaylist = options.playlist !== false;
    const wantIndex = options.index !== false;

    const pathData = await withRetry(`Fetching learning path ${pathId}`, async () => {
        const response = await fetch(`https://app.pluralsight.com/learning-paths/api/v1/paths/${pathId}`, {
            headers: ilxHeaders(cookie)
        });
        if (!response.ok) {
            throw new Error(`Learning path request failed with HTTP ${response.status}`);
        }
        return response.json();
    }, retries);

    const courses = [];
    const labs = [];
    const exams = [];

    for (const section of pathData.sections || []) {
        for (const item of section.content || []) {
            const details = item.contentDetails || {};

            if (details.contentType === "hands-on-lab" && details.url) {
                const match = /\/hands-on\/labs\/([0-9a-f-]+)/i.exec(details.url);
                if (match) {
                    labs.push({ title: details.title, uid: match[1], url: details.url });
                }
                continue;
            }

            if (details.contentType === "practice-exam" && details.url) {
                const match = /\/assessment-pe\/([^/?#]+)/.exec(details.url);
                if (match) {
                    exams.push({ title: details.title, slug: match[1], url: details.url });
                }
                continue;
            }

            if (details.contentType === "video-course" && details.url) {
                const match = /\/library\/courses\/([^/?#]+)/.exec(details.url);
                courses.push({
                    title: details.title,
                    slug: details.slug || (match && match[1]),
                    type: "video-course",
                    posterUrl: details.thumbnailUrl,
                    description: details.description,
                    updatedAt: details.updatedAt
                });
                continue;
            }

            if (details.contentType !== "integrated-learning-experience" || !details.url) {
                continue;
            }
            courses.push({
                title: details.title,
                slug: details.slug || ilxSlugFromUrl(details.url),
                type: "ilx",
                posterUrl: details.thumbnailUrl,
                description: details.description,
                updatedAt: details.updatedAt
            });
        }
    }

    console.log(`Learning path: ${pathData.title} (${courses.length} courses, ${labs.length} lab guides, ${exams.length} practice exams)`);
    console.log("Labs are saved as Markdown guides. Practice exams are saved with questions, answers and explanations.");

    const pathPath = path.join(OUTPUT_ROOT, sanitizeTitle(pathData.slug || pathId));
    fs.mkdirSync(pathPath, { recursive: true });

    const courseResults = [];

    for (let index = 0; index < courses.length; index++) {
        const course = courses[index];
        const folderName = `${String(index + 1).padStart(2, "0")}. ${sanitizeTitle(course.title)}`;
        const coursePath = path.join(pathPath, folderName);
        const oldPath = path.join(OUTPUT_ROOT, sanitizeTitle(course.slug));

        // Reuse a course that was already downloaded on its own
        if (!fs.existsSync(coursePath) && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, coursePath);
        }

        console.log(`\n=== Course ${index + 1}/${courses.length}: ${course.title} ===`);
        const result = course.type === "video-course"
            ? await downloadVideoCourse(course, cookie, options, coursePath, {
                posterUrl: course.posterUrl,
                description: course.description,
                updatedAt: course.updatedAt
            })
            : await downloadIlxCourse(course.slug, cookie, options, coursePath, {
                posterUrl: course.posterUrl,
                description: course.description,
                updatedAt: course.updatedAt
            });
        courseResults.push(result);

        if (index < courses.length - 1 && delaySeconds > 0) {
            console.log(`Waiting ${delaySeconds}s before the next course...`);
            await wait(delaySeconds * 1000);
        }
    }

    const labItems = [];
    if (labs.length) {
        const labsPath = path.join(pathPath, "labs");
        fs.mkdirSync(labsPath, { recursive: true });

        for (let index = 0; index < labs.length; index++) {
            const lab = labs[index];
            const baseName = `${String(index + 1).padStart(2, "0")}. ${sanitizeTitle(lab.title)}`;
            const markdownFile = path.join(labsPath, baseName + ".md");
            const htmlFile = path.join(labsPath, baseName + ".html");

            if (fs.existsSync(markdownFile)) {
                if (!fs.existsSync(htmlFile)) {
                    try {
                        const markdown = fs.readFileSync(markdownFile, "utf8");
                        fs.writeFileSync(htmlFile, createLabPage(lab.title, markdown, lab.url));
                        console.log(`Created interactive page: ${baseName}.html`);
                    } catch (error) {
                        console.error(`Could not create lab page "${lab.title}": ${error.message}`);
                    }
                } else {
                    console.log(`Skipping existing lab guide: ${lab.title}`);
                }
            } else {
                try {
                    const guide = await withRetry(`Lab guide ${lab.title}`, () => getLabGuide(lab.uid, cookie), retries);
                    const markdown = formatLabGuide(guide, lab.url);
                    fs.writeFileSync(markdownFile, markdown);
                    fs.writeFileSync(htmlFile, createLabPage(guide.name, markdown, lab.url));
                    console.log(`Saved lab guide: ${lab.title}`);
                } catch (error) {
                    console.error(`Could not download lab guide "${lab.title}": ${error.message}`);
                }
            }

            if (fs.existsSync(htmlFile)) {
                const markdown = fs.existsSync(markdownFile) ? fs.readFileSync(markdownFile, "utf8") : "";
                labItems.push({
                    type: "lab",
                    title: lab.title,
                    subtitle: "Hands-on lab",
                    text: metadata.stripMarkdown(markdown),
                    href: `labs/${path.basename(htmlFile)}`,
                    external: false,
                    duration: 0,
                    course: ""
                });
            }

            if (index < labs.length - 1 && delaySeconds > 0) {
                await wait(delaySeconds * 1000);
            }
        }
    }

    const examItems = [];
    if (exams.length) {
        const examsPath = path.join(pathPath, "exams");
        fs.mkdirSync(examsPath, { recursive: true });

        for (let index = 0; index < exams.length; index++) {
            const exam = exams[index];
            const baseName = `${String(index + 1).padStart(2, "0")}. ${sanitizeTitle(exam.title)}`;
            console.log(`\n=== Practice exam ${index + 1}/${exams.length}: ${exam.title} ===`);
            await downloadPracticeExam(exam.slug, cookie, examsPath, baseName, retries);

            const examJsonFile = path.join(examsPath, baseName + ".json");
            let text = "";
            if (fs.existsSync(examJsonFile)) {
                try {
                    const examData = JSON.parse(fs.readFileSync(examJsonFile, "utf8"));
                    text = (examData.questions || []).map(question => question.stem).filter(Boolean).join(" ");
                } catch (error) {
                    text = "";
                }
            }
            if (fs.existsSync(path.join(examsPath, baseName + ".html"))) {
                examItems.push({
                    type: "exam",
                    title: exam.title,
                    subtitle: "Practice exam",
                    text,
                    href: `exams/${baseName}.html`,
                    external: false,
                    duration: 0,
                    course: ""
                });
            }

            if (index < exams.length - 1 && delaySeconds > 0) {
                await wait(delaySeconds * 1000);
            }
        }
    }

    const pathItems = [];
    for (const result of courseResults) {
        const folder = path.basename(result.coursePath);
        for (const item of result.items) {
            const external = item.external || /^https?:\/\//i.test(item.href || "");
            pathItems.push({
                ...item,
                external,
                href: external ? item.href : `${folder}/${item.href}`,
                course: item.course || result.course.title
            });
        }
    }
    pathItems.push(...labItems, ...examItems);

    const pathPlaylistEntries = [];
    for (const result of courseResults) {
        pathPlaylistEntries.push(...result.playlistEntries);
    }

    if (wantPlaylist && pathPlaylistEntries.length) {
        metadata.writePlaylist(path.join(pathPath, "playlist.m3u"), pathPlaylistEntries);
    }

    fs.writeFileSync(path.join(pathPath, "manifest.json"), JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        path: {
            id: pathData.id,
            versionId: pathData.versionId,
            title: pathData.title,
            slug: pathData.slug
        },
        courses: courseResults.map(result => ({
            title: result.course.title,
            slug: result.course.slug,
            folder: path.basename(result.coursePath),
            manifest: path.join(path.basename(result.coursePath), "manifest.json")
        }))
    }, null, 2));

    if (wantIndex) {
        metadata.writeCatalog(
            path.join(pathPath, "index.html"),
            pathData.title,
            `Offline catalog · ${courses.length} courses · ${labItems.length} labs · ${examItems.length} exams`,
            pathItems,
            wantPlaylist && pathPlaylistEntries.length ? "playlist.m3u" : ""
        );
    }

    return { pathData, pathPath, items: pathItems, courseResults };
}

// Rebuild the Jellyfin library and ask the server to rescan
async function updateJellyfinLibrary() {
    const library = path.join(OUTPUT_ROOT, "jellyfin-tv");
    if (!fs.existsSync(library)) {
        return;
    }
    try {
        execFileSync(process.execPath, [path.join(__dirname, "scripts", "build-jellyfin-library.js")], { stdio: "inherit" });
        const tokenFile = path.join(os.homedir(), ".config", "jellyfin", "setup-token.txt");
        if (fs.existsSync(tokenFile)) {
            const token = fs.readFileSync(tokenFile, "utf8").trim();
            await fetch("http://localhost:8096/Library/Refresh", {
                method: "POST",
                headers: { Authorization: `MediaBrowser Token="${token}"` }
            }).catch(() => {});
        }
    } catch (error) {
        console.error(`Jellyfin-oppdatering feilet: ${error.message}`);
    }
}

// Locate a newer Chrome build if one was installed alongside the project
function chromeExecutable() {
    const browsersPath = path.join(__dirname, "browsers", "chrome");
    if (fs.existsSync(browsersPath)) {
        for (const version of fs.readdirSync(browsersPath)) {
            const executable = path.join(browsersPath, version, "chrome-linux64", "chrome");
            if (fs.existsSync(executable)) {
                return executable;
            }
        }
    }
}

// Retrieve login cookies
async function login() {
    puppeteerExtra.use(pluginStealth());
	const executable = chromeExecutable();
	const browser = await puppeteerExtra.launch({
		headless: false,
		executablePath: executable,
		// The bundled Chromium 80 needs --no-sandbox on modern kernels, newer Chrome does not
		args: executable
			? ["--disable-gpu", "--disable-dev-shm-usage"]
			: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
	});
    const page = await browser.newPage();
    await page.goto('https://app.pluralsight.com/id/');

    while (!page.url().startsWith("https://app.pluralsight.com/library")) {
        await wait(500);
    }

    const cookies = await page.cookies();

    const cookieData = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");

    fs.writeFileSync("./cookies.txt", cookieData);

    await browser.close();
};

const cookiesAvailable = fs.existsSync("./cookies.txt");

require('yargs')
    .showHelpOnFail(true)
    .command('login', 'Open session', (yargs) => {

    }, async (argv) => {

        console.log("Launching login window");
        await login();
        console.log("Cookies saved. You can now download courses");

    }) // eslint-disable-line
    .command('get [url]', 'Download course, lab guide or learning path', (yargs) => {
        yargs
            .positional('url', {
                describe: 'URL or Course ID to download'
            })
            .option('delay', {
                describe: 'Seconds to wait between clips and courses',
                type: 'number',
                default: CONFIG.delay
            })
            .option('quality', {
                describe: 'Video quality: 720, 1080 or best',
                type: 'string',
                default: CONFIG.quality
            })
            .option('subs', {
                describe: 'Subtitle languages: all, none or comma-separated codes',
                type: 'string',
                default: CONFIG.subs
            })
            .option('keep-srt', {
                describe: 'Keep external .srt files after embedding subtitles',
                type: 'boolean',
                default: CONFIG.keepSrt
            })
            .option('retries', {
                describe: 'Retries for failed requests and downloads',
                type: 'number',
                default: CONFIG.retries
            })
            .option('output', {
                describe: 'Output directory',
                type: 'string',
                default: CONFIG.outputDir
            })
            .option('chapters', {
                describe: 'Embed chapter markers in MP4 files',
                type: 'boolean',
                default: CONFIG.chapters
            })
            .option('resources', {
                describe: 'Download course resources',
                type: 'boolean',
                default: CONFIG.resources
            })
            .option('transcripts', {
                describe: 'Save searchable transcripts',
                type: 'boolean',
                default: CONFIG.transcripts
            })
            .option('nfo', {
                describe: 'Write Kodi/Jellyfin NFO files',
                type: 'boolean',
                default: CONFIG.nfo
            })
            .option('poster', {
                describe: 'Download course posters',
                type: 'boolean',
                default: CONFIG.poster
            })
            .option('playlist', {
                describe: 'Write .m3u playlists',
                type: 'boolean',
                default: CONFIG.playlist
            })
            .option('index', {
                describe: 'Write searchable index.html catalogs',
                type: 'boolean',
                default: CONFIG.index
            })
            .option('thumbnails', {
                describe: 'Generate video thumbnails',
                type: 'boolean',
                default: CONFIG.thumbnails
            })
            .option('tv-layout', {
                describe: 'Create Jellyfin/Kodi TV layout with symlinks and NFO',
                type: 'boolean',
                default: CONFIG.tvLayout
            })
            .option('notify', {
                describe: 'Show a desktop notification when finished',
                type: 'boolean',
                default: CONFIG.notify
            });
    }, async (argv) => {

        if (cookiesAvailable) {
            const input = argv.url;
            if (!input) {
                console.error("No URL or course ID provided.");
                process.exit(1);
            }

            const cookie = fs.readFileSync("./cookies.txt").toString();
            OUTPUT_ROOT = resolveOutputDir(argv.output);
            const options = {
                delay: argv.delay,
                quality: argv.quality,
                subs: argv.subs,
                keepSrt: argv.keepSrt,
                retries: argv.retries,
                chapters: argv.chapters,
                resources: argv.resources,
                transcripts: argv.transcripts,
                nfo: argv.nfo,
                poster: argv.poster,
                playlist: argv.playlist,
                index: argv.index,
                thumbnails: argv.thumbnails,
                tvLayout: argv.tvLayout,
                notify: argv.notify
            };

            try {
                if (isLearningPathUrl(input)) {
                    const pathId = pathIdFromUrl(input);
                    console.log("Downloading learning path: " + pathId);
                    await downloadLearningPath(pathId, cookie, options);
                } else if (isLabUrl(input)) {
                    const uid = labIdFromUrl(input);
                    const lab = await withRetry("Lab guide", () => getLabGuide(uid, cookie), options.retries);
                    const labsPath = path.join(OUTPUT_ROOT, "labs");
                    fs.mkdirSync(labsPath, { recursive: true });
                    const baseName = sanitizeTitle(lab.name);
                    const markdown = formatLabGuide(lab, input);
                    fs.writeFileSync(path.join(labsPath, baseName + ".md"), markdown);
                    const htmlFile = path.join(labsPath, baseName + ".html");
                    fs.writeFileSync(htmlFile, createLabPage(lab.name, markdown, input));
                    console.log("Saved lab guide: " + htmlFile);
                } else if (isExamUrl(input)) {
                    const slug = examSlugFromUrl(input);
                    const examsPath = path.join(OUTPUT_ROOT, "exams");
                    await downloadPracticeExam(slug, cookie, examsPath, sanitizeTitle(slug), options.retries);
                } else if (isIlxUrl(input)) {
                    const slug = ilxSlugFromUrl(input);
                    console.log("Downloading course: " + slug);
                    await downloadIlxCourse(slug, cookie, options);
                } else {
                    let courseId = input;
                    if (courseId.includes("/")) {
                        courseId = courseIdFromUrl(courseId);
                    }
                    console.log("Downloading course: " + courseId);
                    await downloadCourse(courseId, cookie);
                }

                if (!isLabUrl(input) && !isExamUrl(input)) {
                    await updateJellyfinLibrary();
                }

                if (options.notify) {
                    metadata.notify("Pluralsight", "Nedlastingen er ferdig");
                }
                if (CONFIG.webhookUrl) {
                    await metadata.sendWebhook(CONFIG.webhookUrl, {
                        title: "Pluralsight",
                        message: "Nedlastingen er ferdig",
                        url: input
                    });
                }
            } catch (error) {
                console.error("Something went wrong: " + error.message);
                console.error("Double check the URL and try logging in again.");
                if (options.notify) {
                    metadata.notify("Pluralsight", "Nedlastingen feilet");
                }
                if (CONFIG.webhookUrl) {
                    await metadata.sendWebhook(CONFIG.webhookUrl, {
                        title: "Pluralsight",
                        message: "Nedlastingen feilet: " + error.message,
                        url: input
                    });
                }
                process.exit(1);
            }
            
        } else {
            console.log("You need to login in order to download courses");
            console.log("$ npm run login");
        }

    })
    .help()
    .demandCommand()
    .argv;

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "videos");
const LIBRARY = path.join(ROOT, "jellyfin-tv");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function linkOrCopy(source, destination) {
  if (!fs.existsSync(source)) {
    return false;
  }
  if (fs.existsSync(destination)) {
    fs.unlinkSync(destination);
  }
  try {
    const realSource = fs.realpathSync(source);
    fs.linkSync(realSource, destination);
  } catch (error) {
    fs.copyFileSync(fs.realpathSync(source), destination);
  }
  return true;
}

function showDirectories() {
  const shows = [];
  for (const pathEntry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!pathEntry.isDirectory() || pathEntry.name === "jellyfin-tv" || pathEntry.name.startsWith(".")) {
      continue;
    }
    const pathDir = path.join(ROOT, pathEntry.name);
    if (fs.existsSync(path.join(pathDir, "tv"))) {
      const flatShows = path.join(pathDir, "tv");
      for (const showEntry of fs.readdirSync(flatShows, { withFileTypes: true })) {
        if (showEntry.isDirectory()) {
          shows.push(path.join(flatShows, showEntry.name));
        }
      }
      continue;
    }
    const tvDir = path.join(pathDir);
    if (!fs.existsSync(tvDir)) {
      continue;
    }
    for (const courseEntry of fs.readdirSync(tvDir, { withFileTypes: true })) {
      if (!courseEntry.isDirectory()) {
        continue;
      }
      const courseDir = path.join(tvDir, courseEntry.name);
      const tvShows = path.join(courseDir, "tv");
      if (!fs.existsSync(tvShows)) {
        continue;
      }
      for (const showEntry of fs.readdirSync(tvShows, { withFileTypes: true })) {
        if (showEntry.isDirectory()) {
          shows.push(path.join(tvShows, showEntry.name));
        }
      }
    }
  }
  return shows;
}

function build() {
  const shows = showDirectories();
  fs.rmSync(LIBRARY, { recursive: true, force: true });
  ensureDir(LIBRARY);
  let videos = 0;
  let metadata = 0;

  for (const showDir of shows) {
    const showName = path.basename(showDir);
    const destinationShow = path.join(LIBRARY, showName);
    ensureDir(destinationShow);

    const courseDir = path.dirname(path.dirname(showDir));
    for (const poster of ["poster.png", "poster.jpg", "fanart.png", "fanart.jpg"]) {
      if (linkOrCopy(path.join(courseDir, poster), path.join(destinationShow, poster))) {
        metadata++;
      }
    }

    if (linkOrCopy(path.join(showDir, "tvshow.nfo"), path.join(destinationShow, "tvshow.nfo"))) {
      metadata++;
    }

    const seasons = fs.readdirSync(showDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^Season/i.test(entry.name));
    for (const season of seasons) {
      const sourceSeason = path.join(showDir, season.name);
      const destinationSeason = path.join(destinationShow, season.name);
      ensureDir(destinationSeason);
      if (linkOrCopy(path.join(sourceSeason, "season.nfo"), path.join(destinationSeason, "season.nfo"))) {
        metadata++;
      }

      for (const file of fs.readdirSync(sourceSeason)) {
        const source = path.join(sourceSeason, file);
        if (!fs.existsSync(source)) {
          continue;
        }
        if (file.endsWith(".mp4")) {
          if (linkOrCopy(source, path.join(destinationSeason, file))) {
            videos++;
          }
        } else if (file.endsWith(".nfo") || file.endsWith("-thumb.jpg")) {
          if (linkOrCopy(source, path.join(destinationSeason, file))) {
            metadata++;
          }
        }
      }
    }
  }

  console.log(`Jellyfin library: ${shows.length} shows, ${videos} episodes, ${metadata} metadata files`);
  console.log(LIBRARY);
}

build();

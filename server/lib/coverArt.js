const http = require("http");
const https = require("https");
const crypto = require("crypto");

const log = require("debug")("lib:coverArt");

const lookupCache = new Map();
const imageCache = new Map();
let imageCacheSizeBytes = 0;

const ONE_MB = 1024 * 1024;

const sanitize = (value) => (typeof value === "string" ? value.trim() : "");

const getTrackFields = (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : {};
    return {
        artist: sanitize(track["upnp:artist"]),
        album: sanitize(track["upnp:album"]),
        title: sanitize(track["dc:title"])
    };
};

const getTrackKey = (metadata) => {
    const fields = getTrackFields(metadata);
    return `${fields.artist}|${fields.album}|${fields.title}`.toLowerCase();
};

const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);

const requestJson = (url) => new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.get(parsedUrl, { timeout: 4500, headers: { "User-Agent": "wiim-now-playing/cover-art" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
            resolve(requestJson(redirectUrl));
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
        }
        let data = "";
        res.on("data", (chunk) => {
            data += chunk;
            if (data.length > 2 * ONE_MB) {
                req.destroy(new Error("JSON response too large"));
            }
        });
        res.on("end", () => {
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                reject(error);
            }
        });
    });
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
});

const requestImage = (url) => new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.get(parsedUrl, { timeout: 6000, headers: { "User-Agent": "wiim-now-playing/cover-art" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
            resolve(requestImage(redirectUrl));
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
        }
        const contentType = res.headers["content-type"] || "";
        if (!contentType.startsWith("image/")) {
            res.resume();
            reject(new Error("Not an image"));
            return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 12 * ONE_MB) {
                req.destroy(new Error("Image too large"));
                return;
            }
            chunks.push(chunk);
        });
        res.on("end", () => {
            resolve({
                buffer: Buffer.concat(chunks),
                contentType,
                bytes: size
            });
        });
    });
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
});

const touchImageEntry = (key) => {
    const entry = imageCache.get(key);
    if (!entry) {
        return null;
    }
    imageCache.delete(key);
    imageCache.set(key, entry);
    return entry;
};

const getImagePoolBytes = (serverSettings) => {
    const maxMB = serverSettings && serverSettings.features && serverSettings.features.coverArt && typeof serverSettings.features.coverArt.memoryPoolMB === "number"
        ? Math.max(0, serverSettings.features.coverArt.memoryPoolMB)
        : 100;
    return Math.floor(maxMB * ONE_MB);
};

const enforceImagePoolLimit = (serverSettings) => {
    const limitBytes = getImagePoolBytes(serverSettings);
    while (imageCacheSizeBytes > limitBytes && imageCache.size > 0) {
        const oldestKey = imageCache.keys().next().value;
        const oldest = imageCache.get(oldestKey);
        imageCache.delete(oldestKey);
        imageCacheSizeBytes -= oldest.bytes;
    }
};

const normalizeForQuery = (value) => sanitize(value).replace(/\(([^)]*remaster[^)]*)\)/gi, "").replace(/\s-\s*live$/i, "").trim();

const lookupFromITunes = async (artist, album, title) => {
    const term = album ? `${artist} ${album}` : `${artist} ${title}`;
    const payload = await requestJson(`https://itunes.apple.com/search?entity=album&limit=5&term=${encodeURIComponent(term)}`);
    if (!payload || !Array.isArray(payload.results) || payload.results.length === 0) {
        return null;
    }
    const best = payload.results[0];
    if (!best.artworkUrl100) {
        return null;
    }
    return best.artworkUrl100.replace("100x100bb", "600x600bb");
};

const lookupFromCAA = async (artist, album) => {
    if (!artist || !album) {
        return null;
    }
    const query = `artist:"${artist}" AND releasegroup:"${album}"`;
    const payload = await requestJson(`https://musicbrainz.org/ws/2/release-group?fmt=json&limit=1&query=${encodeURIComponent(query)}`);
    const groups = payload && payload["release-groups"];
    if (!Array.isArray(groups) || groups.length === 0 || !groups[0].id) {
        return null;
    }
    return `https://coverartarchive.org/release-group/${groups[0].id}/front-500`;
};

const resolveLookupUrl = async (metadata, serverSettings) => {
    const { artist, album, title } = getTrackFields(metadata);
    const cleanArtist = normalizeForQuery(artist);
    const cleanAlbum = normalizeForQuery(album);
    const cleanTitle = normalizeForQuery(title);

    if (!cleanArtist || (!cleanAlbum && !cleanTitle)) {
        return null;
    }

    const configuredProvider = String(serverSettings.features.coverArt.provider || "").toLowerCase();
    if (configuredProvider === "caa") {
        return lookupFromCAA(cleanArtist, cleanAlbum);
    }
    if (configuredProvider !== "itunes") {
        log("Unknown cover-art provider configured, falling back to iTunes", configuredProvider);
    }
    return lookupFromITunes(cleanArtist, cleanAlbum, cleanTitle);
};

const resolveAlbumArt = async (metadata, serverSettings) => {
    const key = getTrackKey(metadata);
    if (!key) {
        return null;
    }

    if (lookupCache.has(key)) {
        return lookupCache.get(key);
    }

    const pending = (async () => {
        try {
            const url = await resolveLookupUrl(metadata, serverSettings);
            if (!url) {
                return null;
            }
            const image = await requestImage(url);
            const cacheKey = hash(`${key}|${url}`);
            const cached = touchImageEntry(cacheKey);
            if (!cached) {
                imageCache.set(cacheKey, {
                    ...image,
                    provider: serverSettings.features.coverArt.provider,
                    sourceUrl: url,
                    trackKey: key
                });
                imageCacheSizeBytes += image.bytes;
                enforceImagePoolLimit(serverSettings);
            }
            return {
                cacheKey,
                provider: serverSettings.features.coverArt.provider,
                trackKey: key
            };
        } catch (error) {
            log("resolveAlbumArt error", error.message);
            return null;
        }
    })();

    lookupCache.set(key, pending);
    const result = await pending;
    lookupCache.delete(key);
    return result;
};

const getCachedImage = (cacheKey) => touchImageEntry(cacheKey);

const applySettings = (serverSettings) => {
    enforceImagePoolLimit(serverSettings);
};

module.exports = {
    getTrackKey,
    resolveAlbumArt,
    getCachedImage,
    applySettings
};

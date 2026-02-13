// ===========================================================================
// coverArt.js

const https = require("https");
const { URL } = require("url");
const log = require("debug")("lib:coverArt");

const DEFAULT_POOL_MB = 100;
const LOOKUP_TTL_MS = 60 * 60 * 1000;
const LOOKUP_MISS_TTL_MS = 10 * 60 * 1000;

const state = {
    poolMaxBytes: DEFAULT_POOL_MB * 1024 * 1024,
    poolUsedBytes: 0,
    imagePool: new Map(), // id -> { buffer, contentType, size }
    lookupCache: new Map(), // trackKey -> { id|null, expiresAt }
    inFlightLookups: new Map()
};

const normalizeText = (value) => {
    if (!value || typeof value !== "string") {
        return "";
    }
    return value
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/\[.*?\]/g, " ")
        .replace(/\s+-\s+(live|remaster(ed)?|radio edit).*$/i, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const buildTrackKey = (trackMetaData) => {
    if (!trackMetaData) {
        return "";
    }
    const artist = normalizeText(trackMetaData["upnp:artist"]);
    const album = normalizeText(trackMetaData["upnp:album"]);
    const title = normalizeText(trackMetaData["dc:title"]);
    if (!artist || (!album && !title)) {
        return "";
    }
    return `${artist}|${album}|${title}`;
};

const updatePoolLimit = (poolMB) => {
    const nextMaxBytes = Math.max(0, Math.round(poolMB * 1024 * 1024));
    state.poolMaxBytes = nextMaxBytes;
    evictIfNeeded();
};

const evictIfNeeded = () => {
    while (state.poolUsedBytes > state.poolMaxBytes && state.imagePool.size > 0) {
        const oldestKey = state.imagePool.keys().next().value;
        const oldestEntry = state.imagePool.get(oldestKey);
        state.imagePool.delete(oldestKey);
        state.poolUsedBytes -= oldestEntry.size;
        log("Evicted cached cover art", oldestKey, "bytes", oldestEntry.size);
    }
};

const putInPool = (id, contentType, buffer) => {
    if (!id || !buffer || !buffer.length) {
        return;
    }

    if (state.imagePool.has(id)) {
        const previous = state.imagePool.get(id);
        state.poolUsedBytes -= previous.size;
        state.imagePool.delete(id);
    }

    const size = buffer.length;
    if (size > state.poolMaxBytes) {
        log("Image is larger than pool max, skipping cache", id, size, state.poolMaxBytes);
        return;
    }

    state.imagePool.set(id, { contentType, buffer, size });
    state.poolUsedBytes += size;
    evictIfNeeded();
};

const getFromPool = (id) => {
    if (!state.imagePool.has(id)) {
        return null;
    }
    const entry = state.imagePool.get(id);
    // Refresh LRU order
    state.imagePool.delete(id);
    state.imagePool.set(id, entry);
    return entry;
};

const request = (urlString, options = {}, redirects = 0) => new Promise((resolve, reject) => {
    if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
    }

    const url = new URL(urlString);
    const req = https.request(
        {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: options.headers || {},
            timeout: options.timeoutMs || 5000
        },
        (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                resolve(request(redirectUrl, options, redirects + 1));
                return;
            }

            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const body = Buffer.concat(chunks);
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body
                });
            });
        }
    );

    req.on("timeout", () => {
        req.destroy(new Error("Request timeout"));
    });
    req.on("error", reject);
    req.end();
});

const lookupMusicBrainzRelease = async (trackMetaData) => {
    const artist = trackMetaData && trackMetaData["upnp:artist"] ? trackMetaData["upnp:artist"].trim() : "";
    const album = trackMetaData && trackMetaData["upnp:album"] ? trackMetaData["upnp:album"].trim() : "";
    const title = trackMetaData && trackMetaData["dc:title"] ? trackMetaData["dc:title"].trim() : "";

    if (!artist || (!album && !title)) {
        return null;
    }

    const queryParts = [];
    if (album) {
        queryParts.push(`release:\"${album}\"`);
    }
    if (artist) {
        queryParts.push(`artist:\"${artist}\"`);
    }
    if (!album && title) {
        queryParts.push(`recording:\"${title}\"`);
    }

    const query = queryParts.join(" AND ");
    const url = `https://musicbrainz.org/ws/2/release/?fmt=json&limit=1&query=${encodeURIComponent(query)}`;

    const response = await request(url, {
        timeoutMs: 5000,
        headers: {
            "User-Agent": "WiiM-Now-Playing/1.0 (+https://github.com/)"
        }
    });

    if (response.statusCode !== 200) {
        return null;
    }

    const payload = JSON.parse(response.body.toString("utf8"));
    if (!payload || !Array.isArray(payload.releases) || payload.releases.length === 0) {
        return null;
    }

    return payload.releases[0].id || null;
};

const fetchCAAFrontCover = async (releaseId) => {
    const url = `https://coverartarchive.org/release/${encodeURIComponent(releaseId)}/front-500`;
    const response = await request(url, {
        timeoutMs: 7000,
        headers: {
            "User-Agent": "WiiM-Now-Playing/1.0 (+https://github.com/)"
        }
    });

    if (response.statusCode !== 200) {
        return null;
    }

    const contentType = response.headers["content-type"] || "image/jpeg";
    if (!contentType.startsWith("image/")) {
        return null;
    }

    return {
        contentType,
        buffer: response.body
    };
};

const configure = (serverSettings) => {
    const coverSettings =
        serverSettings && serverSettings.features && serverSettings.features.coverArt
            ? serverSettings.features.coverArt
            : null;
    const poolMB = coverSettings && typeof coverSettings.memoryPoolMB === "number"
        ? coverSettings.memoryPoolMB
        : DEFAULT_POOL_MB;
    updatePoolLimit(poolMB);
};

const isEnabled = (serverSettings) => Boolean(
    serverSettings &&
    serverSettings.features &&
    serverSettings.features.coverArt &&
    serverSettings.features.coverArt.enabled
);

const getCachedCoverUrl = (id) => {
    const entry = getFromPool(id);
    if (!entry) {
        return null;
    }
    return `/cover-art/${encodeURIComponent(id)}`;
};

const resolveCoverUrl = async (trackMetaData, serverSettings) => {
    if (!isEnabled(serverSettings) || !trackMetaData) {
        return null;
    }

    const trackKey = buildTrackKey(trackMetaData);
    if (!trackKey) {
        return null;
    }

    const now = Date.now();
    const lookupCached = state.lookupCache.get(trackKey);
    if (lookupCached && lookupCached.expiresAt > now) {
        if (!lookupCached.id) {
            return null;
        }
        return getCachedCoverUrl(lookupCached.id);
    }

    if (state.inFlightLookups.has(trackKey)) {
        return state.inFlightLookups.get(trackKey);
    }

    const lookupPromise = (async () => {
        try {
            const releaseId = await lookupMusicBrainzRelease(trackMetaData);
            if (!releaseId) {
                state.lookupCache.set(trackKey, { id: null, expiresAt: now + LOOKUP_MISS_TTL_MS });
                return null;
            }

            const coverId = `caa:${releaseId}:front-500`;
            const cachedUrl = getCachedCoverUrl(coverId);
            if (cachedUrl) {
                state.lookupCache.set(trackKey, { id: coverId, expiresAt: now + LOOKUP_TTL_MS });
                return cachedUrl;
            }

            const coverImage = await fetchCAAFrontCover(releaseId);
            if (!coverImage) {
                state.lookupCache.set(trackKey, { id: null, expiresAt: now + LOOKUP_MISS_TTL_MS });
                return null;
            }

            putInPool(coverId, coverImage.contentType, coverImage.buffer);
            state.lookupCache.set(trackKey, { id: coverId, expiresAt: now + LOOKUP_TTL_MS });
            return `/cover-art/${encodeURIComponent(coverId)}`;
        } catch (error) {
            log("resolveCoverUrl error", error.message);
            state.lookupCache.set(trackKey, { id: null, expiresAt: now + LOOKUP_MISS_TTL_MS });
            return null;
        } finally {
            state.inFlightLookups.delete(trackKey);
        }
    })();

    state.inFlightLookups.set(trackKey, lookupPromise);
    return lookupPromise;
};

const getCoverImage = (id) => {
    if (!id) {
        return null;
    }
    return getFromPool(id);
};

module.exports = {
    configure,
    resolveCoverUrl,
    getCoverImage,
    buildTrackKey,
    _state: state
};

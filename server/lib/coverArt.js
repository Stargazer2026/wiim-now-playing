const http = require("http");
const https = require("https");
const crypto = require("crypto");

const log = require("debug")("lib:coverArt");

const lookupCache = new Map();
const imageCache = new Map();
const transientFailureCache = new Map();
const generationResultCache = new Map();
let imageCacheSizeBytes = 0;

const ONE_MB = 1024 * 1024;
const TRANSIENT_FAILURE_TTL_MS = 2 * 60 * 1000;
const AI_RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504, 520, 522, 524, 530]);
const OPENAI_API_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_API_TIMEOUT_MS = Math.max(30000, Number(process.env.OPENAI_API_TIMEOUT_MS) || 180000);
const OPENAI_MAX_RESPONSE_BYTES = Math.max(2 * ONE_MB, Number(process.env.OPENAI_MAX_RESPONSE_BYTES) || 20 * ONE_MB);

const sanitize = (value) => (typeof value === "string" ? value.trim() : "");

const getTrackFields = (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : {};
    return {
        artist: sanitize(track["upnp:artist"]),
        album: sanitize(track["upnp:album"]),
        title: sanitize(track["dc:title"])
    };
};

const getLyricsSnippet = (lyricsPayload) => {
    const source = lyricsPayload && typeof lyricsPayload === "object"
        ? (lyricsPayload.plainLyrics || lyricsPayload.syncedLyrics || "")
        : "";
    if (!source || typeof source !== "string") {
        return "";
    }

    return source
        .split(/\r?\n/)
        .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
        .filter((line) => line && !line.startsWith("#"))
        .slice(0, 4)
        .join(" ")
        .slice(0, 320);
};

const buildAIPrompt = (artist, album, title, lyricsPayload) => {
    const parts = [
        `Create cover art for the song \"${title}\" by ${artist}`,
        album ? `from the album \"${album}\"` : "",
        "Cinematic digital painting, detailed, no text, no logos, no watermarks."
    ].filter(Boolean);

    const lyricsSnippet = getLyricsSnippet(lyricsPayload);
    if (lyricsSnippet) {
        parts.push(`Mood and imagery inspired by these lyrics: ${lyricsSnippet}`);
    }

    return parts.join(" ");
};

const getTrackKey = (metadata) => {
    const fields = getTrackFields(metadata);
    return `${fields.artist}|${fields.album}|${fields.title}`.toLowerCase();
};

const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);


const getGenerationCacheKey = (provider, trackKey) => `${provider || "unknown"}|${trackKey || ""}`;

const getCachedGenerationResult = (provider, trackKey) => {
    const key = getGenerationCacheKey(provider, trackKey);
    return generationResultCache.get(key) || null;
};

const setCachedGenerationResult = (provider, trackKey, value) => {
    const key = getGenerationCacheKey(provider, trackKey);
    generationResultCache.set(key, value);
};


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
            log("requestJson non-200", {
                url: parsedUrl.toString(),
                statusCode: res.statusCode,
                headers: {
                    server: res.headers.server,
                    via: res.headers.via,
                    cfRay: res.headers["cf-ray"],
                    contentType: res.headers["content-type"]
                }
            });
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
        }
        let data = "";
        res.on("data", (chunk) => {
            data += chunk;
            if (data.length > OPENAI_MAX_RESPONSE_BYTES) {
                req.destroy(new Error(`JSON response too large (>${OPENAI_MAX_RESPONSE_BYTES} bytes)`));
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


const postJson = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(parsedUrl, {
        method: "POST",
        timeout: OPENAI_API_TIMEOUT_MS,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "User-Agent": "wiim-now-playing/cover-art",
            ...headers
        }
    }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
            data += chunk;
            if (data.length > OPENAI_MAX_RESPONSE_BYTES) {
                req.destroy(new Error(`JSON response too large (>${OPENAI_MAX_RESPONSE_BYTES} bytes)`));
            }
        });
        res.on("end", () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                log("postJson non-200", {
                    url,
                    statusCode: res.statusCode,
                    headers: {
                        server: res.headers.server,
                        contentType: res.headers["content-type"]
                    },
                    bodyPreview: data.replace(/\s+/g, " ").trim().slice(0, 400)
                });
                const error = new Error(`HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                error.bodyPreview = data.replace(/\s+/g, " ").trim().slice(0, 400);
                error.requestUrl = url;
                reject(error);
                return;
            }
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                reject(error);
            }
        });
    });
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
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
            let errorBody = "";
            res.on("data", (chunk) => {
                if (errorBody.length < 1200) {
                    errorBody += chunk.toString("utf8");
                }
            });
            res.on("end", () => {
                const bodyPreview = errorBody.replace(/\s+/g, " ").trim().slice(0, 400);
                const cloudflareErrorMatch = bodyPreview.match(/error code:\s*(\d{3,4})/i);
                const cfErrorCode = cloudflareErrorMatch ? parseInt(cloudflareErrorMatch[1], 10) : null;
                const diagnostic = {
                    url: parsedUrl.toString(),
                    statusCode: res.statusCode,
                    headers: {
                        server: res.headers.server,
                        via: res.headers.via,
                        cfRay: res.headers["cf-ray"],
                        contentType: res.headers["content-type"]
                    },
                    cfErrorCode,
                    bodyPreview
                };
                if (cfErrorCode === 1033) {
                    diagnostic.hint = "Cloudflare 1033: origin/tunnel unreachable (likely upstream Pollinations outage or routing issue)";
                }
                log("requestImage non-200", diagnostic);
                const error = new Error(`HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                error.responseHeaders = diagnostic.headers;
                error.bodyPreview = bodyPreview;
                error.cfErrorCode = cfErrorCode;
                error.requestUrl = parsedUrl.toString();
                reject(error);
            });
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

const lookupFromAiPollinations = async (artist, album, title, lyricsPayload) => {
    if (!artist || !title) {
        return null;
    }

    const prompt = buildAIPrompt(artist, album, title, lyricsPayload);
    const encodedPrompt = encodeURIComponent(prompt);
    const query = "width=1024&height=1024&model=flux&nologo=true";
    const urls = [
        `https://image.pollinations.ai/prompt/${encodedPrompt}?${query}`,
        `https://pollinations.ai/prompt/${encodedPrompt}?${query}`,
        `https://pollinations.ai/p/${encodedPrompt}?${query}`
    ];
    log("lookupFromAiPollinations", {
        artist,
        album,
        title,
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 180),
        candidateUrls: urls
    });
    return urls;
};


const extractOpenAiImage = (response) => {
    if (!response || !Array.isArray(response.data) || !response.data[0]) {
        return null;
    }
    const first = response.data[0];
    if (first.url && typeof first.url === "string") {
        return {
            mode: "url",
            url: first.url
        };
    }
    if (first.b64_json && typeof first.b64_json === "string") {
        const buffer = Buffer.from(first.b64_json, "base64");
        if (!buffer.length) {
            return null;
        }
        return {
            mode: "inline",
            image: {
                buffer,
                contentType: "image/png",
                bytes: buffer.length,
                sourceUrl: "openai:b64_json"
            }
        };
    }
    return null;
};

const lookupFromOpenAi = async (artist, album, title, lyricsPayload) => {
    if (!artist || !title) {
        return null;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        log("lookupFromOpenAi skipped: OPENAI_API_KEY not set");
        return null;
    }

    const prompt = buildAIPrompt(artist, album, title, lyricsPayload);
    const payload = {
        model: "gpt-image-1-mini",
        prompt,
        size: "1024x1024",
        quality: "low"
    };
    const response = await postJson(OPENAI_API_URL, payload, {
        Authorization: `Bearer ${apiKey}`
    });
    const parsed = extractOpenAiImage(response);
    if (!parsed) {
        log("lookupFromOpenAi missing image payload", {
            hasData: Boolean(response && response.data),
            firstKeys: response && Array.isArray(response.data) && response.data[0] ? Object.keys(response.data[0]) : []
        });
        return null;
    }

    const usage = response && response.usage ? response.usage : null;
    log("lookupFromOpenAi", {
        artist,
        album,
        title,
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 180),
        resultMode: parsed.mode,
        imageUrl: parsed.url || null,
        imageBytes: parsed.image ? parsed.image.bytes : null,
        promptTokens: usage ? usage.prompt_tokens : null,
        totalTokens: usage ? usage.total_tokens : null
    });
    return parsed.mode === "url" ? parsed.url : parsed.image;
};

const resolveLookupUrl = async (metadata, serverSettings, lyricsPayload) => {
    const { artist, album, title } = getTrackFields(metadata);
    const cleanArtist = normalizeForQuery(artist);
    const cleanAlbum = normalizeForQuery(album);
    const cleanTitle = normalizeForQuery(title);

    if (!cleanArtist || (!cleanAlbum && !cleanTitle)) {
        return null;
    }

    const provider = serverSettings.features.coverArt.provider;
    if (provider === "itunes") {
        return lookupFromITunes(cleanArtist, cleanAlbum, cleanTitle);
    }
    if (provider === "ai") {
        return lookupFromAiPollinations(cleanArtist, cleanAlbum, cleanTitle, lyricsPayload);
    }
    if (provider === "openai") {
        return lookupFromOpenAi(cleanArtist, cleanAlbum, cleanTitle, lyricsPayload);
    }
    return lookupFromCAA(cleanArtist, cleanAlbum);
};


const getHttpStatusCodeFromError = (error) => {
    if (!error) {
        return null;
    }
    if (typeof error.statusCode === "number") {
        return error.statusCode;
    }
    if (!error.message || typeof error.message !== "string") {
        return null;
    }
    const match = error.message.match(/^HTTP\s+(\d{3})$/);
    if (!match) {
        return null;
    }
    return parseInt(match[1], 10);
};

const shouldSuppressTransientFailure = (trackKey, provider) => {
    if (!trackKey || !provider) {
        return false;
    }
    const cacheKey = `${provider}|${trackKey}`;
    const expiresAt = transientFailureCache.get(cacheKey);
    if (!expiresAt) {
        return false;
    }
    if (expiresAt <= Date.now()) {
        transientFailureCache.delete(cacheKey);
        return false;
    }
    return true;
};

const cacheTransientFailure = (trackKey, provider) => {
    if (!trackKey || !provider) {
        return;
    }
    transientFailureCache.set(`${provider}|${trackKey}`, Date.now() + TRANSIENT_FAILURE_TTL_MS);
};

const resolveAlbumArt = async (metadata, serverSettings, lyricsPayload) => {
    const key = getTrackKey(metadata);
    if (!key) {
        return null;
    }
    const provider = serverSettings && serverSettings.features && serverSettings.features.coverArt ? serverSettings.features.coverArt.provider : null;
    const isGeneratedProvider = provider === "ai" || provider === "openai";

    if (isGeneratedProvider) {
        const prior = getCachedGenerationResult(provider, key);
        if (prior && prior.status === "ok" && prior.cacheKey) {
            const cachedImage = touchImageEntry(prior.cacheKey);
            if (cachedImage) {
                return {
                    cacheKey: prior.cacheKey,
                    provider,
                    trackKey: key
                };
            }
            log("resolveAlbumArt generation cache miss after eviction", {
                provider,
                trackKey: key,
                cacheKey: prior.cacheKey
            });
            return null;
        }
        if (prior && (prior.status === "failed" || prior.status === "in_flight")) {
            return null;
        }
    }

    if (shouldSuppressTransientFailure(key, provider)) {
        return null;
    }
    const lookupCacheKey = isGeneratedProvider ? `${provider}|${key}` : key;
    if (lookupCache.has(lookupCacheKey)) {
        return lookupCache.get(lookupCacheKey);
    }

    if (isGeneratedProvider) {
        setCachedGenerationResult(provider, key, { status: "in_flight" });
    }

    const pending = (async () => {
        try {
            const lookup = await resolveLookupUrl(metadata, serverSettings, lyricsPayload);
            if (!lookup) {
                if (isGeneratedProvider) {
                    setCachedGenerationResult(provider, key, { status: "failed", reason: "no-lookup" });
                }
                return null;
            }
            let image = null;
            let resolvedUrl = null;
            let lastError = null;

            const isInlineImage = lookup && typeof lookup === "object" && Buffer.isBuffer(lookup.buffer) && typeof lookup.contentType === "string";
            if (isInlineImage) {
                image = {
                    buffer: lookup.buffer,
                    contentType: lookup.contentType,
                    bytes: lookup.bytes || lookup.buffer.length
                };
                resolvedUrl = lookup.sourceUrl || `${provider}:inline`;
            } else {
                const candidateUrls = Array.isArray(lookup) ? lookup : [lookup];
                for (const candidateUrl of candidateUrls) {
                    try {
                        log("resolveAlbumArt fetch image", {
                            provider,
                            trackKey: key,
                            url: candidateUrl
                        });
                        image = await requestImage(candidateUrl);
                        resolvedUrl = candidateUrl;
                        break;
                    } catch (error) {
                        lastError = error;
                        log("resolveAlbumArt candidate failed", {
                            provider,
                            trackKey: key,
                            url: candidateUrl,
                            statusCode: getHttpStatusCodeFromError(error),
                            cfErrorCode: error.cfErrorCode || null,
                            message: error.message
                        });
                    }
                }
                if (!image || !resolvedUrl) {
                    throw lastError || new Error("All AI candidate URLs failed");
                }
            }
            const cacheKey = hash(`${key}|${resolvedUrl}`);
            const cached = touchImageEntry(cacheKey);
            if (!cached) {
                imageCache.set(cacheKey, {
                    ...image,
                    provider: serverSettings.features.coverArt.provider,
                    sourceUrl: resolvedUrl,
                    trackKey: key
                });
                imageCacheSizeBytes += image.bytes;
                enforceImagePoolLimit(serverSettings);
            }
            const result = {
                cacheKey,
                provider: serverSettings.features.coverArt.provider,
                trackKey: key
            };
            if (isGeneratedProvider) {
                setCachedGenerationResult(provider, key, {
                    status: "ok",
                    cacheKey
                });
            }
            return result;
        } catch (error) {
            const statusCode = getHttpStatusCodeFromError(error);
            if ((provider === "ai" || provider === "openai") && statusCode && AI_RETRYABLE_HTTP_CODES.has(statusCode)) {
                cacheTransientFailure(key, provider);
                log("resolveAlbumArt transient AI error", {
                    statusCode,
                    cfErrorCode: error.cfErrorCode || null,
                    trackKey: key,
                    requestUrl: error.requestUrl || null,
                    bodyPreview: error.bodyPreview || null,
                    message: error.message,
                    note: "suppressing retries briefly"
                });
                if (isGeneratedProvider) {
                    setCachedGenerationResult(provider, key, { status: "failed", reason: "transient-error" });
                }
                return null;
            }
            log("resolveAlbumArt error", {
                provider,
                trackKey: key,
                statusCode,
                cfErrorCode: error.cfErrorCode || null,
                requestUrl: error.requestUrl || null,
                bodyPreview: error.bodyPreview || null,
                message: error.message
            });
            if (isGeneratedProvider) {
                setCachedGenerationResult(provider, key, { status: "failed", reason: "error" });
            }
            return null;
        }
    })();

    lookupCache.set(lookupCacheKey, pending);
    const result = await pending;
    lookupCache.delete(lookupCacheKey);
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
    applySettings,
    buildAIPrompt,
    getLyricsSnippet,
    getHttpStatusCodeFromError,
    extractOpenAiImage
};

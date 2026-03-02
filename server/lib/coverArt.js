const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

const lib = require("./lib.js");
const { generateCoverConcept } = require("./coverConceptService.js");
const { getLyricsSnippet } = require("./lyricsSnippet.js");
const log = require("debug")("lib:coverArt");

const lookupCache = new Map();
const imageCache = new Map();
const transientFailureCache = new Map();
const generationResultCache = new Map();
const persistentTrackCache = new Map();
const persistentImageIndex = new Map();
const promptHistoryByTrack = new Map();
let imageCacheSizeBytes = 0;

const ONE_MB = 1024 * 1024;
const TRANSIENT_FAILURE_TTL_MS = 2 * 60 * 1000;
const AI_RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504, 520, 522, 524, 530]);
const OPENAI_API_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_API_TIMEOUT_MS = Math.max(30000, Number(process.env.OPENAI_API_TIMEOUT_MS) || 180000);
const OPENAI_MAX_RESPONSE_BYTES = Math.max(2 * ONE_MB, Number(process.env.OPENAI_MAX_RESPONSE_BYTES) || 20 * ONE_MB);
const PERSISTENT_CACHE_DIR = path.resolve(process.env.WNP_COVER_ART_CACHE_DIR || "../cover-art-cache");
const PERSISTENT_INDEX_FILE = path.join(PERSISTENT_CACHE_DIR, "index.json");

const sanitize = (value) => (typeof value === "string" ? value.trim() : "");
const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);

const ensurePersistentStorage = () => {
    if (!fs.existsSync(PERSISTENT_CACHE_DIR)) {
        fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
    }
};

const getVariantKey = (variantIndex, quality) => `${Number(variantIndex) || 0}|${quality || "low"}`;

const loadPersistentIndex = () => {
    ensurePersistentStorage();
    if (!fs.existsSync(PERSISTENT_INDEX_FILE)) {
        return;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(PERSISTENT_INDEX_FILE, "utf8"));
        const tracks = parsed?.tracks && typeof parsed.tracks === "object" ? parsed.tracks : {};
        const images = parsed?.images && typeof parsed.images === "object" ? parsed.images : {};
        const promptHistory = parsed?.promptHistory && typeof parsed.promptHistory === "object" ? parsed.promptHistory : {};

        Object.keys(images).forEach((cacheKey) => {
            const entry = images[cacheKey];
            if (!entry || typeof entry.fileName !== "string") {
                return;
            }
            const filePath = path.join(PERSISTENT_CACHE_DIR, entry.fileName);
            if (!fs.existsSync(filePath)) {
                return;
            }
            persistentImageIndex.set(cacheKey, {
                fileName: entry.fileName,
                contentType: entry.contentType || "image/png",
                bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
                sourceUrl: entry.sourceUrl || "openai:persistent",
                variantIndex: typeof entry.variantIndex === "number" ? entry.variantIndex : 0,
                aiDebug: entry.aiDebug && typeof entry.aiDebug === "object" ? entry.aiDebug : null
            });
        });

        Object.keys(tracks).forEach((trackKey) => {
            const mapping = tracks[trackKey];
            if (!mapping || typeof mapping !== "object") {
                return;
            }
            const usable = {};
            Object.keys(mapping).forEach((variantKey) => {
                const cacheKey = mapping[variantKey];
                if (typeof cacheKey === "string" && persistentImageIndex.has(cacheKey)) {
                    usable[variantKey] = cacheKey;
                }
            });
            if (Object.keys(usable).length) {
                persistentTrackCache.set(trackKey, usable);
            }
        });

        Object.keys(promptHistory).forEach((trackKey) => {
            if (Array.isArray(promptHistory[trackKey])) {
                promptHistoryByTrack.set(trackKey, promptHistory[trackKey].filter((line) => typeof line === "string").slice(-12));
            }
        });
    } catch (error) {
        log("loadPersistentIndex error", { message: error.message });
    }
};

const savePersistentIndex = () => {
    ensurePersistentStorage();
    const tracks = {};
    const images = {};
    const promptHistory = {};
    persistentTrackCache.forEach((mapping, trackKey) => {
        tracks[trackKey] = mapping;
    });
    persistentImageIndex.forEach((entry, cacheKey) => {
        images[cacheKey] = {
            fileName: entry.fileName,
            contentType: entry.contentType,
            bytes: entry.bytes,
            sourceUrl: entry.sourceUrl,
            variantIndex: entry.variantIndex || 0,
            aiDebug: entry.aiDebug || null
        };
    });
    promptHistoryByTrack.forEach((list, trackKey) => {
        promptHistory[trackKey] = list;
    });
    fs.writeFileSync(PERSISTENT_INDEX_FILE, JSON.stringify({ tracks, images, promptHistory }, null, 2), "utf8");
};

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

const getSongKeyHash = (metadata) => hash(getTrackKey(metadata));

const requestJson = (url) => new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.get(parsedUrl, { timeout: 4500, headers: { "User-Agent": "wiim-now-playing/cover-art" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            resolve(requestJson(new URL(res.headers.location, parsedUrl).toString()));
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
    const payload = JSON.stringify(body);
    const req = https.request(new URL(url), {
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
                const error = new Error(`HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                error.bodyPreview = data.replace(/\s+/g, " ").trim().slice(0, 400);
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
            resolve(requestImage(new URL(res.headers.location, parsedUrl).toString()));
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
                const error = new Error(`HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                error.bodyPreview = errorBody.replace(/\s+/g, " ").trim().slice(0, 400);
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
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType, bytes: size }));
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

const loadPersistentImageIntoMemory = (cacheKey) => {
    const meta = persistentImageIndex.get(cacheKey);
    if (!meta) {
        return null;
    }
    try {
        const buffer = fs.readFileSync(path.join(PERSISTENT_CACHE_DIR, meta.fileName));
        const entry = {
            buffer,
            contentType: meta.contentType || "image/png",
            bytes: buffer.length,
            provider: "openai",
            sourceUrl: meta.sourceUrl || "openai:persistent"
        };
        imageCache.set(cacheKey, entry);
        imageCacheSizeBytes += entry.bytes;
        return entry;
    } catch {
        return null;
    }
};

const getImagePoolBytes = (serverSettings) => {
    const maxMB = serverSettings?.features?.coverArt && typeof serverSettings.features.coverArt.memoryPoolMB === "number"
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
    if (!payload || !Array.isArray(payload.results) || payload.results.length === 0 || !payload.results[0].artworkUrl100) {
        return null;
    }
    return { lookup: payload.results[0].artworkUrl100.replace("100x100bb", "600x600bb") };
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
    return { lookup: `https://coverartarchive.org/release-group/${groups[0].id}/front-500` };
};

const extractOpenAiImage = (response) => {
    if (!response || !Array.isArray(response.data) || !response.data[0]) {
        return null;
    }
    const first = response.data[0];
    if (first.url && typeof first.url === "string") {
        return { mode: "url", url: first.url };
    }
    if (first.b64_json && typeof first.b64_json === "string") {
        const buffer = Buffer.from(first.b64_json, "base64");
        if (!buffer.length) {
            return null;
        }
        return {
            mode: "inline",
            image: { buffer, contentType: "image/png", bytes: buffer.length, sourceUrl: "openai:b64_json" }
        };
    }
    return null;
};

const lookupFromOpenAi = async (artist, album, title, lyricsPayload, serverSettings, options = {}) => {
    if (!artist || !title) {
        return null;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { errorCode: "openai_api_key_missing" };
    }

    const tokenBudget = Number(serverSettings?.features?.coverArt?.openAiTokenBudget || 0);
    if (tokenBudget <= 0) {
        return { errorCode: "openai_token_budget_exhausted" };
    }

    const variantIndex = Math.max(0, Number(options.variantIndex) || 0);
    const quality = options.quality || "low";
    const trackKey = `${artist}|${album}|${title}`.toLowerCase();
    const conceptSeed = hash(`${artist}|${album}|${title}|${variantIndex}`);
    const previousPrompts = promptHistoryByTrack.get(trackKey) || [];

    const conceptResult = await generateCoverConcept({
        artist,
        album,
        title,
        lyricsPayload,
        variantIndex,
        conceptSeed,
        previousPrompts
    });

    const finalPrompt = conceptResult?.concept?.finalImagePrompt;
    if (!finalPrompt) {
        return { errorCode: "concept_generation_failed" };
    }

    const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini";
    const imageSize = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
    const response = await postJson(OPENAI_API_URL, {
        model: imageModel,
        prompt: finalPrompt,
        size: imageSize,
        quality
    }, {
        Authorization: `Bearer ${apiKey}`
    });

    const parsed = extractOpenAiImage(response);
    if (!parsed) {
        return null;
    }
    const usage = response && response.usage ? response.usage : null;
    const spentTokens = usage && typeof usage.total_tokens === "number" ? usage.total_tokens : 0;

    const history = promptHistoryByTrack.get(trackKey) || [];
    history.push(finalPrompt);
    promptHistoryByTrack.set(trackKey, history.slice(-12));

    return {
        lookup: parsed.mode === "url" ? parsed.url : parsed.image,
        spentTokens,
        concept: conceptResult.concept,
        conceptDebug: conceptResult.debug,
        generationSettings: {
            textModel: process.env.OPENAI_CONCEPT_MODEL || "gpt-4.1-mini",
            imageModel,
            imageSize,
            imageQuality: quality,
            variantIndex,
            conceptSeed,
            lyricsSnippet: getLyricsSnippet(lyricsPayload),
            promptHistoryCount: previousPrompts.length,
            concept: conceptResult?.concept || null,
            conceptDebug: conceptResult?.debug || null,
            textModelInputPrompt: conceptResult?.debug?.conceptInputText || "",
            textModelOutputText: conceptResult?.debug?.conceptOutputText || JSON.stringify(conceptResult?.concept || {}, null, 2),
            finalImagePrompt: finalPrompt,
            imageModelInputPrompt: finalPrompt,
            alternativePrompts: conceptResult?.alternatives || []
        }
    };
};

const resolveLookupUrl = async (metadata, serverSettings, lyricsPayload, options = {}) => {
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
    if (provider === "openai") {
        return lookupFromOpenAi(cleanArtist, cleanAlbum, cleanTitle, lyricsPayload, serverSettings, options);
    }
    return lookupFromCAA(cleanArtist, cleanAlbum);
};

const getHttpStatusCodeFromError = (error) => {
    if (!error) return null;
    if (typeof error.statusCode === "number") return error.statusCode;
    if (!error.message || typeof error.message !== "string") return null;
    const match = error.message.match(/^HTTP\s+(\d{3})$/);
    return match ? parseInt(match[1], 10) : null;
};

const shouldSuppressTransientFailure = (trackKey, provider) => {
    if (!trackKey || !provider) return false;
    const cacheKey = `${provider}|${trackKey}`;
    const expiresAt = transientFailureCache.get(cacheKey);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        transientFailureCache.delete(cacheKey);
        return false;
    }
    return true;
};

const cacheTransientFailure = (trackKey, provider) => {
    if (!trackKey || !provider) return;
    transientFailureCache.set(`${provider}|${trackKey}`, Date.now() + TRANSIENT_FAILURE_TTL_MS);
};

const getGenerationCacheKey = (provider, trackKey, variantIndex, quality) => `${provider}|${trackKey}|${variantIndex}|${quality}`;

const getAiDebugForCacheKey = (cacheKey) => {
    if (!cacheKey) {
        return null;
    }
    const meta = persistentImageIndex.get(cacheKey);
    return meta && meta.aiDebug ? meta.aiDebug : null;
};

const persistGeneratedImage = (trackKey, cacheKey, image, sourceUrl, variantIndex, quality, aiDebug = null) => {
    ensurePersistentStorage();
    const extension = image.contentType === "image/jpeg" ? "jpg" : "png";
    const fileName = `${cacheKey}.${extension}`;
    fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, fileName), image.buffer);
    persistentImageIndex.set(cacheKey, {
        fileName,
        contentType: image.contentType,
        bytes: image.bytes,
        sourceUrl: sourceUrl || "openai:persistent",
        variantIndex,
        aiDebug
    });

    const variantKey = getVariantKey(variantIndex, quality);
    const mapping = persistentTrackCache.get(trackKey) || {};
    mapping[variantKey] = cacheKey;
    persistentTrackCache.set(trackKey, mapping);

    savePersistentIndex();
};

const resolveAlbumArt = async (metadata, serverSettings, lyricsPayload, options = {}) => {
    const key = getTrackKey(metadata);
    if (!key) {
        return null;
    }
    const provider = serverSettings?.features?.coverArt?.provider || null;
    const variantIndex = Math.max(0, Number(options.variantIndex) || 0);
    const quality = options.quality || "low";
    const variantKey = getVariantKey(variantIndex, quality);
    const forceRefresh = Boolean(options.forceRefresh);
    const isGeneratedProvider = provider === "openai";

    if (isGeneratedProvider && !forceRefresh) {
        const mapping = persistentTrackCache.get(key);
        const persistentCacheKey = mapping ? mapping[variantKey] : null;
        if (persistentCacheKey) {
            const cached = touchImageEntry(persistentCacheKey) || loadPersistentImageIntoMemory(persistentCacheKey);
            if (cached) {
                return {
                    cacheKey: persistentCacheKey,
                    provider,
                    trackKey: key,
                    variantIndex,
                    songKey: getSongKeyHash(metadata),
                    aiDebug: getAiDebugForCacheKey(persistentCacheKey)
                };
            }
        }
    }

    const generationCacheKey = getGenerationCacheKey(provider, key, variantIndex, quality);
    const prior = generationResultCache.get(generationCacheKey);
    if (!forceRefresh && prior?.status === "ok" && prior.cacheKey) {
        const cachedImage = touchImageEntry(prior.cacheKey) || loadPersistentImageIntoMemory(prior.cacheKey);
        if (cachedImage) {
            return {
                cacheKey: prior.cacheKey,
                provider,
                trackKey: key,
                variantIndex,
                songKey: getSongKeyHash(metadata),
                aiDebug: prior.aiDebug || getAiDebugForCacheKey(prior.cacheKey)
            };
        }
    }
    if (!forceRefresh && prior?.status === "in_flight") {
        return {
            status: "in_flight",
            provider,
            trackKey: key,
            variantIndex,
            songKey: getSongKeyHash(metadata)
        };
    }
    if (!forceRefresh && prior?.status === "failed") {
        return null;
    }

    if (shouldSuppressTransientFailure(key, provider)) {
        return null;
    }
    const lookupCacheKey = `${provider}|${key}|${variantIndex}|${quality}|${forceRefresh ? "force" : "normal"}`;
    if (lookupCache.has(lookupCacheKey)) {
        return lookupCache.get(lookupCacheKey);
    }

    generationResultCache.set(generationCacheKey, { status: "in_flight" });

    const pending = (async () => {
        try {
            const lookupResponse = await resolveLookupUrl(metadata, serverSettings, lyricsPayload, { variantIndex, quality, forceRefresh });
            if (!lookupResponse) {
                generationResultCache.set(generationCacheKey, { status: "failed", reason: "no-lookup" });
                return null;
            }
            if (lookupResponse.errorCode) {
                generationResultCache.set(generationCacheKey, { status: "failed", reason: lookupResponse.errorCode });
                return { errorCode: lookupResponse.errorCode, provider, trackKey: key, variantIndex, songKey: getSongKeyHash(metadata) };
            }

            const lookup = lookupResponse.lookup;
            const isInlineImage = lookup && typeof lookup === "object" && Buffer.isBuffer(lookup.buffer) && typeof lookup.contentType === "string";
            const image = isInlineImage
                ? { buffer: lookup.buffer, contentType: lookup.contentType, bytes: lookup.bytes || lookup.buffer.length }
                : await requestImage(lookup);
            const resolvedUrl = isInlineImage ? (lookup.sourceUrl || `${provider}:inline`) : lookup;

            const cacheKey = hash(`${key}|${resolvedUrl}|${variantKey}`);
            imageCache.set(cacheKey, { ...image, provider, sourceUrl: resolvedUrl, trackKey: key });
            imageCacheSizeBytes += image.bytes;
            enforceImagePoolLimit(serverSettings);

            const spentTokens = lookupResponse.spentTokens || 0;
            if (spentTokens > 0) {
                const budgetValue = Number(serverSettings?.features?.coverArt?.openAiTokenBudget || 0);
                const remaining = Math.max(0, budgetValue - spentTokens);
                serverSettings.features.coverArt.openAiTokenBudget = remaining;
                lib.saveSettings(serverSettings);
            }

            persistGeneratedImage(key, cacheKey, image, resolvedUrl, variantIndex, quality, lookupResponse.generationSettings || null);
            generationResultCache.set(generationCacheKey, { status: "ok", cacheKey, aiDebug: lookupResponse.generationSettings || null });

            const result = { cacheKey, provider, trackKey: key, variantIndex, songKey: getSongKeyHash(metadata) };
            result.aiDebug = lookupResponse.generationSettings || null;
            if (String(process.env.DEBUG_COVER_CONCEPTS || "").toLowerCase() === "true") {
                result.debug = lookupResponse.conceptDebug || {
                    visualUniverse: lookupResponse?.concept?.visualUniverse || null,
                    variantIndex,
                    promptPreview: (lookupResponse?.concept?.finalImagePrompt || "").slice(0, 200)
                };
            }
            return result;
        } catch (error) {
            const statusCode = getHttpStatusCodeFromError(error);
            if (provider === "openai" && statusCode && AI_RETRYABLE_HTTP_CODES.has(statusCode)) {
                cacheTransientFailure(key, provider);
                generationResultCache.set(generationCacheKey, { status: "failed", reason: "transient-error" });
                return { errorCode: "openai_transient_error", provider, trackKey: key, variantIndex, songKey: getSongKeyHash(metadata), statusCode };
            }
            generationResultCache.set(generationCacheKey, { status: "failed", reason: "error" });
            return { errorCode: "openai_request_error", provider, trackKey: key, variantIndex, songKey: getSongKeyHash(metadata), statusCode };
        }
    })();

    lookupCache.set(lookupCacheKey, pending);
    const result = await pending;
    lookupCache.delete(lookupCacheKey);
    return result;
};

const getCachedImage = (cacheKey) => touchImageEntry(cacheKey) || loadPersistentImageIntoMemory(cacheKey);

const applySettings = (serverSettings) => {
    enforceImagePoolLimit(serverSettings);
};

loadPersistentIndex();

module.exports = {
    getTrackKey,
    getSongKeyHash,
    resolveAlbumArt,
    getCachedImage,
    applySettings,
    getLyricsSnippet,
    getHttpStatusCodeFromError,
    extractOpenAiImage
};

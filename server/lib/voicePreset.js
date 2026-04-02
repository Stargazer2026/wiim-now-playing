// ===========================================================================
// voicePreset.js

/**
 * Voice preset auto-switcher for spoken-word content.
 * Uses local metadata hints and optional online lookups (iTunes, OpenLibrary, MusicBrainz).
 * @module
 */

const http = require("http");
const https = require("https");
const httpApi = require("./httpApi.js");
const log = require("debug")("lib:voicePreset");

const MB_BASE_URL = "https://musicbrainz.org/ws/2";
const LOOKUP_USER_AGENT = "wiim-now-playing/voice-preset";
const REQUEST_TIMEOUT_MS = 4500;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_MB_INTERVAL_MS = 1100;

const SPOKEN_TEXT_KEYWORDS = [
    "hörspiel",
    "hoerspiel",
    "hörbuch",
    "hoerbuch",
    "audiobook",
    "audio book",
    "podcast",
    "audio drama",
    "radio drama",
    "spoken word"
];

const SPOKEN_TAG_KEYWORDS = [
    "podcast",
    "spoken word",
    "speech",
    "audiobook",
    "audio drama",
    "radio drama",
    "hörspiel",
    "hoerspiel",
    "hörbuch",
    "hoerbuch"
];

const NON_SPOKEN_TAG_KEYWORDS = [
    "rock",
    "pop",
    "metal",
    "jazz",
    "classical",
    "electronic",
    "hip hop"
];

const state = {
    lastTrackSignature: null,
    lastAppliedMode: null, // "spoken" | "default" | null
    lastAppliedPresetId: null,
    lastDetection: null,
    lastLookup: null
};

let mbQueue = Promise.resolve();
let lastMbRequestAt = 0;
const spokenLookupCache = new Map();

const asString = (value) => (typeof value === "string" ? value.trim() : "");
const normalizeText = (value) => asString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const parsePresetId = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
};

const getVoicePresetSettings = (serverSettings) => {
    if (!serverSettings || !serverSettings.features) {
        return {};
    }
    return serverSettings.features.voicePreset || {};
};

const getTrackSignature = (metadata) => {
    if (!metadata) {
        return "";
    }
    const track = metadata.trackMetaData || {};
    return [
        asString(track["dc:title"]),
        asString(track["upnp:artist"]),
        asString(track["upnp:album"]),
        asString(metadata.TrackSource),
        asString(metadata.TrackDuration)
    ].join("::");
};

const getLookupKey = (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : {};
    return [
        asString(track["dc:title"]).toLowerCase(),
        asString(track["upnp:artist"]).toLowerCase(),
        asString(track["upnp:album"]).toLowerCase()
    ].join("|");
};

const emitStatus = (io, payload) => {
    if (!io || typeof io.emit !== "function") {
        return;
    }
    io.emit("voice-preset-status", {
        ...payload,
        lastAppliedMode: state.lastAppliedMode,
        lastAppliedPresetId: state.lastAppliedPresetId,
        lastTrackSignature: state.lastTrackSignature,
        lastDetection: state.lastDetection,
        lastLookup: state.lastLookup
    });
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = (url) => new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.get(parsedUrl, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
            "User-Agent": LOOKUP_USER_AGENT,
            "Accept": "application/json"
        }
    }, (res) => {
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
            if (data.length > 1024 * 1024) {
                req.destroy(new Error("Response too large"));
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

const runMusicBrainzRequest = async (url) => {
    mbQueue = mbQueue.then(async () => {
        const waitMs = Math.max(0, MIN_MB_INTERVAL_MS - (Date.now() - lastMbRequestAt));
        if (waitMs > 0) {
            await delay(waitMs);
        }
        lastMbRequestAt = Date.now();
        return requestJson(url);
    });
    return mbQueue;
};

const runItunesRequest = async (url) => requestJson(url);

const textHasKeyword = (value, keywords) => {
    const normalized = normalizeText(value);
    if (!normalized) {
        return false;
    }
    return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
};

const classifyFromLocalMetadata = (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : {};
    const classValue = normalizeText(track["upnp:class"]);
    if (classValue.includes("audiobook") || classValue.includes("podcast") || classValue.includes("audiobroadcast")) {
        return {
            spokenWord: true,
            source: "local-upnp-class",
            reason: classValue
        };
    }

    const textCandidates = [
        track["dc:title"],
        track["upnp:artist"],
        track["upnp:album"]
    ];
    const chapterPattern = /\b(kapitel|chapter|folge|teil)\s*\d+\b/;
    const chapterHit = textCandidates.find((entry) => chapterPattern.test(normalizeText(entry)));
    if (chapterHit) {
        return {
            spokenWord: true,
            source: "local-text-pattern",
            reason: chapterHit
        };
    }
    const textHit = textCandidates.find((entry) => textHasKeyword(entry, SPOKEN_TEXT_KEYWORDS));
    if (textHit) {
        return {
            spokenWord: true,
            source: "local-text-keyword",
            reason: textHit
        };
    }

    return {
        spokenWord: null,
        source: "local-none",
        reason: null
    };
};

const scoreMusicBrainzDocument = (doc) => {
    const tagTexts = []
        .concat(Array.isArray(doc.tags) ? doc.tags.map((tag) => tag && tag.name) : [])
        .concat(Array.isArray(doc.genres) ? doc.genres.map((genre) => genre && genre.name) : []);
    const hasSpokenTag = tagTexts.some((tag) => textHasKeyword(tag, SPOKEN_TAG_KEYWORDS));
    const hasMusicTag = tagTexts.some((tag) => textHasKeyword(tag, NON_SPOKEN_TAG_KEYWORDS));
    if (hasSpokenTag) {
        return true;
    }
    if (hasMusicTag) {
        return false;
    }
    return null;
};

const classifyViaMusicBrainz = async (metadata) => {
    const lookupKey = getLookupKey(metadata);
    if (!lookupKey || lookupKey === "||") {
        return { spokenWord: null, source: "musicbrainz-skip", reason: "missing-lookup-key" };
    }

    const cached = spokenLookupCache.get(lookupKey);
    if (cached && (Date.now() - cached.createdAt) < CACHE_TTL_MS) {
        return {
            spokenWord: cached.value,
            source: "musicbrainz-cache",
            reason: "cache-hit"
        };
    }

    const track = metadata.trackMetaData || {};
    const title = asString(track["dc:title"]);
    const artist = asString(track["upnp:artist"]);
    if (!title) {
        return { spokenWord: null, source: "musicbrainz-skip", reason: "missing-title" };
    }

    const searchQuery = artist
        ? `recording:"${title}" AND artist:"${artist}"`
        : `recording:"${title}"`;
    const searchUrl = `${MB_BASE_URL}/recording?fmt=json&limit=5&query=${encodeURIComponent(searchQuery)}`;

    try {
        const searchResult = await runMusicBrainzRequest(searchUrl);
        const recordings = searchResult && Array.isArray(searchResult.recordings) ? searchResult.recordings : [];
        const candidates = recordings
            .filter((recording) => recording && recording.id && Number(recording.score || 0) >= 60)
            .slice(0, 3);

        for (const candidate of candidates) {
            const detailUrl = `${MB_BASE_URL}/recording/${candidate.id}?fmt=json&inc=genres+tags+releases+release-groups`;
            const detail = await runMusicBrainzRequest(detailUrl);
            const directScore = scoreMusicBrainzDocument(detail);
            if (directScore !== null) {
                spokenLookupCache.set(lookupKey, { value: directScore, createdAt: Date.now() });
                return {
                    spokenWord: directScore,
                    source: "musicbrainz-recording",
                    reason: candidate.id
                };
            }
        }

        spokenLookupCache.set(lookupKey, { value: null, createdAt: Date.now() });
        return {
            spokenWord: null,
            source: "musicbrainz-none",
            reason: "no-tag-match"
        };
    } catch (error) {
        log("MusicBrainz lookup failed", error.message);
        return {
            spokenWord: null,
            source: "musicbrainz-error",
            reason: error.message
        };
    }
};

const classifyViaItunes = async (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : {};
    const title = asString(track["dc:title"]);
    const artist = asString(track["upnp:artist"]);
    const album = asString(track["upnp:album"]);
    const term = [title, artist, album].filter(Boolean).join(" ");
    if (!term) {
        return { spokenWord: null, source: "itunes-skip", reason: "missing-term" };
    }

    try {
        const audiobookUrl = `https://itunes.apple.com/search?entity=audiobook&limit=5&term=${encodeURIComponent(term)}`;
        const podcastUrl = `https://itunes.apple.com/search?entity=podcast&limit=5&term=${encodeURIComponent(term)}`;
        const [audiobookResult, podcastResult] = await Promise.all([
            runItunesRequest(audiobookUrl),
            runItunesRequest(podcastUrl)
        ]);
        const audiobookHits = Array.isArray(audiobookResult && audiobookResult.results) ? audiobookResult.results.length : 0;
        const podcastHits = Array.isArray(podcastResult && podcastResult.results) ? podcastResult.results.length : 0;
        if (audiobookHits > 0 || podcastHits > 0) {
            return {
                spokenWord: true,
                source: "itunes-catalog",
                reason: `audiobookHits:${audiobookHits},podcastHits:${podcastHits}`
            };
        }
        return { spokenWord: null, source: "itunes-none", reason: "no-match" };
    } catch (error) {
        log("iTunes lookup failed", error.message);
        return { spokenWord: null, source: "itunes-error", reason: error.message };
    }
};

const classifyViaOpenLibrary = async (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : {};
    const title = asString(track["dc:title"]);
    const artist = asString(track["upnp:artist"]);
    if (!title) {
        return { spokenWord: null, source: "openlibrary-skip", reason: "missing-title" };
    }

    const queryParts = [title, artist].filter(Boolean);
    const searchUrl = `https://openlibrary.org/search.json?limit=8&q=${encodeURIComponent(queryParts.join(" "))}`;

    try {
        const searchResult = await requestJson(searchUrl);
        const docs = Array.isArray(searchResult && searchResult.docs) ? searchResult.docs : [];
        const spokenDoc = docs.find((doc) => {
            const subjectText = Array.isArray(doc && doc.subject) ? doc.subject.join(" ") : "";
            const candidateText = [doc && doc.title, subjectText].join(" ");
            return textHasKeyword(candidateText, SPOKEN_TEXT_KEYWORDS) || textHasKeyword(candidateText, SPOKEN_TAG_KEYWORDS);
        });

        if (spokenDoc) {
            return {
                spokenWord: true,
                source: "openlibrary-subject",
                reason: asString(spokenDoc.title) || "subject-match"
            };
        }
        return { spokenWord: null, source: "openlibrary-none", reason: "no-subject-match" };
    } catch (error) {
        log("OpenLibrary lookup failed", error.message);
        return { spokenWord: null, source: "openlibrary-error", reason: error.message };
    }
};

const detectSpokenWord = async (metadata, settings) => {
    const providers = ["itunes", "openlibrary", "musicbrainz"];
    const local = classifyFromLocalMetadata(metadata);
    if (local.spokenWord !== null) {
        return {
            spokenWord: local.spokenWord,
            source: local.source,
            reason: local.reason,
            online: {
                used: false,
                providers,
                source: "not-needed",
                reason: "local-match",
                spokenWord: null,
                trail: {
                    itunes: { source: "not-run", reason: "local-match" },
                    openlibrary: { source: "not-run", reason: "local-match" },
                    musicbrainz: { source: "not-run", reason: "local-match" }
                }
            }
        };
    }
    if (settings.lookupEnabled === false) {
        return {
            spokenWord: false,
            source: "fallback-default",
            reason: "lookup-disabled-and-no-local-match",
            online: {
                used: false,
                providers,
                source: "disabled",
                reason: "lookup-disabled",
                spokenWord: null,
                trail: {
                    itunes: { source: "not-run", reason: "lookup-disabled" },
                    openlibrary: { source: "not-run", reason: "lookup-disabled" },
                    musicbrainz: { source: "not-run", reason: "lookup-disabled" }
                }
            }
        };
    }

    const onlineItunes = await classifyViaItunes(metadata);
    if (onlineItunes.spokenWord !== null) {
        return {
            spokenWord: onlineItunes.spokenWord,
            source: onlineItunes.source,
            reason: onlineItunes.reason,
            online: {
                used: true,
                providers,
                trail: {
                    itunes: { source: onlineItunes.source, reason: onlineItunes.reason },
                    openlibrary: { source: "not-run", reason: "matched-earlier-provider" },
                    musicbrainz: { source: "not-run", reason: "matched-earlier-provider" }
                },
                ...onlineItunes
            }
        };
    }

    const onlineOpenLibrary = await classifyViaOpenLibrary(metadata);
    if (onlineOpenLibrary.spokenWord !== null) {
        return {
            spokenWord: onlineOpenLibrary.spokenWord,
            source: onlineOpenLibrary.source,
            reason: onlineOpenLibrary.reason,
            online: {
                used: true,
                providers,
                trail: {
                    itunes: { source: onlineItunes.source, reason: onlineItunes.reason },
                    openlibrary: { source: onlineOpenLibrary.source, reason: onlineOpenLibrary.reason },
                    musicbrainz: { source: "not-run", reason: "matched-earlier-provider" }
                },
                ...onlineOpenLibrary
            }
        };
    }

    const onlineMb = await classifyViaMusicBrainz(metadata);
    if (onlineMb.spokenWord !== null) {
        return {
            spokenWord: onlineMb.spokenWord,
            source: onlineMb.source,
            reason: onlineMb.reason,
            online: {
                used: true,
                providers,
                trail: {
                    itunes: { source: onlineItunes.source, reason: onlineItunes.reason },
                    openlibrary: { source: onlineOpenLibrary.source, reason: onlineOpenLibrary.reason },
                    musicbrainz: { source: onlineMb.source, reason: onlineMb.reason }
                },
                ...onlineMb
            }
        };
    }

    return {
        spokenWord: false,
        source: "fallback-default",
        reason: "online-inconclusive",
        online: {
            used: true,
            providers,
            source: "all-providers-inconclusive",
            reason: `itunes:${onlineItunes.reason};openlibrary:${onlineOpenLibrary.reason};musicbrainz:${onlineMb.reason}`,
            spokenWord: null,
            trail: {
                itunes: { source: onlineItunes.source, reason: onlineItunes.reason },
                openlibrary: { source: onlineOpenLibrary.source, reason: onlineOpenLibrary.reason },
                musicbrainz: { source: onlineMb.source, reason: onlineMb.reason }
            }
        }
    };
};

const applyPresetForMetadata = async (io, metadata, serverSettings) => {
    const settings = getVoicePresetSettings(serverSettings);
    const voicePresetId = parsePresetId(settings.voicePresetId);
    const defaultPresetId = parsePresetId(settings.defaultPresetId);
    if (!voicePresetId && !defaultPresetId) {
        emitStatus(io, { status: "skipped", reason: "no-presets-configured" });
        return;
    }

    const trackSignature = getTrackSignature(metadata);
    if (!trackSignature || trackSignature === "::::") {
        emitStatus(io, { status: "skipped", reason: "invalid-track-signature", trackSignature });
        return;
    }
    if (trackSignature === state.lastTrackSignature) {
        emitStatus(io, { status: "skipped", reason: "same-track", trackSignature });
        return;
    }

    const detection = await detectSpokenWord(metadata, settings);
    state.lastTrackSignature = trackSignature;
    state.lastDetection = {
        spokenWord: detection.spokenWord,
        source: detection.source,
        reason: detection.reason
    };
    state.lastLookup = detection.online;

    let targetPresetId = null;
    let mode = null;
    if (detection.spokenWord && voicePresetId) {
        targetPresetId = voicePresetId;
        mode = "spoken";
    } else if (defaultPresetId && state.lastAppliedMode === "spoken") {
        targetPresetId = defaultPresetId;
        mode = "default";
    }

    if (!targetPresetId) {
        emitStatus(io, {
            status: "processed-no-switch",
            reason: "conditions-not-met",
            spokenWord: detection.spokenWord,
            trackSignature
        });
        return;
    }

    log("Applying preset", { spokenWord: detection.spokenWord, targetPresetId, trackSignature, mode });
    httpApi.callApi(io, `MCUKeyShortClick:${targetPresetId}`, serverSettings);
    state.lastAppliedPresetId = targetPresetId;
    state.lastAppliedMode = mode;

    emitStatus(io, {
        status: "applied",
        mode,
        presetId: targetPresetId,
        spokenWord: detection.spokenWord,
        trackSignature
    });
};

const reset = () => {
    state.lastTrackSignature = null;
    state.lastAppliedMode = null;
    state.lastAppliedPresetId = null;
    state.lastDetection = null;
    state.lastLookup = null;
};

const getState = () => ({
    lastTrackSignature: state.lastTrackSignature,
    lastAppliedMode: state.lastAppliedMode,
    lastAppliedPresetId: state.lastAppliedPresetId,
    lastDetection: state.lastDetection,
    lastLookup: state.lastLookup
});

module.exports = {
    applyPresetForMetadata,
    classifyFromLocalMetadata,
    getState,
    reset
};

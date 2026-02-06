// ===========================================================================
// lyrics.js
//
// Lyrics integration (LRCLIB)

const https = require("https");
const log = require("debug")("lib:lyrics");

const LRCLIB_BASE_URL = "https://lrclib.net";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const MATCH_SCORE_THRESHOLD = 70;

const cache = new Map();
const inFlightRequests = new Map();

const buildDiagnostics = (metadata, deviceInfo, serverSettings) => {
    const requestedAt = Date.now();
    const metadataTimeStamp = metadata?.metadataTimeStamp || null;
    const stateTimeStamp = deviceInfo?.state?.stateTimeStamp || null;

    return {
        requestedAt,
        metadataTimeStamp,
        metadataAgeMs: metadataTimeStamp ? requestedAt - metadataTimeStamp : null,
        stateTimeStamp,
        stateAgeMs: stateTimeStamp ? requestedAt - stateTimeStamp : null,
        metadataPollIntervalMs: serverSettings?.timeouts?.metadata || null,
        requests: []
    };
};

const fetchJsonWithTiming = async (path, serverSettings, diagnostics, label) => {
    const startedAt = Date.now();
    try {
        const result = await fetchJson(path, serverSettings);
        if (diagnostics?.requests) {
            diagnostics.requests.push({
                endpoint: label,
                durationMs: Date.now() - startedAt,
                result: result ? "hit" : "miss"
            });
        }
        return result;
    } catch (error) {
        if (diagnostics?.requests) {
            diagnostics.requests.push({
                endpoint: label,
                durationMs: Date.now() - startedAt,
                result: "error",
                error: error.message
            });
        }
        throw error;
    }
};

const normalizeText = (value) => {
    if (!value) {
        return "";
    }
    return value
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/&/g, " and ")
        .replace(/feat\.?/g, " ")
        .replace(/ft\.?/g, " ")
        .replace(/[-–—]/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const normalizeAlbum = (value) => {
    return normalizeText(value)
        .replace(/\b(deluxe|edition|remaster(ed)?|expanded|bonus|anniversary|live|acoustic|mono|stereo|version)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

const parseDurationToSeconds = (duration) => {
    if (!duration) {
        return null;
    }
    if (typeof duration === "number") {
        return Math.round(duration);
    }
    const parts = duration.split(":").map((item) => parseInt(item, 10));
    if (parts.some((item) => Number.isNaN(item))) {
        return null;
    }
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return null;
};

const buildTrackKey = (trackName, artistName, albumName, duration) => {
    const base = [
        normalizeText(trackName),
        normalizeText(artistName),
        normalizeText(albumName),
        duration || ""
    ].join("|");
    return base;
};

const getUserAgent = (serverSettings) => {
    const version = serverSettings?.version?.server || "unknown";
    return `WiiMNowPlaying/${version} (+https://github.com)`;
};

const fetchJson = (path, serverSettings) => new Promise((resolve, reject) => {
    const url = `${LRCLIB_BASE_URL}${path}`;
    const req = https.get(url, {
        headers: {
            "User-Agent": getUserAgent(serverSettings)
        }
    }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(error);
                }
            } else if (res.statusCode === 404) {
                resolve(null);
            } else {
                reject(new Error(`LRCLIB request failed with status ${res.statusCode}`));
            }
        });
    });
    req.on("error", reject);
});

const scoreCandidate = (candidate, signature) => {
    const trackName = normalizeText(candidate.trackName);
    const artistName = normalizeText(candidate.artistName);
    const albumName = normalizeAlbum(candidate.albumName);
    const duration = candidate.duration || null;

    const signatureTrack = normalizeText(signature.trackName);
    const signatureArtist = normalizeText(signature.artistName);
    const signatureAlbum = normalizeAlbum(signature.albumName);
    const signatureDuration = signature.duration || null;

    let score = 0;
    if (trackName === signatureTrack) {
        score += 50;
    } else if (trackName && signatureTrack && (trackName.includes(signatureTrack) || signatureTrack.includes(trackName))) {
        score += 25;
    }

    if (artistName === signatureArtist) {
        score += 40;
    } else if (artistName && signatureArtist && (artistName.includes(signatureArtist) || signatureArtist.includes(artistName))) {
        score += 20;
    }

    if (albumName === signatureAlbum) {
        score += 25;
    } else if (albumName && signatureAlbum && (albumName.includes(signatureAlbum) || signatureAlbum.includes(albumName))) {
        score += 12;
    }

    if (duration && signatureDuration) {
        const diff = Math.abs(duration - signatureDuration);
        if (diff <= 2) {
            score += 30;
        } else if (diff <= 5) {
            score += 20;
        } else if (diff <= 10) {
            score += 10;
        } else {
            score -= 20;
        }
    }

    return score;
};

const buildSignatureFromMetadata = (metadata) => {
    const trackName = metadata?.trackMetaData?.["dc:title"] || "";
    const artistName = metadata?.trackMetaData?.["upnp:artist"] || "";
    const albumName = metadata?.trackMetaData?.["upnp:album"] || "";
    const duration = parseDurationToSeconds(metadata?.TrackDuration);

    if (!trackName || !artistName || !albumName || !duration) {
        return null;
    }

    return { trackName, artistName, albumName, duration };
};

const filterCandidates = (candidates, signature) => {
    const filtered = candidates
        .filter((candidate) => candidate && candidate.syncedLyrics && !candidate.instrumental)
        .filter((candidate) => {
            if (!signature.duration || !candidate.duration) {
                return true;
            }
            return Math.abs(candidate.duration - signature.duration) <= 10;
        })
        .map((candidate) => ({
            ...candidate,
            score: scoreCandidate(candidate, signature)
        }))
        .filter((candidate) => candidate.score >= MATCH_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

    return filtered[0] || null;
};

const fetchLyricsFromSearch = async (signature, serverSettings, diagnostics) => {
    const params = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName,
        album_name: signature.albumName
    });
    const results = await fetchJsonWithTiming(`/api/search?${params.toString()}`, serverSettings, diagnostics, "search");
    if (!Array.isArray(results)) {
        return null;
    }
    return filterCandidates(results, signature);
};

const fetchLyricsBySignature = async (signature, serverSettings, diagnostics) => {
    const params = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName,
        album_name: signature.albumName,
        duration: signature.duration
    });

    const isValid = (result) => result && result.syncedLyrics && !result.instrumental;
    const tasks = [
        {
            label: "get-cached",
            promise: fetchJsonWithTiming(`/api/get-cached?${params.toString()}`, serverSettings, diagnostics, "get-cached")
        },
        {
            label: "get",
            promise: fetchJsonWithTiming(`/api/get?${params.toString()}`, serverSettings, diagnostics, "get")
        },
        {
            label: "search",
            promise: fetchLyricsFromSearch(signature, serverSettings, diagnostics)
        }
    ].map((task) => ({
        label: task.label,
        promise: task.promise
            .then((result) => ({ status: "ok", label: task.label, result }))
            .catch((error) => ({ status: "error", label: task.label, error }))
    }));

    const pending = [...tasks];
    while (pending.length > 0) {
        const settled = await Promise.race(pending.map((task) => task.promise));
        const index = pending.findIndex((task) => task.label === settled.label);
        if (index !== -1) {
            pending.splice(index, 1);
        }

        if (settled.status === "ok" && isValid(settled.result)) {
            if (diagnostics) {
                diagnostics.pendingRequests = pending.map((task) => task.label);
            }
            return settled.result;
        }
    }

    return null;
};

const setLyricsState = (io, deviceInfo, payload) => {
    deviceInfo.lyrics = payload;
    io.emit("lyrics", payload);
    console.log("Lyrics:", payload);
};

const setLyricsPrefetchState = (io, payload) => {
    if (!io) {
        return;
    }
    io.emit("lyrics-prefetch", payload);
    console.log("Lyrics Prefetch:", payload);
};

const clearLyrics = (io, deviceInfo, reason, signature, trackKey, diagnostics) => {
    if (deviceInfo.lyrics && deviceInfo.lyrics.trackKey === trackKey && deviceInfo.lyrics.status === reason) {
        return;
    }
    setLyricsState(io, deviceInfo, {
        status: reason,
        trackKey: trackKey || null,
        signature: signature || null,
        diagnostics: diagnostics || null
    });
};

const getLyricsForMetadata = async (io, deviceInfo, serverSettings) => {
    const diagnostics = buildDiagnostics(deviceInfo?.metadata, deviceInfo, serverSettings);
    const enabled = serverSettings?.features?.lyrics?.enabled;
    if (!enabled) {
        clearLyrics(io, deviceInfo, "disabled", null, null, diagnostics);
        return;
    }

    const metadata = deviceInfo.metadata;
    if (!metadata || !metadata.trackMetaData) {
        clearLyrics(io, deviceInfo, "no-metadata", null, null, diagnostics);
        return;
    }

    const trackSource = (metadata.TrackSource || "").toLowerCase();
    if (trackSource !== "tidal") {
        clearLyrics(io, deviceInfo, "not-supported-source", null, null, diagnostics);
        return;
    }

    const signature = buildSignatureFromMetadata(metadata);
    if (!signature) {
        clearLyrics(io, deviceInfo, "missing-signature", null, null, diagnostics);
        return;
    }

    const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    if (deviceInfo.lyrics && deviceInfo.lyrics.trackKey === trackKey && deviceInfo.lyrics.status === "ok") {
        return;
    }

    const cached = cache.get(trackKey);
    if (cached && cached.expiresAt > Date.now()) {
        diagnostics.cache = "memory";
        diagnostics.totalMs = Date.now() - diagnostics.requestedAt;
        setLyricsState(io, deviceInfo, {
            ...cached.payload,
            diagnostics
        });
        return;
    }

    const snapshotDiagnostics = () => {
        if (!diagnostics) {
            return null;
        }
        return {
            ...diagnostics,
            requests: diagnostics.requests ? [...diagnostics.requests] : [],
            pendingRequests: diagnostics.pendingRequests ? [...diagnostics.pendingRequests] : []
        };
    };

    try {
        diagnostics.cache = "miss";
        const payload = await fetchLyricsForSignature(signature, trackKey, serverSettings, diagnostics);
        diagnostics.totalMs = Date.now() - diagnostics.requestedAt;
        if (payload) {
            setLyricsState(io, deviceInfo, {
                ...payload,
                diagnostics: snapshotDiagnostics()
            });
            return;
        }
        clearLyrics(io, deviceInfo, "not-found", signature, trackKey, snapshotDiagnostics());
    } catch (error) {
        log("LRCLIB error:", error.message);
        diagnostics.totalMs = Date.now() - diagnostics.requestedAt;
        clearLyrics(io, deviceInfo, "error", signature, trackKey, snapshotDiagnostics());
    }
};

const fetchLyricsForSignature = async (signature, trackKey, serverSettings, diagnostics, options = {}) => {
    const withPrefetchMetadata = (payload) => {
        if (!options.prefetch) {
            return payload;
        }
        return {
            ...payload,
            prefetch: {
                source: options.prefetch.source || "unknown",
                startedAt: options.prefetch.startedAt,
                totalMs: Date.now() - options.prefetch.startedAt
            }
        };
    };

    const cached = cache.get(trackKey);
    if (cached && cached.expiresAt > Date.now()) {
        return withPrefetchMetadata(cached.payload);
    }

    const running = inFlightRequests.get(trackKey);
    if (running) {
        return withPrefetchMetadata(await running);
    }

    const request = (async () => {
        const lyrics = await fetchLyricsBySignature(signature, serverSettings, diagnostics);
        if (lyrics && lyrics.syncedLyrics) {
            const payload = {
                status: "ok",
                provider: "lrclib",
                trackKey,
                signature,
                id: lyrics.id,
                trackName: lyrics.trackName,
                artistName: lyrics.artistName,
                albumName: lyrics.albumName,
                duration: lyrics.duration,
                instrumental: lyrics.instrumental,
                syncedLyrics: lyrics.syncedLyrics
            };
            cache.set(trackKey, {
                payload,
                expiresAt: Date.now() + CACHE_TTL_MS
            });
            return payload;
        }

        const payload = {
            status: "not-found",
            provider: "lrclib",
            trackKey,
            signature
        };
        cache.set(trackKey, {
            payload,
            expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS
        });
        return payload;
    })();

    inFlightRequests.set(trackKey, request);

    try {
        const payload = await request;
        return withPrefetchMetadata(payload);
    } finally {
        inFlightRequests.delete(trackKey);
    }
};

const prefetchLyricsForMetadata = async (io, metadata, serverSettings, options = {}) => {
    const enabled = serverSettings?.features?.lyrics?.enabled;
    if (!enabled || !metadata || !metadata.trackMetaData) {
        setLyricsPrefetchState(io, {
            status: "skipped",
            reason: options.reason || (!enabled ? "disabled" : "missing-metadata")
        });
        return;
    }

    const trackSource = (metadata.TrackSource || "").toLowerCase();
    if (trackSource !== "tidal") {
        setLyricsPrefetchState(io, {
            status: "skipped",
            reason: "not-supported-source",
            trackSource
        });
        return;
    }

    const signature = buildSignatureFromMetadata(metadata);
    if (!signature) {
        setLyricsPrefetchState(io, {
            status: "skipped",
            reason: "missing-signature"
        });
        return;
    }

    const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    const cached = cache.get(trackKey);
    if (cached && cached.expiresAt > Date.now()) {
        setLyricsPrefetchState(io, {
            status: "cached",
            trackKey,
            signature
        });
        return;
    }

    try {
        const startedAt = Date.now();
        setLyricsPrefetchState(io, {
            status: "start",
            trackKey,
            signature,
            startedAt
        });
        await fetchLyricsForSignature(signature, trackKey, serverSettings, null, {
            prefetch: {
                source: "next-track-metadata",
                startedAt
            }
        });
        setLyricsPrefetchState(io, {
            status: "done",
            trackKey,
            signature,
            startedAt,
            totalMs: Date.now() - startedAt
        });
    } catch (error) {
        log("LRCLIB prefetch error:", error.message);
        setLyricsPrefetchState(io, {
            status: "error",
            trackKey,
            signature,
            error: error.message
        });
    }
};

module.exports = {
    getLyricsForMetadata,
    prefetchLyricsForMetadata,
    parseDurationToSeconds,
    buildTrackKey
};

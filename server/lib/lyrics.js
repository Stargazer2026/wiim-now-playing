// ===========================================================================
// lyrics.js
//
// Lyrics integration (LRCLIB)

const https = require("https");
const log = require("debug")("lib:lyrics");
const lyricsCache = require("./lyricsCache.js");
const lyricsFailures = require("./lyricsFailures.js");
const {
    normalizeText,
    normalizeAlbum,
    normalizeExactKey,
    normalizeDurationForKey,
    buildTrackKey,
    buildTrackLockKey,
    buildAlbumLockKey,
    buildAlbumTrackUnlockKey
} = require("./lyricsKeys.js");

const LRCLIB_BASE_URL = "https://lrclib.net";
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const MATCH_SCORE_THRESHOLD = 70;
const PREFETCH_CONCURRENCY_FALLBACK = 4;
const PREFETCH_MODES = {
    OFF: "off",
    ALBUM: "album"
};
const LYRICS_LOCK_TYPES = {
    TRACK: "track",
    ALBUM: "album",
    ALBUM_TRACK_UNLOCK: "album-track-unlock"
};

const negativeCache = new Map();
const inFlightRequests = new Map();
const prefetchInFlight = new Map();

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
        cacheLookupMs: null,
        cacheStatus: null,
        cacheSizeBytes: null,
        cacheMaxBytes: null,
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
                path,
                durationMs: Date.now() - startedAt,
                result: result ? "hit" : "miss",
                response: result || null
            });
        }
        return result;
    } catch (error) {
        if (diagnostics?.requests) {
            diagnostics.requests.push({
                endpoint: label,
                path,
                durationMs: Date.now() - startedAt,
                result: "error",
                error: error.message
            });
        }
        throw error;
    }
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

const getTrackLockState = (signature, serverSettings) => {
    const trackLockKey = buildTrackLockKey(signature.trackName, signature.albumName, signature.duration);
    const albumLockKey = buildAlbumLockKey(signature.albumName);
    const albumTrackUnlockKey = buildAlbumTrackUnlockKey(signature.albumName, signature.trackName, signature.duration);

    const trackLocked = lyricsCache.hasLyricsLock(LYRICS_LOCK_TYPES.TRACK, trackLockKey, serverSettings);
    const albumLocked = lyricsCache.hasLyricsLock(LYRICS_LOCK_TYPES.ALBUM, albumLockKey, serverSettings);
    const albumTrackUnlocked = lyricsCache.hasLyricsLock(
        LYRICS_LOCK_TYPES.ALBUM_TRACK_UNLOCK,
        albumTrackUnlockKey,
        serverSettings
    );

    return {
        trackLockKey,
        albumLockKey,
        albumTrackUnlockKey,
        trackLocked,
        albumLocked,
        albumTrackUnlocked,
        effectiveLocked: trackLocked || (albumLocked && !albumTrackUnlocked)
    };
};

const getCacheConfig = (serverSettings) => lyricsCache.getCacheConfig(serverSettings);

const findCachedLyricsForSignature = (signature, serverSettings) => {
    const baseTrackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    const offsets = [0, -1, 1, -2, 2];
    for (const offset of offsets) {
        const duration = signature.duration + offset;
        const candidateKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, duration);
        const cacheLookup = lyricsCache.getCachedLyrics(candidateKey, serverSettings);
        if (cacheLookup.status === "hit" && cacheLookup.payload) {
            const payload = {
                ...cacheLookup.payload,
                trackKey: baseTrackKey,
                signature: {
                    ...cacheLookup.payload.signature,
                    duration: signature.duration
                }
            };
            return {
                ...cacheLookup,
                payload,
                status: offset === 0 ? "hit" : "hit-duration-offset",
                lookupTrackKey: candidateKey
            };
        }
        if (cacheLookup.status === "error") {
            return cacheLookup;
        }
    }
    return lyricsCache.getCachedLyrics(baseTrackKey, serverSettings);
};

const getPrefetchMode = (serverSettings) => {
    const mode = getCacheConfig(serverSettings).prefetch;
    if (mode === PREFETCH_MODES.ALBUM || mode === PREFETCH_MODES.OFF) {
        return mode;
    }
    return PREFETCH_MODES.OFF;
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

const rankCandidates = (candidates, signature, options = {}) => {
    const excludedId = options.excludedId;
    const seenKeys = new Set();

    return candidates
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
        .filter((candidate) => {
            if (excludedId && candidate.id && Number(candidate.id) === Number(excludedId)) {
                return false;
            }
            const dedupeKey = candidate.id
                ? `id:${candidate.id}`
                : `txt:${candidate.trackName}|${candidate.artistName}|${candidate.albumName}|${candidate.duration}`;
            if (seenKeys.has(dedupeKey)) {
                return false;
            }
            seenKeys.add(dedupeKey);
            return true;
        })
        .sort((a, b) => b.score - a.score);
};

const fetchRankedCandidatesBySignature = async (signature, serverSettings, diagnostics, options = {}) => {
    const params = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName,
        album_name: signature.albumName,
        duration: signature.duration
    });

    const searchParams = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName,
        album_name: signature.albumName
    });

    const results = await Promise.all([
        fetchJsonWithTiming(`/api/get-cached?${params.toString()}`, serverSettings, diagnostics, "get-cached"),
        fetchJsonWithTiming(`/api/get?${params.toString()}`, serverSettings, diagnostics, "get"),
        fetchJsonWithTiming(`/api/search?${searchParams.toString()}`, serverSettings, diagnostics, "search")
    ].map((promise) => promise.catch(() => null)));

    const candidates = [];
    results.forEach((result) => {
        if (!result) {
            return;
        }
        if (Array.isArray(result)) {
            candidates.push(...result);
            return;
        }
        candidates.push(result);
    });

    return rankCandidates(candidates, signature, options);
};

const fetchLyricsFromSearch = async (signature, serverSettings, diagnostics) => {
    const params = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName,
        album_name: signature.albumName
    });
    const results = await fetchJsonWithTiming(`/api/search?${params.toString()}`, serverSettings, diagnostics, "search");
    if (!Array.isArray(results)) {
        return { match: null, hadUnsyncedLyrics: false };
    }

    const hadUnsyncedLyrics = results.some((candidate) => candidate && candidate.plainLyrics && !candidate.instrumental);
    return {
        match: filterCandidates(results, signature),
        hadUnsyncedLyrics
    };
};

const fetchLyricsFromRelaxedSearch = async (signature, serverSettings, diagnostics) => {
    const params = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName
    });
    const results = await fetchJsonWithTiming(`/api/search?${params.toString()}`, serverSettings, diagnostics, "search-relaxed");
    if (!Array.isArray(results)) {
        return null;
    }

    const relaxedSignature = {
        ...signature,
        albumName: ""
    };

    const filtered = results
        .filter((candidate) => candidate && candidate.syncedLyrics && !candidate.instrumental)
        .filter((candidate) => {
            if (!signature.duration || !candidate.duration) {
                return false;
            }
            return Math.abs(candidate.duration - signature.duration) <= 2;
        })
        .map((candidate) => ({
            ...candidate,
            score: scoreCandidate({
                ...candidate,
                albumName: ""
            }, relaxedSignature)
        }))
        .filter((candidate) => candidate.score >= MATCH_SCORE_THRESHOLD)
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return Math.abs((a.duration || 0) - signature.duration) - Math.abs((b.duration || 0) - signature.duration);
        });

    return filtered[0] || null;
};

const fetchLyricsBySignature = async (signature, serverSettings, diagnostics) => {
    const params = new URLSearchParams({
        track_name: signature.trackName,
        artist_name: signature.artistName,
        album_name: signature.albumName,
        duration: signature.duration
    });

    const isValid = (result) => result && result.syncedLyrics && !result.instrumental;
    const hasUnsyncedLyrics = (result) => {
        if (!result) {
            return false;
        }
        if (Array.isArray(result)) {
            return result.some((item) => item && item.plainLyrics && !item.instrumental);
        }
        return Boolean(result.plainLyrics) && !result.instrumental;
    };
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
    let hadUnsyncedLyrics = false;
    while (pending.length > 0) {
        const settled = await Promise.race(pending.map((task) => task.promise));
        const index = pending.findIndex((task) => task.label === settled.label);
        if (index !== -1) {
            pending.splice(index, 1);
        }

        if (settled.status === "ok") {
            const candidate = settled.label === "search" ? settled.result?.match : settled.result;
            if (isValid(candidate)) {
                if (diagnostics) {
                    diagnostics.pendingRequests = pending.map((task) => task.label);
                }
                return candidate;
            }
            if ((settled.label === "search" && settled.result?.hadUnsyncedLyrics) || hasUnsyncedLyrics(settled.result)) {
                hadUnsyncedLyrics = true;
            }
        }
    }

    const relaxedMatch = await fetchLyricsFromRelaxedSearch(signature, serverSettings, diagnostics);
    if (relaxedMatch) {
        return {
            ...relaxedMatch,
            fallback: {
                mode: "relaxed-track-artist",
                reason: hadUnsyncedLyrics ? "album-no-synced-lyrics" : "album-no-match"
            }
        };
    }

    if (hadUnsyncedLyrics) {
        return { reason: "no-synced-lyrics" };
    }

    return null;
};

const fetchBestLyricsBySignature = async (signature, serverSettings, diagnostics) => {
    const ranked = await fetchRankedCandidatesBySignature(signature, serverSettings, diagnostics);
    if (!ranked.length) {
        return null;
    }
    return ranked[0];
};

const setLyricsState = (io, deviceInfo, payload) => {
    deviceInfo.lyrics = payload;
    io.emit("lyrics", payload);
    log("Lyrics:", {
        status: payload?.status,
        provider: payload?.provider,
        trackKey: payload?.trackKey,
        signature: payload?.signature,
        diagnostics: payload?.diagnostics
    });
};

const setLyricsPrefetchState = (io, payload) => {
    if (!io) {
        return;
    }
    io.emit("lyrics-prefetch", payload);
    log("Lyrics Prefetch:", {
        status: payload?.status,
        reason: payload?.reason,
        mode: payload?.mode,
        trackKey: payload?.trackKey,
        signature: payload?.signature
    });
};

const populateCacheDiagnostics = (diagnostics, serverSettings) => {
    if (!diagnostics) {
        return;
    }
    const cacheConfig = lyricsCache.getCacheConfig(serverSettings);
    diagnostics.cacheMaxBytes = cacheConfig?.maxSizeBytes || 0;
    diagnostics.cacheSizeBytes = cacheConfig?.enabled ? lyricsCache.getCacheStats(cacheConfig).totalSize : 0;
    if (!diagnostics.cacheStatus) {
        diagnostics.cacheStatus = cacheConfig?.enabled ? "ready" : "disabled";
    }
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

    const signature = buildSignatureFromMetadata(metadata);
    if (!signature) {
        clearLyrics(io, deviceInfo, "missing-signature", null, null, diagnostics);
        return;
    }

    const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    const lockState = getTrackLockState(signature, serverSettings);

    populateCacheDiagnostics(diagnostics, serverSettings);

    if (lockState.effectiveLocked) {
        diagnostics.cacheStatus = "locked";
        diagnostics.lockReason = lockState.trackLocked
            ? "track"
            : (lockState.albumLocked ? "album" : null);
        clearLyrics(io, deviceInfo, "locked", signature, trackKey, diagnostics);
        return;
    }

    const metadataToken = metadata && metadata.metadataTimeStamp ? metadata.metadataTimeStamp : null;
    if (deviceInfo.lyrics && deviceInfo.lyrics.trackKey === trackKey && deviceInfo.lyrics.status === "ok") {
        return;
    }

    const isStaleRequest = () => {
        if (!metadataToken || !deviceInfo.metadata || !deviceInfo.metadata.metadataTimeStamp) {
            return false;
        }
        return Number(deviceInfo.metadata.metadataTimeStamp) !== Number(metadataToken);
    };

    const normalizedSignature = {
        trackName: normalizeText(signature.trackName),
        artistName: normalizeText(signature.artistName),
        albumName: normalizeAlbum(signature.albumName)
    };

    const clearResolvedFailure = () => {
        lyricsFailures.deleteFailureBySignature(signature, normalizedSignature, serverSettings);
    };

    const cacheLookup = findCachedLyricsForSignature(signature, serverSettings);
    diagnostics.cacheLookupMs = cacheLookup.durationMs;
    diagnostics.cacheStatus = cacheLookup.status;
    diagnostics.cacheSizeBytes = cacheLookup.cacheConfig?.enabled
        ? lyricsCache.getCacheStats(cacheLookup.cacheConfig).totalSize
        : 0;
    diagnostics.cacheMaxBytes = cacheLookup.cacheConfig?.maxSizeBytes || 0;

    if (cacheLookup.status === "hit" && cacheLookup.payload) {
        diagnostics.totalMs = Date.now() - diagnostics.requestedAt;
        log(`Lyrics cache hit (${cacheLookup.durationMs}ms)`, trackKey);
        clearResolvedFailure();
        setLyricsState(io, deviceInfo, {
            ...cacheLookup.payload,
            diagnostics
        });
        schedulePrefetchForSignature(io, signature, serverSettings, {
            reason: "cache-hit"
        });
        return;
    }
    if (cacheLookup.status === "miss") {
        log(`Lyrics cache miss (${cacheLookup.durationMs}ms)`, trackKey);
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

    const recordLookupFailure = (reason, diagnosticsSnapshot) => {
        if (deviceInfo.lyrics && deviceInfo.lyrics.trackKey === trackKey && deviceInfo.lyrics.status === reason) {
            return;
        }

        const lookupParams = new URLSearchParams({
            track_name: signature.trackName,
            artist_name: signature.artistName,
            album_name: signature.albumName,
            duration: signature.duration
        });
        lyricsFailures.recordFailure({
            reason,
            signature,
            normalized: normalizedSignature,
            queryString: lookupParams.toString(),
            requests: diagnosticsSnapshot?.requests || [],
            diagnostics: diagnosticsSnapshot || null
        }, serverSettings);
    };

    try {
        const payload = await fetchLyricsForSignature(signature, trackKey, serverSettings, diagnostics);
        if (isStaleRequest()) {
            log("Discard stale lyrics response", { trackKey, metadataToken, currentMetadataTimeStamp: deviceInfo.metadata && deviceInfo.metadata.metadataTimeStamp });
            return;
        }
        diagnostics.totalMs = Date.now() - diagnostics.requestedAt;
        if (payload && payload.status === "ok") {
            const diagnosticsSnapshot = snapshotDiagnostics();
            if (payload.reason === "relaxed-match") {
                log("Lyrics resolved via relaxed lookup", {
                    trackKey,
                    relaxedLookup: payload.lookup,
                    signature
                });
                recordLookupFailure("relaxed-match", diagnosticsSnapshot);
            } else {
                clearResolvedFailure();
            }
            setLyricsState(io, deviceInfo, {
                ...payload,
                diagnostics: diagnosticsSnapshot
            });
            schedulePrefetchForSignature(io, signature, serverSettings, {
                reason: "live-fetch"
            });
            return;
        }

        const failureReason = payload && payload.status ? payload.status : "not-found";
        const diagnosticsSnapshot = snapshotDiagnostics();
        recordLookupFailure(failureReason, diagnosticsSnapshot);
        clearLyrics(io, deviceInfo, failureReason, signature, trackKey, diagnosticsSnapshot);
    } catch (error) {
        if (isStaleRequest()) {
            log("Discard stale lyrics error", { trackKey, metadataToken, currentMetadataTimeStamp: deviceInfo.metadata && deviceInfo.metadata.metadataTimeStamp });
            return;
        }
        log("LRCLIB error:", error.message);
        diagnostics.totalMs = Date.now() - diagnostics.requestedAt;
        const diagnosticsSnapshot = snapshotDiagnostics();
        recordLookupFailure("error", diagnosticsSnapshot);
        clearLyrics(io, deviceInfo, "error", signature, trackKey, diagnosticsSnapshot);
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

    if (!options.forceRemote) {
        const cacheLookup = findCachedLyricsForSignature(signature, serverSettings);
        if (cacheLookup.status === "hit" && cacheLookup.payload) {
            return withPrefetchMetadata(cacheLookup.payload);
        }
    }

    const negative = negativeCache.get(trackKey);
    if (negative && negative.expiresAt > Date.now()) {
        return withPrefetchMetadata(negative.payload);
    }

    const running = inFlightRequests.get(trackKey);
    if (running) {
        return withPrefetchMetadata(await running);
    }

    const request = (async () => {
        let lyrics = null;
        if (options.selectAlternative && options.excludedId) {
            const ranked = await fetchRankedCandidatesBySignature(signature, serverSettings, diagnostics, {
                excludedId: options.excludedId
            });
            lyrics = ranked[0] || null;
        } else {
            lyrics = await fetchLyricsBySignature(signature, serverSettings, diagnostics);
        }
        if (lyrics && lyrics.syncedLyrics) {
            const payload = {
                status: "ok",
                provider: "lrclib",
                reason: lyrics.fallback ? "relaxed-match" : "match",
                lookup: lyrics.fallback || null,
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
            setImmediate(async () => {
                try {
                    const bestLyrics = await fetchBestLyricsBySignature(signature, serverSettings, null);
                    const candidate = bestLyrics || lyrics;
                    const bestPayload = {
                        ...payload,
                        id: candidate.id,
                        trackName: candidate.trackName,
                        artistName: candidate.artistName,
                        albumName: candidate.albumName,
                        duration: candidate.duration,
                        instrumental: candidate.instrumental,
                        syncedLyrics: candidate.syncedLyrics
                    };
                    const storeResult = lyricsCache.storeLyrics(bestPayload, serverSettings);
                    if (storeResult.stored) {
                        log(`Lyrics cached (${storeResult.size} bytes)`, trackKey);
                    } else if (storeResult.error) {
                        log(`Lyrics cache store skipped (${storeResult.error})`, trackKey);
                    }
                } catch (error) {
                    log("Lyrics cache write error:", error.message);
                }
            });
            return payload;
        }

        const payload = {
            status: lyrics?.reason === "no-synced-lyrics" ? "no-synced-lyrics" : "not-found",
            provider: "lrclib",
            trackKey,
            signature
        };
        negativeCache.set(trackKey, {
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

const matchesAlbum = (candidate, signature) => {
    if (!candidate?.albumName || !signature?.albumName) {
        return false;
    }
    const candidateAlbum = normalizeAlbum(candidate.albumName);
    const signatureAlbum = normalizeAlbum(signature.albumName);
    if (!candidateAlbum || !signatureAlbum) {
        return false;
    }
    return candidateAlbum === signatureAlbum
        || candidateAlbum.includes(signatureAlbum)
        || signatureAlbum.includes(candidateAlbum);
};

const fetchPrefetchCandidates = async (params, serverSettings) => {
    const results = await fetchJson(`/api/search?${params.toString()}`, serverSettings);
    if (!Array.isArray(results)) {
        return [];
    }
    return results
        .filter((candidate) => candidate && candidate.syncedLyrics && !candidate.instrumental);
};

const runWithConcurrency = async (items, limit, handler) => new Promise((resolve) => {
    const results = [];
    let index = 0;
    let active = 0;

    const next = () => {
        if (index >= items.length && active === 0) {
            resolve(results);
            return;
        }
        while (active < limit && index < items.length) {
            const item = items[index++];
            active += 1;
            Promise.resolve(handler(item))
                .then((result) => results.push(result))
                .catch((error) => results.push({ error }))
                .finally(() => {
                    active -= 1;
                    next();
                });
        }
    };

    next();
});

const storeCandidateInCache = (candidate, serverSettings) => {
    const signature = {
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        albumName: candidate.albumName,
        duration: normalizeDurationForKey(candidate.duration)
    };
    const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    const payload = {
        status: "ok",
        provider: "lrclib",
        trackKey,
        signature,
        id: candidate.id,
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        albumName: candidate.albumName,
        duration: signature.duration,
        instrumental: candidate.instrumental,
        syncedLyrics: candidate.syncedLyrics
    };
    const stored = lyricsCache.storeLyrics(payload, serverSettings);
    return { trackKey, stored: stored.stored, error: stored.error };
};

const prefetchCandidates = async (candidates, serverSettings) => {
    const cacheConfig = getCacheConfig(serverSettings);
    const limit = cacheConfig.maxPrefetchConcurrency || PREFETCH_CONCURRENCY_FALLBACK;
    return runWithConcurrency(candidates, limit, async (candidate) => {
        const signature = {
            trackName: candidate.trackName,
            artistName: candidate.artistName,
            albumName: candidate.albumName,
            duration: normalizeDurationForKey(candidate.duration)
        };
        const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
        const lockState = getTrackLockState(signature, serverSettings);
        if (lockState.effectiveLocked) {
            return {
                trackKey,
                skipped: "locked",
                lockReason: lockState.trackLocked ? "track" : (lockState.albumLocked ? "album" : null)
            };
        }
        if (lyricsCache.hasCachedLyrics(trackKey, serverSettings)) {
            return { trackKey, skipped: "cached" };
        }
        if (inFlightRequests.has(trackKey)) {
            return { trackKey, skipped: "in-flight" };
        }
        return storeCandidateInCache(candidate, serverSettings);
    });
};

const schedulePrefetchForSignature = (io, signature, serverSettings, options = {}) => {
    const cacheConfig = getCacheConfig(serverSettings);
    if (!cacheConfig.enabled) {
        return;
    }
    const mode = getPrefetchMode(serverSettings);
    if (mode === PREFETCH_MODES.OFF) {
        return;
    }
    const prefetchKey = `${signature.trackName}|${signature.artistName}|${signature.albumName}|${signature.duration}|${mode}`;
    if (prefetchInFlight.has(prefetchKey)) {
        return;
    }

    const prefetchPromise = (async () => {
        const startedAt = Date.now();
        const albumKey = normalizeAlbum(signature.albumName);
        const artistKey = normalizeText(signature.artistName);
        const albumLockKey = buildAlbumLockKey(signature.albumName);
        if (lyricsCache.hasLyricsLock(LYRICS_LOCK_TYPES.ALBUM, albumLockKey, serverSettings)) {
            lyricsCache.clearAlbumPrefetchComplete(artistKey, albumKey, serverSettings);
            setLyricsPrefetchState(io, {
                status: "skipped",
                reason: "album-locked",
                mode,
                signature
            });
            return;
        }
        if (lyricsCache.hasAlbumPrefetchComplete(artistKey, albumKey, serverSettings)) {
            setLyricsPrefetchState(io, {
                status: "skipped",
                reason: "album-prefetch-complete",
                mode,
                signature
            });
            return;
        }
        setLyricsPrefetchState(io, {
            status: "start",
            mode,
            signature,
            reason: options.reason || "unknown",
            startedAt
        });

        let totalStored = 0;
        let totalSkipped = 0;
        let totalCandidates = 0;
        let skippedInFlight = 0;
        let skippedCached = 0;
        let skippedOther = 0;
        let skippedLocked = 0;

        const albumParams = new URLSearchParams({
            album_name: signature.albumName,
            artist_name: signature.artistName,
            q: `${signature.artistName} ${signature.albumName}`
        });
        const albumCandidates = mode !== PREFETCH_MODES.OFF
            ? (await fetchPrefetchCandidates(albumParams, serverSettings))
                .filter((candidate) => matchesAlbum(candidate, signature))
            : [];

        totalCandidates += albumCandidates.length;
        const albumResults = await prefetchCandidates(albumCandidates, serverSettings);
        albumResults.forEach((result) => {
            if (result?.stored) {
                totalStored += 1;
            } else {
                totalSkipped += 1;
                if (result?.skipped === "cached") {
                    skippedCached += 1;
                } else if (result?.skipped === "in-flight") {
                    skippedInFlight += 1;
                } else if (result?.skipped === "locked") {
                    skippedLocked += 1;
                } else {
                    skippedOther += 1;
                    if (result?.error) {
                        log(`Lyrics prefetch cache skipped (${result.error})`, result.trackKey);
                    }
                }
            }
        });

        const eligibleCandidates = Math.max(0, totalCandidates - skippedLocked);
        const shouldMarkAlbumComplete = eligibleCandidates > 0
            && skippedLocked === 0
            && skippedInFlight === 0
            && skippedOther === 0;
        if (shouldMarkAlbumComplete) {
            lyricsCache.markAlbumPrefetchComplete(artistKey, albumKey, serverSettings);
        }

        setLyricsPrefetchState(io, {
            status: "done",
            mode,
            signature,
            reason: options.reason || "unknown",
            startedAt,
            totalMs: Date.now() - startedAt,
            totalCandidates,
            stored: totalStored,
            skipped: totalSkipped,
            skippedCached,
            skippedInFlight,
            skippedOther,
            skippedLocked,
            eligibleCandidates
        });
    })().catch((error) => {
        log("LRCLIB prefetch error:", error.message);
        setLyricsPrefetchState(io, {
            status: "error",
            mode: getPrefetchMode(serverSettings),
            signature,
            reason: options.reason || "unknown",
            error: error.message
        });
    }).finally(() => {
        prefetchInFlight.delete(prefetchKey);
    });

    prefetchInFlight.set(prefetchKey, prefetchPromise);
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

    const signature = buildSignatureFromMetadata(metadata);
    if (!signature) {
        setLyricsPrefetchState(io, {
            status: "skipped",
            reason: "missing-signature"
        });
        return;
    }

    const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    const lockState = getTrackLockState(signature, serverSettings);
    if (lockState.effectiveLocked) {
        setLyricsPrefetchState(io, {
            status: "skipped",
            trackKey,
            signature,
            reason: lockState.trackLocked ? "track-locked" : "album-locked"
        });
        return;
    }
    const cached = lyricsCache.getCachedLyrics(trackKey, serverSettings);
    if (cached.status === "hit") {
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
        schedulePrefetchForSignature(io, signature, serverSettings, {
            reason: "next-track-metadata"
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

const controlLyricsForCurrentTrack = async (action, io, deviceInfo, serverSettings) => {
    const signature = buildSignatureFromMetadata(deviceInfo?.metadata);
    if (!signature) {
        return { ok: false, reason: "missing-signature" };
    }

    const trackKey = buildTrackKey(signature.trackName, signature.artistName, signature.albumName, signature.duration);
    const lockState = getTrackLockState(signature, serverSettings);

    if (action === "toggle-track-lock") {
        if (lockState.albumLocked && !lockState.trackLocked) {
            const nextAlbumTrackUnlocked = !lockState.albumTrackUnlocked;
            lyricsCache.setLyricsLock(
                LYRICS_LOCK_TYPES.ALBUM_TRACK_UNLOCK,
                lockState.albumTrackUnlockKey,
                nextAlbumTrackUnlocked,
                serverSettings
            );
            lyricsCache.clearAlbumPrefetchComplete(
                normalizeText(signature.artistName),
                normalizeAlbum(signature.albumName),
                serverSettings
            );
            lyricsCache.deleteCachedLyricsByKey(trackKey, serverSettings);
            negativeCache.delete(trackKey);
            await getLyricsForMetadata(io, deviceInfo, serverSettings);
            return {
                ok: true,
                action,
                trackLocked: !nextAlbumTrackUnlocked,
                albumLocked: true,
                albumTrackUnlocked: nextAlbumTrackUnlocked
            };
        }

        const nextLocked = !lockState.trackLocked;
        lyricsCache.setLyricsLock(LYRICS_LOCK_TYPES.TRACK, lockState.trackLockKey, nextLocked, serverSettings);
        lyricsCache.setLyricsLock(LYRICS_LOCK_TYPES.ALBUM_TRACK_UNLOCK, lockState.albumTrackUnlockKey, false, serverSettings);
        lyricsCache.deleteCachedLyricsByKey(trackKey, serverSettings);
        negativeCache.delete(trackKey);
        await getLyricsForMetadata(io, deviceInfo, serverSettings);
        return {
            ok: true,
            action,
            trackLocked: nextLocked,
            albumLocked: lockState.albumLocked,
            albumTrackUnlocked: lockState.albumLocked ? !nextLocked : false
        };
    }

    if (action === "toggle-album-lock") {
        const nextLocked = !lockState.albumLocked;
        lyricsCache.setLyricsLock(LYRICS_LOCK_TYPES.ALBUM, lockState.albumLockKey, nextLocked, serverSettings);
        if (nextLocked) {
            lyricsCache.clearAlbumPrefetchComplete(
                normalizeText(signature.artistName),
                normalizeAlbum(signature.albumName),
                serverSettings
            );
        } else {
            lyricsCache.deleteLyricsLocksByPrefix(
                LYRICS_LOCK_TYPES.ALBUM_TRACK_UNLOCK,
                `${lockState.albumLockKey}||`,
                serverSettings
            );
        }
        lyricsCache.deleteCachedLyricsByArtistAlbumKey(
            signature.artistName,
            signature.albumName,
            serverSettings
        );
        negativeCache.delete(trackKey);

        if (!nextLocked) {
            deviceInfo.lyrics = null;
            await getLyricsForMetadata(io, deviceInfo, serverSettings);
            schedulePrefetchForSignature(io, signature, serverSettings, {
                reason: "album-unlocked"
            });
            return { ok: true, action, albumLocked: nextLocked, prefetchTriggered: true };
        }

        await getLyricsForMetadata(io, deviceInfo, serverSettings);
        return { ok: true, action, albumLocked: nextLocked };
    }

    if (action === "switch-alternative") {
        const excludedId = deviceInfo?.lyrics?.id || null;
        lyricsCache.deleteCachedLyricsByKey(trackKey, serverSettings);
        negativeCache.delete(trackKey);
        inFlightRequests.delete(trackKey);
        const payload = await fetchLyricsForSignature(signature, trackKey, serverSettings, null, {
            forceRemote: true,
            selectAlternative: true,
            excludedId
        });
        if (!payload || payload.status !== "ok") {
            return { ok: false, action, reason: "no-alternative-match" };
        }
        const storeResult = lyricsCache.storeLyrics(payload, serverSettings);
        setLyricsState(io, deviceInfo, payload);
        return { ok: true, action, switchedToId: payload.id || null, stored: Boolean(storeResult.stored) };
    }

    return { ok: false, reason: "unsupported-action" };
};

const getLyricsControlStateForCurrentTrack = (deviceInfo, serverSettings) => {
    const signature = buildSignatureFromMetadata(deviceInfo?.metadata);
    if (!signature) {
        return { available: false };
    }
    const lockState = getTrackLockState(signature, serverSettings);
    return {
        available: true,
        trackLocked: lockState.effectiveLocked,
        albumLocked: lockState.albumLocked,
        trackLockDirect: lockState.trackLocked,
        albumTrackUnlocked: lockState.albumTrackUnlocked
    };
};

module.exports = {
    getLyricsForMetadata,
    prefetchLyricsForMetadata,
    parseDurationToSeconds,
    buildTrackKey,
    controlLyricsForCurrentTrack,
    getLyricsControlStateForCurrentTrack
};

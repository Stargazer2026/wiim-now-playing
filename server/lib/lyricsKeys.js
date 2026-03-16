// ===========================================================================
// lyricsKeys.js
// Shared canonical key helpers for lyrics cache/locks/prefetch

const normalizeText = (value) => {
    if (!value) {
        return "";
    }
    return String(value)
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
    if (!value) {
        return "";
    }
    return String(value)
        .toLowerCase()
        .replace(/[\[\]()]/g, " ")
        .replace(/&/g, " and ")
        .replace(/feat\.?/g, " ")
        .replace(/ft\.?/g, " ")
        .replace(/[-–—:]/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\b(deluxe|edition|remaster(ed)?|expanded|bonus|anniversary|live|acoustic|mono|stereo|version)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

const normalizeExactKey = (value) => String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const normalizeDurationForKey = (duration) => {
    if (duration === null || duration === undefined) {
        return "";
    }
    if (typeof duration === "number" && Number.isFinite(duration)) {
        return Math.round(duration);
    }
    return duration;
};

const buildTrackKey = (trackName, artistName, albumName, duration) => {
    return [
        normalizeText(trackName),
        normalizeText(artistName),
        normalizeAlbum(albumName),
        normalizeDurationForKey(duration)
    ].join("|");
};

const buildTrackLockKey = (trackName, albumName, duration) => {
    return [
        normalizeExactKey(trackName),
        normalizeExactKey(albumName),
        normalizeDurationForKey(duration)
    ].join("|");
};

const buildAlbumLockKey = (albumName) => normalizeAlbum(albumName);

const buildAlbumTrackUnlockKey = (albumName, trackName, duration) => {
    const albumLockKey = buildAlbumLockKey(albumName);
    const trackPart = [normalizeExactKey(trackName), normalizeDurationForKey(duration)].join("|");
    return [albumLockKey, trackPart].join("||");
};

module.exports = {
    normalizeText,
    normalizeAlbum,
    normalizeExactKey,
    normalizeDurationForKey,
    buildTrackKey,
    buildTrackLockKey,
    buildAlbumLockKey,
    buildAlbumTrackUnlockKey
};

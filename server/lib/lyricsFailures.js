// ===========================================================================
// lyricsFailures.js
//
// Persistent logging for failed LRCLIB lookups (SQLite)

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const log = require("debug")("lib:lyrics-failures");
const lyricsCache = require("./lyricsCache.js");

let db = null;
let statements = null;
let dbError = null;
let configuredPath = null;

const ensureDb = (serverSettings) => {
    const cacheConfig = lyricsCache.getCacheConfig(serverSettings);
    const dbPath = cacheConfig.path;
    if (db && configuredPath === dbPath) {
        return true;
    }
    if (dbError && configuredPath === dbPath) {
        return false;
    }

    configuredPath = dbPath;

    try {
        const directory = path.dirname(dbPath);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        db = new DatabaseSync(dbPath);
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec("PRAGMA synchronous = NORMAL;");

        db.exec(`
            CREATE TABLE IF NOT EXISTS lyrics_lookup_failures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                failedAt INTEGER NOT NULL,
                reason TEXT,
                wiimTrackName TEXT,
                wiimArtistName TEXT,
                wiimAlbumName TEXT,
                wiimDuration INTEGER,
                normalizedTrackName TEXT,
                normalizedArtistName TEXT,
                normalizedAlbumName TEXT,
                queryString TEXT,
                requestsJson TEXT,
                diagnosticsJson TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_lyrics_lookup_failures_failed_at
                ON lyrics_lookup_failures (failedAt DESC);
        `);

        statements = {
            insertFailure: db.prepare(`
                INSERT INTO lyrics_lookup_failures (
                    failedAt,
                    reason,
                    wiimTrackName,
                    wiimArtistName,
                    wiimAlbumName,
                    wiimDuration,
                    normalizedTrackName,
                    normalizedArtistName,
                    normalizedAlbumName,
                    queryString,
                    requestsJson,
                    diagnosticsJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            listFailures: db.prepare(`
                SELECT
                    id,
                    failedAt,
                    reason,
                    wiimTrackName,
                    wiimArtistName,
                    wiimAlbumName,
                    wiimDuration,
                    normalizedTrackName,
                    normalizedArtistName,
                    normalizedAlbumName,
                    queryString,
                    requestsJson,
                    diagnosticsJson
                FROM lyrics_lookup_failures
                ORDER BY failedAt DESC
                LIMIT ?
            `)
        };

        dbError = null;
        return true;
    } catch (error) {
        dbError = error;
        db = null;
        statements = null;
        log("Lyrics failure DB error:", error.message);
        return false;
    }
};

const safeJson = (value) => {
    try {
        return JSON.stringify(value || null);
    } catch {
        return JSON.stringify({ error: "stringify-failed" });
    }
};

const parseJsonField = (value) => {
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const recordFailure = (entry, serverSettings) => {
    if (!entry || !entry.signature) {
        return false;
    }
    if (!ensureDb(serverSettings)) {
        return false;
    }

    const now = Date.now();
    const signature = entry.signature;
    const normalized = entry.normalized || {};

    try {
        statements.insertFailure.run(
            now,
            entry.reason || "not-found",
            signature.trackName || "",
            signature.artistName || "",
            signature.albumName || "",
            signature.duration || null,
            normalized.trackName || "",
            normalized.artistName || "",
            normalized.albumName || "",
            entry.queryString || "",
            safeJson(entry.requests || []),
            safeJson(entry.diagnostics || null)
        );
        log("Stored failed lyrics lookup", signature.artistName || "", "-", signature.trackName || "", entry.reason || "not-found");
        return true;
    } catch (error) {
        log("Unable to store failed lyrics lookup:", error.message);
        return false;
    }
};

const listFailures = (serverSettings, limit = 200) => {
    if (!ensureDb(serverSettings)) {
        return [];
    }
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
    const rows = statements.listFailures.all(safeLimit);
    return rows.map((row) => ({
        ...row,
        requests: parseJsonField(row.requestsJson) || [],
        diagnostics: parseJsonField(row.diagnosticsJson),
        requestsJson: undefined,
        diagnosticsJson: undefined
    }));
};

module.exports = {
    recordFailure,
    listFailures
};

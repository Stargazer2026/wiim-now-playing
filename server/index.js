// ===========================================================================
// index.js
//
// The server to handle the communication between the selected media renderer and the ui client(s)

// Express modules
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const app = express();

// Node.js modules
const http = require("http");
const https = require("https");
const server = http.createServer(app);

// Socket.io modules, with CORS
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Other (custom) modules
const ssdp = require("./lib/ssdp.js"); // SSDP functionality
const upnp = require("./lib/upnpClient.js"); // UPnP Client functionality
const httpApi = require("./lib/httpApi.js"); // HTTP API functionality
const sockets = require("./lib/sockets.js"); // Sockets.io functionality
const shell = require("./lib/shell.js"); // Shell command functionality
const lib = require("./lib/lib.js"); // Generic functionality
const lyrics = require("./lib/lyrics.js"); // Lyrics functionality
const lyricsCache = require("./lib/lyricsCache.js");
const lyricsFailures = require("./lib/lyricsFailures.js");
const coverArt = require("./lib/coverArt.js");
const kiosk = require("./lib/kiosk.js");
const wled = require("./lib/wled.js");
const voicePreset = require("./lib/voicePreset.js");
const log = require("debug")("index"); // See README.md on debugging


const withNormalizedLyricsTrackKey = (metadata) => {
    const track = metadata && metadata.trackMetaData ? metadata.trackMetaData : null;
    if (!track) {
        return metadata;
    }
    const trackName = track["dc:title"] || "";
    const artistName = track["upnp:artist"] || "";
    const albumName = track["upnp:album"] || "";
    const duration = lyrics.parseDurationToSeconds(metadata.TrackDuration);
    const lyricsTrackKey = lyrics.buildTrackKey(trackName, artistName, albumName, duration);
    return {
        ...metadata,
        lyricsTrackKey
    };
};

// For versionioning purposes
// Load the package.json files to get the version numbers
const packageJsonServer = require('../package.json'); // Server package.json
const packageJsonClient = require('../client/package.json'); // Client package.json

// ===========================================================================
// Server constants & variables

// Port 80 is the default www port, if the server won't start then choose another port i.e. 3000, 8000, 8080
// Use PORT environment variable or default to 80
log("process.env.PORT:", process.env.PORT);
const port = process.env.PORT || 80;

// Server side placeholders for data:
let deviceList = []; // Placeholder for found devices through SSDP
let deviceInfo = { // Placeholder for the currently selected device info
    state: null, // Keeps the device state updates
    metadata: null, // Keeps the device metadata updates
    client: null // Keeps the UPnP client object
};
let serverSettings = { // Placeholder for current server settings
    "selectedDevice": { // The selected device properties, a placeholder for now. Will be filled once a (default) device selection has been made.
        "friendlyName": null,
        "manufacturer": null,
        "modelName": null,
        "location": null,
        "actions": {}
    },
    "os": lib.getOS(), // Initially grab the environment we are running in. Things may not have settled yet, so we update this later.
    "timeouts": {
        "immediate": 250, // Timeout for 'immediate' updates in milliseconds. Quarter of a second.
        "state": 4 * 1000, // Timeout for state updates in milliseconds. Adaptive: 1s with clients, 4s when idle.
        "metadata": 4 * 1000, // Timeout for metadata updates in milliseconds. Adaptive: 1s with clients, 4s when idle.
        "rescan": 10 * 1000 // Timeout for possible rescan of devices in milliseconds. Every 10 seconds.
    },
    "features": {
        "lyrics": {
            "enabled": false,
            "provider": "lrclib",
            "offsetMs": 0,
            "insertBlankLineForLongGaps": true,
            "mediumGapSec": 10,
            "longGapSec": 20,
            "cache": {
                "enabled": true,
                "maxSizeMB": 50,
                "prefetch": "album",
                "maxPrefetchConcurrency": 4
            }
        },
        "coverArt": {
            "enabled": false,
            "provider": "caa",
            "memoryPoolMB": 100
        },
        "wled": {
            "enabled": false,
            "host": "",
            "playbackPreset": 0,
            "pausePreset": 0,
            "offDelaySec": 300
        },
        "voicePreset": {
            "voicePresetId": 0,
            "defaultPresetId": 0,
            "lookupEnabled": true
        }
    },
    "kiosk": {
        "host": "",
        "password": "",
        "screenOffDelaySec": 300
    },
    "server": null, // Placeholder for the express server (port) information
    "version": { // Version information for the server and client
        "server": packageJsonServer.version,
        "client": packageJsonClient.version
    }
};

// Interval placeholders:
let pollState = null; // For the renderer state
let pollMetadata = null; // For the renderer metadata
let sleepTimerCheckInterval = null;
let sleepTimer = {
    active: false,
    mode: null,
    durationMinutes: null,
    targetTimeStamp: null,
    createdAt: null,
    trackSignature: null,
    timeoutHandle: null
};

const POLL_INTERVAL_ACTIVE_MS = 1000;
const POLL_INTERVAL_IDLE_MS = 4 * 1000;

const setPollingInterval = (intervalMs) => {
    serverSettings.timeouts.state = intervalMs;
    serverSettings.timeouts.metadata = intervalMs;
};

const stopPolling = () => {
    upnp.stopPolling(pollState, "pollState");
    upnp.stopPolling(pollMetadata, "pollMetadata");
    pollState = null;
    pollMetadata = null;
};

const startPolling = () => {
    pollMetadata = upnp.startMetadata(io, deviceInfo, serverSettings);
    pollState = upnp.startState(io, deviceInfo, serverSettings);
};

const syncPolling = () => {
    const clientCount = io.sockets.sockets.size;
    const hasConnectedClients = clientCount > 0;
    const kioskEnabled = Boolean(serverSettings.kiosk && serverSettings.kiosk.host);
    const shouldPoll = hasConnectedClients || kioskEnabled;
    const desiredInterval = hasConnectedClients ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
    const intervalChanged = serverSettings.timeouts.state !== desiredInterval || serverSettings.timeouts.metadata !== desiredInterval;

    if (!shouldPoll) {
        if (pollState || pollMetadata) {
            log("No sockets are connected!");
            stopPolling();
        }
        return;
    }

    if (intervalChanged) {
        setPollingInterval(desiredInterval);
    }

    if (!pollState || !pollMetadata) {
        startPolling();
        return;
    }

    if (intervalChanged) {
        stopPolling();
        startPolling();
    }
};

const getCurrentTrackSignature = () => {
    if (!deviceInfo || !deviceInfo.metadata) {
        return null;
    }
    if (deviceInfo.metadata.lyricsTrackKey) {
        return deviceInfo.metadata.lyricsTrackKey;
    }
    const track = deviceInfo.metadata.trackMetaData || {};
    return [
        track["dc:title"] || "",
        track["upnp:artist"] || "",
        track["upnp:album"] || "",
        deviceInfo.metadata.TrackDuration || ""
    ].join("::");
};

const getSleepTimerState = () => {
    const remainingMs = sleepTimer.active && sleepTimer.mode === "minutes" && sleepTimer.targetTimeStamp
        ? Math.max(0, sleepTimer.targetTimeStamp - Date.now())
        : null;
    return {
        active: sleepTimer.active,
        mode: sleepTimer.mode,
        durationMinutes: sleepTimer.durationMinutes,
        targetTimeStamp: sleepTimer.targetTimeStamp,
        createdAt: sleepTimer.createdAt,
        remainingMs: remainingMs
    };
};

const emitSleepTimerState = () => {
    io.emit("sleep-timer-state", getSleepTimerState());
};

const clearSleepTimerInternal = () => {
    if (sleepTimer.timeoutHandle) {
        clearTimeout(sleepTimer.timeoutHandle);
    }
    sleepTimer = {
        active: false,
        mode: null,
        durationMinutes: null,
        targetTimeStamp: null,
        createdAt: null,
        trackSignature: null,
        timeoutHandle: null
    };
};

const stopPlaybackForSleepTimer = () => {
    const supportedActions = Array.isArray(serverSettings.selectedDevice.actions) ? serverSettings.selectedDevice.actions : [];
    if (supportedActions.includes("Stop")) {
        upnp.callDeviceAction(io, "Stop", deviceInfo, serverSettings);
        return "Stop";
    }
    if (supportedActions.includes("Pause")) {
        upnp.callDeviceAction(io, "Pause", deviceInfo, serverSettings);
        return "Pause";
    }
    upnp.callDeviceAction(io, "Stop", deviceInfo, serverSettings);
    return "Stop";
};

const triggerSleepTimer = (reason) => {
    if (!sleepTimer.active) {
        return;
    }
    clearSleepTimerInternal();
    emitSleepTimerState();
    if (serverSettings.selectedDevice && serverSettings.selectedDevice.location) {
        const action = stopPlaybackForSleepTimer();
        log("Sleep timer triggered", reason, action);
    }
};

const cancelSleepTimer = () => {
    clearSleepTimerInternal();
    emitSleepTimerState();
};

const startMinutesSleepTimer = (minutes) => {
    const durationMinutes = Math.max(1, Math.round(minutes));
    clearSleepTimerInternal();
    sleepTimer.active = true;
    sleepTimer.mode = "minutes";
    sleepTimer.durationMinutes = durationMinutes;
    sleepTimer.createdAt = Date.now();
    sleepTimer.targetTimeStamp = sleepTimer.createdAt + (durationMinutes * 60 * 1000);
    sleepTimer.timeoutHandle = setTimeout(() => {
        triggerSleepTimer("time-elapsed");
    }, durationMinutes * 60 * 1000);
    emitSleepTimerState();
    return getSleepTimerState();
};

const startSongEndSleepTimer = () => {
    clearSleepTimerInternal();
    sleepTimer.active = true;
    sleepTimer.mode = "song-end";
    sleepTimer.createdAt = Date.now();
    sleepTimer.trackSignature = getCurrentTrackSignature();
    emitSleepTimerState();
    return getSleepTimerState();
};

const ensureSleepTimerWatcher = () => {
    if (sleepTimerCheckInterval) {
        return;
    }
    sleepTimerCheckInterval = setInterval(() => {
        if (!sleepTimer.active || sleepTimer.mode !== "song-end") {
            return;
        }
        const currentSignature = getCurrentTrackSignature();
        if (!currentSignature || !sleepTimer.trackSignature) {
            return;
        }
        if (currentSignature !== sleepTimer.trackSignature) {
            triggerSleepTimer("track-changed");
        }
    }, 1000);
};

// ===========================================================================
// Get the server settings from local file storage, if any.
lib.getSettings(serverSettings);
lyricsCache.startCacheMaintenance(serverSettings);
coverArt.applySettings(serverSettings);
kiosk.applySettings(serverSettings);
wled.applySettings(serverSettings, deviceInfo && deviceInfo.state ? deviceInfo.state.CurrentTransportState : null);
syncPolling();
ensureSleepTimerWatcher();

// ===========================================================================
// Initial SSDP scan for devices.
ssdp.scan(deviceList, serverSettings);

// Check after a while whether any device has been found.
// Due to wifi initialisation delay the scan may have failed.
// Not aware of a method of knowing whether wifi connection has been established fully.
setTimeout(() => {
    log("Rescanning devices...");
    // Start new device scan, if first scan failed...
    if (deviceList.length === 0) {
        ssdp.scan(deviceList, serverSettings);
        // The client may not be aware of any devices and have an empty list, waiting for rescan results and send the device list again
        setTimeout(() => {
            sockets.getDevices(io, deviceList);
        }, serverSettings.timeouts.metadata)
    }
    // Node.js may have started before the wifi connection was established, so we rescan after a while
    serverSettings.os = lib.getOS(); // Update the OS information
    io.emit("server-settings", serverSettings); // And resend to clients
}, serverSettings.timeouts.rescan);

// ===========================================================================
// Set Express functionality
// Use CORS
app.use(cors());

// Set up rate limiter to protect static/file-serving routes from bursts.
// Tune with env vars:
// RATE_LIMIT_ENABLED=false to disable.
// RATE_LIMIT_WINDOW_MS (default 15 minutes), RATE_LIMIT_MAX (default 1000).
// As suggested by: https://www.npmjs.com/package/express-rate-limit
const rateLimitEnabled = String(process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() !== "false";
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || 1000;

const limiter = rateLimitEnabled
    ? rateLimit({
        windowMs: rateLimitWindowMs,
        max: rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
    })
    : (req, res, next) => next();

// Apply rate limiter to static/file-serving routes
app.use(limiter);

// By default reroute all clients to the /public server folder
app.use(express.static(__dirname + "/public"));

// Exceptions:
app.get("/tv", limiter, function (req, res) { // TV Mode
    res.sendFile(__dirname + "/public/tv.html");
});
app.get("/wallart", limiter, function (req, res) { // Auto wallart mode
    res.sendFile(__dirname + "/public/wallart.html");
});
app.get("/wallart-portrait", limiter, function (req, res) { // Portrait wallart mode
    res.sendFile(__dirname + "/public/wallart-portrait.html");
});
app.get("/wallart-landscape", limiter, function (req, res) { // Landscape wallart mode
    res.sendFile(__dirname + "/public/wallart-landscape.html");
});

app.get("/debug", limiter, function (req, res) { // Debug page
    res.sendFile(__dirname + "/public/debug.html");
});
app.get("/res", limiter, function (req, res) { // Resolution test page
    res.sendFile(__dirname + "/public/res.html");
});
app.get("/assets", limiter, function (req, res) { // Assets test page
    res.sendFile(__dirname + "/public/assets.html");
});
app.get("/analyze", limiter, function (req, res) { // Lyrics analysis page
    res.sendFile(__dirname + "/public/analyze.html");
});

app.get("/api/wled/toggle", limiter, function (req, res) {
    const currentEnabled = Boolean(serverSettings && serverSettings.features && serverSettings.features.wled && serverSettings.features.wled.enabled);
    serverSettings.features.wled.enabled = !currentEnabled;
    lib.saveSettings(serverSettings);
    wled.applySettings(serverSettings, deviceInfo && deviceInfo.state ? deviceInfo.state.CurrentTransportState : null);
    io.emit("server-settings", serverSettings);
    res.json({
        success: true,
        enabled: serverSettings.features.wled.enabled
    });
});

app.get("/api/lyrics-failures", limiter, function (req, res) {
    const limit = parseInt(req.query.limit, 10) || 250;
    const entries = lyricsFailures.listFailures(serverSettings, limit);
    res.json({
        total: entries.length,
        entries
    });
});

app.get("/api/lyrics-control-state", limiter, function (req, res) {
    const controls = lyrics.getLyricsControlStateForCurrentTrack(deviceInfo, serverSettings);
    res.json(controls);
});

const executeDeviceAction = (action, res) => {
    if (!serverSettings.selectedDevice.location) {
        res.status(409).json({
            ok: false,
            reason: "no-device-selected"
        });
        return;
    }
    if (!Array.isArray(serverSettings.selectedDevice.actions) || !serverSettings.selectedDevice.actions.includes(action)) {
        res.status(409).json({
            ok: false,
            reason: "action-not-supported",
            action
        });
        return;
    }
    upnp.callDeviceAction(io, action, deviceInfo, serverSettings);
    res.json({
        ok: true,
        type: "upnp-action",
        action
    });
};

const executeDeviceApiCommand = (command, res, extraPayload = {}) => {
    if (!serverSettings.selectedDevice.location) {
        res.status(409).json({
            ok: false,
            reason: "no-device-selected"
        });
        return;
    }

    httpApi.callApi(io, command, serverSettings);
    res.json({
        ok: true,
        type: "http-api-command",
        command,
        ...extraPayload
    });
};

const getVolumeDelta = (req, res) => {
    const rawDelta = req.query && req.query.delta !== undefined
        ? req.query.delta
        : "5";
    const delta = Number.parseInt(rawDelta, 10);
    if (!Number.isInteger(delta) || delta <= 0) {
        res.status(400).json({
            ok: false,
            reason: "invalid-delta",
            details: "delta must be an integer > 0"
        });
        return null;
    }
    return delta;
};

const getCurrentVolume = () => {
    const metadataVolume = deviceInfo && deviceInfo.metadata
        ? Number.parseInt(deviceInfo.metadata.CurrentVolume, 10)
        : NaN;
    if (Number.isInteger(metadataVolume)) {
        return metadataVolume;
    }
    const stateVolume = deviceInfo && deviceInfo.state
        ? Number.parseInt(deviceInfo.state.CurrentVolume, 10)
        : NaN;
    if (Number.isInteger(stateVolume)) {
        return stateVolume;
    }
    return null;
};

const changeVolumeRelative = (req, res, direction) => {
    const delta = getVolumeDelta(req, res);
    if (delta === null) {
        return;
    }

    const currentVolume = getCurrentVolume();
    if (!Number.isInteger(currentVolume)) {
        res.status(409).json({
            ok: false,
            reason: "volume-unavailable",
            details: "current volume is not available yet"
        });
        return;
    }

    const nextVolumeRaw = direction === "up"
        ? currentVolume + delta
        : currentVolume - delta;
    const nextVolume = Math.max(0, Math.min(100, nextVolumeRaw));
    executeDeviceApiCommand(`setPlayerCmd:vol:${nextVolume}`, res, {
        direction,
        delta,
        previousVolume: currentVolume,
        targetVolume: nextVolume
    });
};

app.get("/api/remote/play-pause-toggle", limiter, function (req, res) {
    const currentTransportState = (deviceInfo && deviceInfo.state && deviceInfo.state.CurrentTransportState)
        ? deviceInfo.state.CurrentTransportState
        : null;
    const action = currentTransportState === "PLAYING" ? "Pause" : "Play";
    executeDeviceAction(action, res);
});

app.get("/api/remote/forward", limiter, function (req, res) {
    executeDeviceAction("Next", res);
});

app.get("/api/remote/backward", limiter, function (req, res) {
    executeDeviceAction("Previous", res);
});

app.get("/api/remote/volume-up", limiter, function (req, res) {
    changeVolumeRelative(req, res, "up");
});

app.get("/api/remote/volume-down", limiter, function (req, res) {
    changeVolumeRelative(req, res, "down");
});

app.get("/api/remote/preset/:id", limiter, function (req, res) {
    const presetId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(presetId) || presetId <= 0) {
        res.status(400).json({
            ok: false,
            reason: "invalid-preset-id",
            details: "preset id must be an integer > 0"
        });
        return;
    }
    executeDeviceApiCommand(`MCUKeyShortClick:${presetId}`, res, { presetId });
});

app.get("/api/remote/sleep-timer", limiter, function (req, res) {
    const mode = typeof req.query.mode === "string" ? req.query.mode : "minutes";
    if (mode === "song-end") {
        const state = startSongEndSleepTimer();
        res.json({
            ok: true,
            type: "sleep-timer",
            ...state
        });
        return;
    }
    const minutes = Number.parseInt(req.query.minutes, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
        res.status(400).json({
            ok: false,
            reason: "invalid-minutes",
            details: "minutes must be an integer > 0"
        });
        return;
    }
    const state = startMinutesSleepTimer(minutes);
    res.json({
        ok: true,
        type: "sleep-timer",
        ...state
    });
});

app.get("/api/remote/sleep-timer/status", limiter, function (req, res) {
    res.json({
        ok: true,
        type: "sleep-timer",
        ...getSleepTimerState()
    });
});

app.delete("/api/remote/sleep-timer", limiter, function (req, res) {
    cancelSleepTimer();
    res.json({
        ok: true,
        type: "sleep-timer",
        ...getSleepTimerState()
    });
});

app.post("/api/lyrics-control", limiter, express.json(), async function (req, res) {
    const action = req.body && typeof req.body.action === "string" ? req.body.action : "";
    try {
        const result = await lyrics.controlLyricsForCurrentTrack(action, io, deviceInfo, serverSettings);
        const controls = lyrics.getLyricsControlStateForCurrentTrack(deviceInfo, serverSettings);
        res.json({ ...result, controls });
    } catch (error) {
        res.status(500).json({ ok: false, reason: error.message || "lyrics-control-failed" });
    }
});

// Proxy https album art requests through this app, because this could be a https request with a self signed certificate.
// If the device does not have a valid (self-signed) certificate the browser cannot load the album art, hence we ignore the self signed certificate.
app.get("/proxy-art", limiter, function (req, res) {
    log("Album Art Proxy request:", req.query.url, req.query.ts);

    // Validate URL
    let targetUrl;
    try {
        targetUrl = new URL(req.query.url);
    } catch (e) {
        res.status(400).send("<div>Invalid URL</div>");
        return;
    }
    if (targetUrl.protocol !== "https:") {
        res.status(400).send("<div>Invalid protocol</div>");
        return;
    }

    const requestOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: targetUrl.pathname + targetUrl.search,
        method: "GET",
        // WiiM endpoints often use self-signed certs; in same LAN we intentionally bypass TLS validation.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        timeout: 6000
    };

    const proxyReq = https.request(requestOptions, (resp) => {
        if (resp.statusCode && resp.statusCode >= 400) {
            log("Album Art Proxy upstream HTTP error", resp.statusCode, targetUrl.href);
            res.status(resp.statusCode).send("<div>Upstream error</div>");
            resp.resume();
            return;
        }

        // Some devices do not set a proper content-type. Keep response permissive to avoid false negatives.
        const contentType = resp.headers["content-type"] || "image/jpeg";
        res.status(resp.statusCode || 200);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "no-store");
        resp.pipe(res);
    });

    proxyReq.on("timeout", () => {
        proxyReq.destroy(new Error("proxy-art timeout"));
    });

    proxyReq.on('error', function (e) {
        log("Album Art Proxy error", targetUrl.href, e && e.message ? e.message : e);
        if (!res.headersSent) {
            res.status(404).send("<div>404 Not Found</div>");
        }
    });

    proxyReq.end();

});

app.get("/cover-art/:cacheKey", limiter, function (req, res) {
    const entry = coverArt.getCachedImage(req.params.cacheKey);
    if (!entry) {
        res.status(404).send("<div>404 Not Found</div>");
        return;
    }
    res.setHeader("Content-Type", entry.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(entry.buffer);
});

// ===========================================================================
// Socket.io definitions

/**
 * On (new) client connection.
 * If first client to connect, then start polling and streaming.
 * @returns {undefined}
 */
io.on("connection", (socket) => {
    log("Client connected");

    // On connection check if this is the first client to connect.
    // If so, start polling the device and streaming to the device(s).
    log("No. of sockets:", io.sockets.sockets.size);
    if (io.sockets.sockets.size === 1) {
        // Start polling the selected device
        syncPolling();
    }

    // Also send the latest known state for newly connected clients.
    // This includes the very first connected client, which otherwise
    // would wait for the next polling cycle before seeing metadata/lyrics.
    socket.emit("state", deviceInfo.state);
    socket.emit("metadata", withNormalizedLyricsTrackKey(deviceInfo.metadata));
    socket.emit("voice-preset-status", voicePreset.getState());
    socket.emit("sleep-timer-state", getSleepTimerState());
    if (deviceInfo.lyrics) {
        socket.emit("lyrics", deviceInfo.lyrics);
    }

    /**
     * On client disconnect.
     * If no clients are connected stop polling and streaming.
     * @returns {undefined}
     */
    socket.on("disconnect", () => {
        log("Client disconnected");

        // On disconnection we check the amount of connected clients.
        // If there is none, the streaming and polling are stopped.
        log("No. of sockets:", io.sockets.sockets.size);
        syncPolling();

    });

    // ======================================
    // Device(s) related

    /**
     * Listener for devices get.
     * @returns {undefined}
     */
    socket.on("devices-get", () => {
        log("Socket event", "devices-get");
        sockets.getDevices(io, deviceList);
    });

    /**
     * Listener for devices refresh.
     * @returns {undefined}
     */
    socket.on("devices-refresh", () => {
        log("Socket event", "devices-refresh");
        sockets.scanDevices(io, ssdp, deviceList, serverSettings);
    });

    /**
     * Listener for device selection.
     * @param {string} msg - The selected device location URI.
     * @returns {undefined}
     */
    socket.on("device-set", (msg) => {
        log("Socket event", "device-set", msg);
        cancelSleepTimer();
        sockets.setDevice(io, deviceList, deviceInfo, serverSettings, msg);
        voicePreset.reset();
        io.emit("voice-preset-status", voicePreset.getState());
        // Immediately get new metadata and state from new device
        upnp.updateDeviceMetadata(io, deviceInfo, serverSettings);
        upnp.updateDeviceState(io, deviceInfo, serverSettings);
    });

    /**
     * Listener for device actions. I.e. Play, Stop, Pause, ...
     * @param {string} msg - The action to perform on the device.
     * @returns {undefined}
     */
    socket.on("device-action", (msg) => {
        log("Socket event", "device-action", msg);
        upnp.callDeviceAction(io, msg, deviceInfo, serverSettings);
    });

    /**
     * Listener for HTTP API commands.
     * @param {string} msg - The API command to perform on the device.
     * @returns {undefined}
     */
    socket.on("device-api", (msg) => {
        log("Socket event", "device-api", msg);
        httpApi.callApi(io, msg, serverSettings);
    });

    socket.on("sleep-timer-set", (msg) => {
        const mode = msg && typeof msg.mode === "string" ? msg.mode : "minutes";
        if (mode === "song-end") {
            startSongEndSleepTimer();
            return;
        }
        const minutes = msg ? Number.parseInt(msg.minutes, 10) : NaN;
        if (!Number.isInteger(minutes) || minutes <= 0) {
            socket.emit("sleep-timer-state", {
                ...getSleepTimerState(),
                error: "invalid-minutes"
            });
            return;
        }
        startMinutesSleepTimer(minutes);
    });

    socket.on("sleep-timer-cancel", () => {
        cancelSleepTimer();
    });

    socket.on("sleep-timer-status", () => {
        socket.emit("sleep-timer-state", getSleepTimerState());
    });

    // ======================================
    // Server related

    /**
     * Listener for server settings.
     * @returns {undefined}
     */
    socket.on("server-settings", () => {
        log("Socket event", "server-settings");
        sockets.getServerSettings(io, serverSettings);
    });

    /**
     * Listener for server settings updates.
     * @param {object} msg - The updated settings.
     * @returns {undefined}
     */
    socket.on("server-settings-update", (msg) => {
        log("Socket event", "server-settings-update", msg);
        if (msg && msg.features && msg.features.lyrics) {
            var shouldRefreshLyrics = false;
            if (typeof msg.features.lyrics.enabled === "boolean") {
                serverSettings.features.lyrics.enabled = msg.features.lyrics.enabled;
                shouldRefreshLyrics = true;
            }
            if (typeof msg.features.lyrics.offsetMs === "number") {
                serverSettings.features.lyrics.offsetMs = msg.features.lyrics.offsetMs;
            }
            if (typeof msg.features.lyrics.insertBlankLineForLongGaps === "boolean") {
                serverSettings.features.lyrics.insertBlankLineForLongGaps = msg.features.lyrics.insertBlankLineForLongGaps;
            }
            var currentMediumGap = (typeof serverSettings.features.lyrics.mediumGapSec === "number")
                ? serverSettings.features.lyrics.mediumGapSec
                : 10;
            var currentLongGap = (typeof serverSettings.features.lyrics.longGapSec === "number")
                ? serverSettings.features.lyrics.longGapSec
                : 20;
            if (typeof msg.features.lyrics.mediumGapSec === "number") {
                currentMediumGap = Math.max(10, Math.round(msg.features.lyrics.mediumGapSec));
            }
            if (typeof msg.features.lyrics.longGapSec === "number") {
                currentLongGap = Math.max(16, Math.round(msg.features.lyrics.longGapSec));
            }
            if (currentLongGap <= currentMediumGap) {
                currentLongGap = currentMediumGap + 1;
            }
            serverSettings.features.lyrics.mediumGapSec = currentMediumGap;
            serverSettings.features.lyrics.longGapSec = currentLongGap;
            if (msg.features.lyrics.cache) {
                if (typeof msg.features.lyrics.cache.enabled === "boolean") {
                    serverSettings.features.lyrics.cache.enabled = msg.features.lyrics.cache.enabled;
                }
                if (typeof msg.features.lyrics.cache.maxSizeMB === "number") {
                    serverSettings.features.lyrics.cache.maxSizeMB = Math.max(0, msg.features.lyrics.cache.maxSizeMB);
                }
                if (typeof msg.features.lyrics.cache.prefetch === "string") {
                    const prefetch = msg.features.lyrics.cache.prefetch;
                    if (prefetch === "off" || prefetch === "album") {
                        serverSettings.features.lyrics.cache.prefetch = prefetch;
                    }
                }
            }
            lib.saveSettings(serverSettings);
            lyricsCache.startCacheMaintenance(serverSettings);
            sockets.getServerSettings(io, serverSettings);
            if (shouldRefreshLyrics) {
                lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings).catch((error) => {
                    log("Lyrics update error", error);
                });
            }
        }
        if (msg && msg.features && msg.features.coverArt) {
            if (typeof msg.features.coverArt.enabled === "boolean") {
                serverSettings.features.coverArt.enabled = msg.features.coverArt.enabled;
            }
            if (typeof msg.features.coverArt.provider === "string") {
                const provider = msg.features.coverArt.provider.toLowerCase();
                if (provider === "caa" || provider === "itunes") {
                    serverSettings.features.coverArt.provider = provider;
                }
            }
            if (typeof msg.features.coverArt.memoryPoolMB === "number") {
                serverSettings.features.coverArt.memoryPoolMB = Math.max(1, Math.round(msg.features.coverArt.memoryPoolMB));
            }
            lib.saveSettings(serverSettings);
            coverArt.applySettings(serverSettings);
            sockets.getServerSettings(io, serverSettings);
        }
        if (msg && msg.features && msg.features.wled) {
            if (typeof msg.features.wled.enabled === "boolean") {
                serverSettings.features.wled.enabled = msg.features.wled.enabled;
            }
            if (typeof msg.features.wled.host === "string") {
                serverSettings.features.wled.host = msg.features.wled.host.trim();
            }
            if (typeof msg.features.wled.playbackPreset === "number") {
                serverSettings.features.wled.playbackPreset = Math.max(0, Math.round(msg.features.wled.playbackPreset));
            }
            if (typeof msg.features.wled.pausePreset === "number") {
                serverSettings.features.wled.pausePreset = Math.max(0, Math.round(msg.features.wled.pausePreset));
            }
            if (typeof msg.features.wled.offDelaySec === "number") {
                serverSettings.features.wled.offDelaySec = Math.max(0, Math.round(msg.features.wled.offDelaySec));
            }
            lib.saveSettings(serverSettings);
            sockets.getServerSettings(io, serverSettings);
            wled.applySettings(serverSettings, deviceInfo && deviceInfo.state ? deviceInfo.state.CurrentTransportState : null);
        }
        if (msg && msg.features && msg.features.voicePreset) {
            if (typeof msg.features.voicePreset.voicePresetId === "number") {
                serverSettings.features.voicePreset.voicePresetId = Math.max(0, Math.round(msg.features.voicePreset.voicePresetId));
            }
            if (typeof msg.features.voicePreset.defaultPresetId === "number") {
                serverSettings.features.voicePreset.defaultPresetId = Math.max(0, Math.round(msg.features.voicePreset.defaultPresetId));
            }
            if (typeof msg.features.voicePreset.lookupEnabled === "boolean") {
                serverSettings.features.voicePreset.lookupEnabled = msg.features.voicePreset.lookupEnabled;
            }
            lib.saveSettings(serverSettings);
            sockets.getServerSettings(io, serverSettings);
            voicePreset.reset();
            voicePreset.applyPresetForMetadata(io, deviceInfo.metadata, serverSettings).catch((error) => {
                log("Voice preset update error", error);
            });
        }
        if (msg && msg.kiosk) {
            if (typeof msg.kiosk.host === "string") {
                serverSettings.kiosk.host = msg.kiosk.host.trim();
            }
            if (typeof msg.kiosk.password === "string") {
                serverSettings.kiosk.password = msg.kiosk.password;
            }
            if (typeof msg.kiosk.screenOffDelaySec === "number") {
                serverSettings.kiosk.screenOffDelaySec = Math.max(0, Math.round(msg.kiosk.screenOffDelaySec));
            }
            lib.saveSettings(serverSettings);
            sockets.getServerSettings(io, serverSettings);
            kiosk.applySettings(serverSettings);
            syncPolling();
        }
    });

    /**
     * Listener for server reboot.
     * @returns {undefined}
     */
    socket.on("server-reboot", () => {
        log("Socket event", "server-reboot");
        shell.reboot(io);
    });

    /**
     * Listener for server shutdown.
     * @returns {undefined}
     */
    socket.on("server-shutdown", () => {
        log("Socket event", "server-shutdown");
        shell.shutdown(io);
    });

    /**
     * Listener for server update (git pull).
     * @returns {undefined}
     */
    socket.on("server-update", () => {
        log("Socket event", "server-update");
        shell.update(io);
    });

});

// Start the webserver and listen for traffic
server.listen(port, () => {
    serverSettings.server = server.address();
    console.log("Web Server started at http://localhost:%s", server.address().port);
});

const shutdownServer = (signal) => {
    log("Shutdown signal received:", signal);
    try {
        lyricsCache.closeCache();
    } finally {
        process.exit(0);
    }
};

process.on("SIGINT", () => shutdownServer("SIGINT"));
process.on("SIGTERM", () => shutdownServer("SIGTERM"));

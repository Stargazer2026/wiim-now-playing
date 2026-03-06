// ===========================================================================
// kiosk.js

/**
 * Fully Kiosk Browser control.
 * @module
 */

const http = require("http");
const log = require("debug")("lib:kiosk");
const displayLog = require("debug")("lib:kiosk:display");

const DISPLAY_PROBE_INTERVAL_MS = 60 * 1000;

let screenOffTimer = null;
let displayProbeTimer = null;
let displayState = {
    isOn: null,
    desiredIsOn: null,
    lastReason: "init",
    lastTransportState: null,
    lastCommand: null,
    lastCommandAt: null,
    lastProbeAt: null,
    lastProbeResult: null
};

const getKioskConfig = (serverSettings) => {
    return serverSettings && serverSettings.kiosk ? serverSettings.kiosk : null;
};

const hasKioskConfig = (serverSettings) => {
    const config = getKioskConfig(serverSettings);
    return Boolean(config && config.host);
};

const buildUrl = (serverSettings, command) => {
    const config = getKioskConfig(serverSettings);
    if (!config || !config.host) {
        return null;
    }
    const password = config.password || "";
    return `http://${config.host}:2323/?cmd=${command}&password=${encodeURIComponent(password)}&type=json`;
};

const getDesiredDisplayState = (transportState) => {
    if (transportState === "PLAYING") {
        return true;
    }
    if (transportState === "PAUSED_PLAYBACK" || transportState === "STOPPED") {
        return false;
    }
    return null;
};

const setDisplayState = (isOn, reason, diagnostics) => {
    const changed = displayState.isOn !== isOn;
    displayState = {
        ...displayState,
        isOn,
        lastReason: reason,
        lastCommandAt: Date.now()
    };
    displayLog("setDisplayState()", {
        changed,
        reason,
        displayState,
        diagnostics
    });
};

const callKioskCommand = (serverSettings, command, reason, diagnostics) => {
    const url = buildUrl(serverSettings, command);
    if (!url) {
        displayLog("callKioskCommand() skipped - missing kiosk config", {
            command,
            reason,
            diagnostics
        });
        return;
    }
    log("Kiosk command:", command, url);
    displayLog("callKioskCommand()", {
        command,
        reason,
        diagnostics,
        url
    });
    if (command === "screenOn") {
        displayState.lastCommand = "screenOn";
        setDisplayState(true, reason || "command:screenOn", diagnostics);
    }
    if (command === "screenOff") {
        displayState.lastCommand = "screenOff";
        setDisplayState(false, reason || "command:screenOff", diagnostics);
    }
    http.get(url, (res) => {
        res.on("data", () => {});
        res.on("end", () => {});
    }).on("error", (err) => {
        log("Kiosk command error:", command, err.message);
        displayLog("callKioskCommand() error", {
            command,
            reason,
            diagnostics,
            error: err.message
        });
    });
};

const clearScreenOffTimer = (reason, diagnostics) => {
    if (screenOffTimer) {
        clearTimeout(screenOffTimer);
        screenOffTimer = null;
        displayLog("clearScreenOffTimer()", {
            reason,
            diagnostics
        });
    }
};

const clearDisplayProbeTimer = (reason, diagnostics) => {
    if (displayProbeTimer) {
        clearInterval(displayProbeTimer);
        displayProbeTimer = null;
        displayLog("clearDisplayProbeTimer()", {
            reason,
            diagnostics
        });
    }
};

const screenOn = (serverSettings, reason, diagnostics) => {
    clearScreenOffTimer("screenOn", diagnostics);
    callKioskCommand(serverSettings, "screenOn", reason, diagnostics);
};

const scheduleScreenOff = (serverSettings, reason, diagnostics, forceImmediate = false) => {
    const config = getKioskConfig(serverSettings);
    if (!config) {
        displayLog("scheduleScreenOff() skipped - no config", {
            reason,
            diagnostics
        });
        return;
    }
    const configuredDelayMs = Math.max(0, Math.round(config.screenOffDelaySec || 0)) * 1000;
    const delayMs = forceImmediate ? 0 : configuredDelayMs;
    clearScreenOffTimer("scheduleScreenOff", diagnostics);
    if (delayMs === 0) {
        callKioskCommand(serverSettings, "screenOff", reason, {
            ...diagnostics,
            configuredDelayMs,
            effectiveDelayMs: delayMs,
            forceImmediate
        });
        return;
    }
    displayLog("scheduleScreenOff() timer created", {
        reason,
        diagnostics,
        configuredDelayMs,
        effectiveDelayMs: delayMs
    });
    screenOffTimer = setTimeout(() => {
        callKioskCommand(serverSettings, "screenOff", `${reason}:timer-fired`, {
            ...diagnostics,
            configuredDelayMs,
            effectiveDelayMs: delayMs,
            timerFired: true
        });
        screenOffTimer = null;
    }, delayMs);
};

const fetchDeviceInfo = (serverSettings, callback) => {
    const url = buildUrl(serverSettings, "deviceInfo");
    if (!url) {
        callback(new Error("missing kiosk config"), null);
        return;
    }

    displayLog("fetchDeviceInfo() request", {
        source: "kiosk.fetchDeviceInfo",
        url
    });

    let responseBody = "";
    http.get(url, (res) => {
        res.on("data", (chunk) => {
            responseBody += chunk.toString();
        });
        res.on("end", () => {
            let payload = null;
            let parseError = null;
            if (responseBody) {
                try {
                    payload = JSON.parse(responseBody);
                } catch (error) {
                    parseError = error;
                }
            }
            if (parseError) {
                callback(parseError, null);
                return;
            }
            callback(null, payload);
        });
    }).on("error", (err) => {
        callback(err, null);
    });
};

const probeDisplayState = (serverSettings, context = {}) => {
    const diagnostics = {
        source: "kiosk.probeDisplayState",
        desiredDisplayState: displayState.desiredIsOn,
        lastTransportState: displayState.lastTransportState,
        rememberedDisplayState: displayState.isOn,
        reason: context.reason || "interval",
        screenOffTimerActive: Boolean(screenOffTimer)
    };

    if (!hasKioskConfig(serverSettings)) {
        displayLog("probeDisplayState() skipped", {
            ...diagnostics,
            skipReason: "missing kiosk config"
        });
        return;
    }

    fetchDeviceInfo(serverSettings, (err, payload) => {
        displayState.lastProbeAt = Date.now();

        if (err) {
            displayState.lastProbeResult = "error";
            displayLog("probeDisplayState() deviceInfo error", {
                ...diagnostics,
                error: err.message
            });
            return;
        }

        const actualDisplayOn = payload && typeof payload.screenOn === "boolean"
            ? payload.screenOn
            : null;

        displayState.lastProbeResult = {
            actualDisplayOn,
            screenLocked: payload && typeof payload.screenLocked === "boolean" ? payload.screenLocked : null,
            displayState: payload && Object.prototype.hasOwnProperty.call(payload, "displayState") ? payload.displayState : null,
            isInScreensaver: payload && typeof payload.isInScreensaver === "boolean" ? payload.isInScreensaver : null,
            timestamp: payload && payload.timestamp ? payload.timestamp : null
        };

        displayLog("probeDisplayState() sampled", {
            ...diagnostics,
            actualDisplayOn,
            payloadSummary: displayState.lastProbeResult
        });

        if (typeof actualDisplayOn === "boolean") {
            displayState.isOn = actualDisplayOn;
        }

        if (displayState.desiredIsOn === null) {
            displayLog("probeDisplayState() skipped reconcile", {
                ...diagnostics,
                actualDisplayOn,
                skipReason: "desired display state unknown"
            });
            return;
        }

        if (actualDisplayOn === null) {
            displayLog("probeDisplayState() skipped reconcile", {
                ...diagnostics,
                skipReason: "deviceInfo missing screenOn"
            });
            return;
        }

        if (actualDisplayOn !== displayState.desiredIsOn) {
            displayLog("probeDisplayState() mismatch detected", {
                ...diagnostics,
                actualDisplayOn,
                desiredDisplayOn: displayState.desiredIsOn,
                reason: "actual display differs from desired state"
            });
            if (displayState.desiredIsOn) {
                screenOn(serverSettings, "probe-reconcile:desired-on", diagnostics);
            } else {
                scheduleScreenOff(serverSettings, "probe-reconcile:desired-off", diagnostics, true);
            }
            return;
        }

        displayLog("probeDisplayState() state in sync", {
            ...diagnostics,
            actualDisplayOn,
            desiredDisplayOn: displayState.desiredIsOn
        });
    });
};

const startDisplayProbeTimer = (serverSettings) => {
    if (!hasKioskConfig(serverSettings)) {
        return;
    }
    if (displayProbeTimer) {
        return;
    }
    displayLog("startDisplayProbeTimer()", {
        source: "kiosk.startDisplayProbeTimer",
        intervalMs: DISPLAY_PROBE_INTERVAL_MS
    });
    probeDisplayState(serverSettings, { reason: "startup" });
    displayProbeTimer = setInterval(() => {
        probeDisplayState(serverSettings, { reason: "interval" });
    }, DISPLAY_PROBE_INTERVAL_MS);
};

const handleTransportState = (currentState, previousState, serverSettings, context = {}) => {
    const desiredDisplayState = getDesiredDisplayState(currentState);
    displayState.desiredIsOn = desiredDisplayState;

    const diagnostics = {
        source: "kiosk.handleTransportState",
        currentState,
        previousState,
        desiredDisplayState,
        displayState,
        screenOffTimerActive: Boolean(screenOffTimer),
        track: context.track || null,
        relTime: context.relTime || null,
        trackSource: context.trackSource || null,
        wnpState: context.wnpState || null
    };

    if (!hasKioskConfig(serverSettings) || !currentState) {
        displayLog("handleTransportState() skipped", {
            ...diagnostics,
            reason: "missing kiosk config or state"
        });
        return;
    }

    startDisplayProbeTimer(serverSettings);

    displayState.lastTransportState = currentState;
    displayLog("handleTransportState() poll", diagnostics);

    if (desiredDisplayState !== null && displayState.isOn !== null && displayState.isOn !== desiredDisplayState) {
        displayLog("handleTransportState() mismatch detected", {
            ...diagnostics,
            reason: "display state differs from WiiM transport state"
        });
        if (desiredDisplayState) {
            screenOn(serverSettings, "reconcile-mismatch:wiim-playing", diagnostics);
        } else {
            scheduleScreenOff(serverSettings, "reconcile-mismatch:wiim-not-playing", diagnostics, true);
        }
        return;
    }

    if (currentState === "PLAYING") {
        if (previousState !== "PLAYING" || screenOffTimer) {
            screenOn(serverSettings, "transport-state:playing", diagnostics);
        } else {
            clearScreenOffTimer("already-playing", diagnostics);
        }
        return;
    }
    if (currentState === "PAUSED_PLAYBACK" || currentState === "STOPPED") {
        if (previousState !== currentState) {
            scheduleScreenOff(serverSettings, `transport-state:${currentState.toLowerCase()}`, diagnostics);
        }
    }
};

const applySettings = (serverSettings) => {
    if (!hasKioskConfig(serverSettings)) {
        clearScreenOffTimer("applySettings:no-kiosk-config", { source: "kiosk.applySettings" });
        clearDisplayProbeTimer("applySettings:no-kiosk-config", { source: "kiosk.applySettings" });
        displayState = {
            isOn: null,
            desiredIsOn: null,
            lastReason: "applySettings:no-kiosk-config",
            lastTransportState: null,
            lastCommand: null,
            lastCommandAt: null,
            lastProbeAt: null,
            lastProbeResult: null
        };
        displayLog("applySettings() reset display state", displayState);
        return;
    }

    startDisplayProbeTimer(serverSettings);
};

module.exports = {
    handleTransportState,
    applySettings
};

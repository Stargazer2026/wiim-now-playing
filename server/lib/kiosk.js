// ===========================================================================
// kiosk.js

/**
 * Fully Kiosk Browser control.
 * @module
 */

const http = require("http");
const log = require("debug")("lib:kiosk");
const displayLog = require("debug")("lib:kiosk:display");

let screenOffTimer = null;
let displayState = {
    isOn: null,
    lastReason: "init",
    lastTransportState: null,
    lastCommand: null,
    lastCommandAt: null
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

const handleTransportState = (currentState, previousState, serverSettings, context = {}) => {
    const diagnostics = {
        source: "kiosk.handleTransportState",
        currentState,
        previousState,
        desiredDisplayState: getDesiredDisplayState(currentState),
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

    displayState.lastTransportState = currentState;
    displayLog("handleTransportState() poll", diagnostics);

    const desiredDisplayState = getDesiredDisplayState(currentState);
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
        displayState = {
            isOn: null,
            lastReason: "applySettings:no-kiosk-config",
            lastTransportState: null,
            lastCommand: null,
            lastCommandAt: null
        };
        displayLog("applySettings() reset display state", displayState);
    }
};

module.exports = {
    handleTransportState,
    applySettings
};

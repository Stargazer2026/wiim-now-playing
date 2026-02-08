// ===========================================================================
// kiosk.js

/**
 * Fully Kiosk Browser control.
 * @module
 */

const http = require("http");
const log = require("debug")("lib:kiosk");

let screenOffTimer = null;

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

const callKioskCommand = (serverSettings, command) => {
    const url = buildUrl(serverSettings, command);
    if (!url) {
        return;
    }
    log("Kiosk command:", command, url);
    http.get(url, (res) => {
        res.on("data", () => {});
        res.on("end", () => {});
    }).on("error", (err) => {
        log("Kiosk command error:", command, err.message);
    });
};

const clearScreenOffTimer = () => {
    if (screenOffTimer) {
        clearTimeout(screenOffTimer);
        screenOffTimer = null;
    }
};

const screenOn = (serverSettings) => {
    clearScreenOffTimer();
    callKioskCommand(serverSettings, "screenOn");
};

const scheduleScreenOff = (serverSettings) => {
    const config = getKioskConfig(serverSettings);
    if (!config) {
        return;
    }
    const delayMs = Math.max(0, Math.round(config.screenOffDelaySec || 0)) * 1000;
    clearScreenOffTimer();
    if (delayMs === 0) {
        callKioskCommand(serverSettings, "screenOff");
        return;
    }
    screenOffTimer = setTimeout(() => {
        callKioskCommand(serverSettings, "screenOff");
        screenOffTimer = null;
    }, delayMs);
};

const handleTransportState = (currentState, previousState, serverSettings) => {
    if (!hasKioskConfig(serverSettings) || !currentState) {
        return;
    }
    if (currentState === "PLAYING") {
        if (previousState !== "PLAYING" || screenOffTimer) {
            screenOn(serverSettings);
        } else {
            clearScreenOffTimer();
        }
        return;
    }
    if (currentState === "PAUSED_PLAYBACK" || currentState === "STOPPED") {
        if (previousState !== currentState) {
            scheduleScreenOff(serverSettings);
        }
    }
};

const applySettings = (serverSettings) => {
    if (!hasKioskConfig(serverSettings)) {
        clearScreenOffTimer();
    }
};

module.exports = {
    handleTransportState,
    applySettings
};

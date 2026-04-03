// ===========================================================================
// wled.js

/**
 * WLED REST integration.
 * @module
 */

const http = require("http");
const log = require("debug")("lib:wled");

let switchOffTimer = null;

const getWledConfig = (serverSettings) => {
    if (!serverSettings || !serverSettings.features) {
        return null;
    }
    return serverSettings.features.wled || null;
};

const canControlWled = (serverSettings) => {
    const config = getWledConfig(serverSettings);
    return Boolean(config && config.enabled && config.host);
};

const sendWledState = (serverSettings, payload) => {
    const config = getWledConfig(serverSettings);
    if (!config || !config.host) {
        return;
    }

    const requestData = JSON.stringify(payload);
    const options = {
        hostname: config.host,
        port: 80,
        path: "/json/state",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestData)
        },
        timeout: 3000
    };

    const req = http.request(options, (res) => {
        res.on("data", () => { });
    });

    req.on("error", (error) => {
        log("WLED request error:", error.message);
    });

    req.on("timeout", () => {
        req.destroy(new Error("WLED request timed out"));
    });

    req.write(requestData);
    req.end();
};

const clearSwitchOffTimer = () => {
    if (switchOffTimer) {
        clearTimeout(switchOffTimer);
        switchOffTimer = null;
    }
};

const sendPresetState = (serverSettings, presetKey) => {
    const config = getWledConfig(serverSettings) || {};
    const presetValue = (typeof config[presetKey] === "number" && config[presetKey] > 0)
        ? config[presetKey]
        : 0;

    if (presetValue > 0) {
        sendWledState(serverSettings, { on: true, ps: presetValue });
        return true;
    }

    return false;
};

const turnOn = (serverSettings) => {
    if (!sendPresetState(serverSettings, "playbackPreset")) {
        sendWledState(serverSettings, { on: true });
    }
};

const turnOff = (serverSettings) => {
    sendWledState(serverSettings, { on: false });
};

const getConfiguredOffDelayMs = (serverSettings) => {
    const config = getWledConfig(serverSettings) || {};
    return Math.max(0, Math.round(config.offDelaySec || 0)) * 1000;
};

const scheduleTurnOff = (serverSettings) => {
    const delayMs = getConfiguredOffDelayMs(serverSettings);
    clearSwitchOffTimer();

    if (delayMs === 0) {
        turnOff(serverSettings);
        return;
    }

    switchOffTimer = setTimeout(() => {
        switchOffTimer = null;
        turnOff(serverSettings);
    }, delayMs);
};

const handleTransportState = (currentState, previousState, serverSettings) => {
    if (!canControlWled(serverSettings) || !currentState) {
        return;
    }

    if (currentState === "PLAYING") {
        clearSwitchOffTimer();
        if (previousState !== "PLAYING") {
            turnOn(serverSettings);
        }
        return;
    }

    if (currentState === "PAUSED_PLAYBACK" && previousState !== currentState) {
        clearSwitchOffTimer();
        sendPresetState(serverSettings, "pausePreset");
        scheduleTurnOff(serverSettings);
        return;
    }

    if ((currentState === "STOPPED" || currentState === "NO_MEDIA_PRESENT") && previousState !== currentState) {
        scheduleTurnOff(serverSettings);
    }
};

const applySettings = (serverSettings, currentState) => {
    const config = getWledConfig(serverSettings);
    const hasHost = Boolean(config && config.host);
    if (!hasHost) {
        clearSwitchOffTimer();
        return;
    }
    if (!canControlWled(serverSettings)) {
        clearSwitchOffTimer();
        turnOff(serverSettings);
        return;
    }
    if (currentState === "PLAYING") {
        clearSwitchOffTimer();
        turnOn(serverSettings);
    }
};

module.exports = {
    applySettings,
    handleTransportState,
    turnOn,
    turnOff
};

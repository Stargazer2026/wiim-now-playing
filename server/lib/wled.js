// ===========================================================================
// wled.js

/**
 * WLED REST integration.
 * @module
 */

const http = require("http");
const log = require("debug")("lib:wled");

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

const turnOn = (serverSettings) => {
    const config = getWledConfig(serverSettings) || {};
    const payload = { on: true };
    if (typeof config.playbackPreset === "number" && config.playbackPreset > 0) {
        payload.ps = config.playbackPreset;
    }
    sendWledState(serverSettings, payload);
};

const turnOff = (serverSettings) => {
    sendWledState(serverSettings, { on: false });
};

const handleTransportState = (currentState, previousState, serverSettings) => {
    if (!canControlWled(serverSettings) || !currentState) {
        return;
    }

    if (currentState === "PLAYING") {
        if (previousState !== "PLAYING") {
            turnOn(serverSettings);
        }
        return;
    }

    if ((currentState === "PAUSED_PLAYBACK" || currentState === "STOPPED" || currentState === "NO_MEDIA_PRESENT") && previousState !== currentState) {
        turnOff(serverSettings);
    }
};

const applySettings = (serverSettings, currentState) => {
    const config = getWledConfig(serverSettings);
    const hasHost = Boolean(config && config.host);
    if (!hasHost) {
        return;
    }
    if (!canControlWled(serverSettings)) {
        turnOff(serverSettings);
        return;
    }
    if (currentState === "PLAYING") {
        turnOn(serverSettings);
    }
};

module.exports = {
    applySettings,
    handleTransportState,
    turnOn,
    turnOff
};

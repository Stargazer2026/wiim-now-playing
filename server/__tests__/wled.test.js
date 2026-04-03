const http = require("http");

jest.mock("http", () => ({
    request: jest.fn()
}));
jest.mock("../lib/voicePreset.js", () => ({
    getState: jest.fn()
}));
const voicePreset = require("../lib/voicePreset.js");
const wled = require("../lib/wled.js");

describe("wled.js", () => {
    let req;

    beforeEach(() => {
        jest.useFakeTimers();
        voicePreset.getState.mockReturnValue({ lastDetection: null });
        req = {
            on: jest.fn().mockReturnThis(),
            write: jest.fn(),
            end: jest.fn(),
            destroy: jest.fn()
        };
        http.request.mockImplementation((_options, callback) => {
            if (callback) {
                callback({ on: jest.fn() });
            }
            return req;
        });
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("turns WLED on with optional playback preset when playback starts", () => {
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "wled.local",
                    playbackPreset: 3
                }
            }
        };

        wled.handleTransportState("PLAYING", "PAUSED_PLAYBACK", settings);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: true, ps: 3 }));
    });

    it("switches to pause preset on pause and turns WLED off after configured delay", () => {
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "192.168.1.60",
                    playbackPreset: 2,
                    pausePreset: 5,
                    offDelaySec: 5
                }
            }
        };

        wled.handleTransportState("PAUSED_PLAYBACK", "PLAYING", settings);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: true, ps: 5 }));

        jest.advanceTimersByTime(5000);
        expect(http.request).toHaveBeenCalledTimes(2);
        expect(req.write).toHaveBeenNthCalledWith(2, JSON.stringify({ on: false }));
    });

    it("uses switch-off delay when paused and no pause preset is configured", () => {
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "192.168.1.60",
                    playbackPreset: 2,
                    pausePreset: 0,
                    offDelaySec: 5
                }
            }
        };

        wled.handleTransportState("PAUSED_PLAYBACK", "PLAYING", settings);

        expect(http.request).not.toHaveBeenCalled();

        jest.advanceTimersByTime(5000);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: false }));
    });

    it("cancels delayed switch-off when playback resumes", () => {
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "wled.local",
                    playbackPreset: 2,
                    pausePreset: 0,
                    offDelaySec: 5
                }
            }
        };

        wled.handleTransportState("PAUSED_PLAYBACK", "PLAYING", settings);
        wled.handleTransportState("PLAYING", "PAUSED_PLAYBACK", settings);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: true, ps: 2 }));

        jest.advanceTimersByTime(5000);
        expect(req.write).toHaveBeenCalledTimes(1);
    });

    it("does not send requests when integration is disabled", () => {
        const settings = {
            features: {
                wled: {
                    enabled: false,
                    host: "wled.local",
                    playbackPreset: 2,
                    pausePreset: 5
                }
            }
        };

        wled.handleTransportState("PLAYING", "STOPPED", settings);
        wled.handleTransportState("PAUSED_PLAYBACK", "PLAYING", settings);

        expect(http.request).not.toHaveBeenCalled();
    });

    it("uses pause preset while spoken-word is active", () => {
        voicePreset.getState.mockReturnValue({ lastDetection: { spokenWord: true } });
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "wled.local",
                    playbackPreset: 2,
                    pausePreset: 7,
                    pausePresetForSpokenWord: true
                }
            }
        };

        wled.handleTransportState("PLAYING", "STOPPED", settings);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: true, ps: 7 }));
    });

    it("uses playback preset for non-spoken playback", () => {
        voicePreset.getState.mockReturnValue({ lastDetection: { spokenWord: false } });
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "wled.local",
                    playbackPreset: 2,
                    pausePreset: 7,
                    pausePresetForSpokenWord: true
                }
            }
        };

        wled.handleTransportState("PLAYING", "STOPPED", settings);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: true, ps: 2 }));
    });
});

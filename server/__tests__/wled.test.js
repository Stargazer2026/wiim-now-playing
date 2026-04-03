const http = require("http");
const wled = require("../lib/wled.js");

jest.mock("http", () => ({
    request: jest.fn()
}));

describe("wled.js", () => {
    let req;

    beforeEach(() => {
        jest.useFakeTimers();
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
});

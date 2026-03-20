const http = require("http");
const wled = require("../lib/wled.js");

jest.mock("http", () => ({
    request: jest.fn()
}));

describe("wled.js", () => {
    let req;

    beforeEach(() => {
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
        jest.clearAllMocks();
    });

    it("turns WLED on with optional preset when playback starts", () => {
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

    it("turns WLED off when playback stops", () => {
        const settings = {
            features: {
                wled: {
                    enabled: true,
                    host: "192.168.1.60",
                    playbackPreset: 0
                }
            }
        };

        wled.handleTransportState("STOPPED", "PLAYING", settings);

        expect(http.request).toHaveBeenCalledTimes(1);
        expect(req.write).toHaveBeenCalledWith(JSON.stringify({ on: false }));
    });

    it("does not send requests when integration is disabled", () => {
        const settings = {
            features: {
                wled: {
                    enabled: false,
                    host: "wled.local",
                    playbackPreset: 2
                }
            }
        };

        wled.handleTransportState("PLAYING", "STOPPED", settings);

        expect(http.request).not.toHaveBeenCalled();
    });
});

const httpApi = require("../lib/httpApi.js");
const voicePreset = require("../lib/voicePreset.js");

jest.mock("../lib/httpApi.js", () => ({
    callApi: jest.fn()
}));

const io = { emit: jest.fn() };

const buildSettings = (voicePresetId, defaultPresetId, lookupEnabled = false) => ({
    features: {
        voicePreset: {
            voicePresetId,
            defaultPresetId,
            lookupEnabled
        }
    }
});

const buildMetadata = (title, artist, album, duration = "0:03:50", source = "Tidal") => ({
    TrackSource: source,
    TrackDuration: duration,
    trackMetaData: {
        "dc:title": title,
        "upnp:artist": artist,
        "upnp:album": album,
        "upnp:class": "object.item.audioItem.musicTrack"
    }
});

describe("voicePreset.js", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        voicePreset.reset();
    });

    it("detects spoken-word from local text keywords like Hörspiel", () => {
        const metadata = buildMetadata("Kapitel 01", "Das Dschungelbuch", "Das Dschungelbuch (Hörspiel zum Disney Film)");
        const detected = voicePreset.classifyFromLocalMetadata(metadata);
        expect(detected.spokenWord).toBe(true);
        expect(detected.source).toBe("local-text-pattern");
    });

    it("detects spoken-word from chapter patterns and umlaut-insensitive keywords", () => {
        const metadata = buildMetadata(
            "Liliane Susewind - Tiger küssen keine Löwen, Kapitel 1",
            "Tanya Stewner",
            "Liliane Susewind - Tiger küssen keine Löwen (Gekurzte Fassung)"
        );
        const detected = voicePreset.classifyFromLocalMetadata(metadata);
        expect(detected.spokenWord).toBe(true);
    });

    it("applies spoken preset once on track change", async () => {
        const settings = buildSettings(7, 2, false);
        const metadata = buildMetadata("Kapitel 01", "Das Dschungelbuch", "Das Dschungelbuch (Hörspiel zum Disney Film)");

        await voicePreset.applyPresetForMetadata(io, metadata, settings);
        await voicePreset.applyPresetForMetadata(io, metadata, settings);

        expect(httpApi.callApi).toHaveBeenCalledTimes(1);
        expect(httpApi.callApi).toHaveBeenCalledWith(io, "MCUKeyShortClick:7", settings);
    });

    it("sets default preset only when leaving spoken mode", async () => {
        const settings = buildSettings(7, 11, false);
        const spoken = buildMetadata("Kapitel 01", "Das Dschungelbuch", "Das Dschungelbuch (Hörspiel)");
        const music = buildMetadata("Enter Sandman", "Metallica", "Metallica");
        const music2 = buildMetadata("One", "Metallica", "And Justice For All");

        await voicePreset.applyPresetForMetadata(io, spoken, settings);
        await voicePreset.applyPresetForMetadata(io, music, settings);
        await voicePreset.applyPresetForMetadata(io, music2, settings);

        expect(httpApi.callApi).toHaveBeenNthCalledWith(1, io, "MCUKeyShortClick:7", settings);
        expect(httpApi.callApi).toHaveBeenNthCalledWith(2, io, "MCUKeyShortClick:11", settings);
        expect(httpApi.callApi).toHaveBeenCalledTimes(2);
    });

    it("does not set default preset if no spoken preset was applied before", async () => {
        const settings = buildSettings(7, 11, false);
        const music = buildMetadata("Enter Sandman", "Metallica", "Metallica");

        await voicePreset.applyPresetForMetadata(io, music, settings);

        expect(httpApi.callApi).not.toHaveBeenCalled();
    });
});

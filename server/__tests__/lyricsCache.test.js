const fs = require('fs');
const os = require('os');
const path = require('path');
const lyricsCache = require('../lib/lyricsCache.js');

const buildServerSettings = (dbPath) => ({
    features: {
        lyrics: {
            cache: {
                enabled: true,
                maxSizeMB: 10,
                path: dbPath,
                prefetch: 'off'
            }
        }
    }
});

const makePayload = ({ trackKey, trackName, artistName, albumName, duration = 250 }) => ({
    status: 'ok',
    provider: 'lrclib',
    trackKey,
    signature: { trackName, artistName, albumName, duration },
    id: null,
    trackName,
    artistName,
    albumName,
    duration,
    instrumental: false,
    syncedLyrics: '[00:00.00] line'
});

describe('lyricsCache deleteCachedLyricsByArtistAlbumKey', () => {
    afterEach(() => {
        lyricsCache.closeCache();
    });

    it('removes artist album cache entries across close album-key variants', () => {
        const dbPath = path.join(os.tmpdir(), `wnp-lyrics-cache-${Date.now()}-${Math.random()}.sqlite`);
        const settings = buildServerSettings(dbPath);

        lyricsCache.storeLyrics(makePayload({
            trackKey: 'dancing with the dead|powerwolf|wildlive|251',
            trackName: 'Dancing With the Dead',
            artistName: 'Powerwolf',
            albumName: 'Wildlive (Live at Olympiahalle)'
        }), settings);

        lyricsCache.storeLyrics(makePayload({
            trackKey: 'dancing with the dead|powerwolf|wildlive at olympiahalle|251',
            trackName: 'Dancing With the Dead',
            artistName: 'Powerwolf',
            albumName: 'Wildlive: Live at Olympiahalle'
        }), settings);

        lyricsCache.storeLyrics(makePayload({
            trackKey: 'blackened|metallica|and justice for all|405',
            trackName: 'Blackened',
            artistName: 'Metallica',
            albumName: '...And Justice for All'
        }), settings);

        lyricsCache.deleteCachedLyricsByArtistAlbumKey('Powerwolf', 'Wildlive (Live at Olympiahalle)', settings);

        expect(lyricsCache.hasCachedLyrics('dancing with the dead|powerwolf|wildlive|251', settings)).toBe(false);
        expect(lyricsCache.hasCachedLyrics('dancing with the dead|powerwolf|wildlive at olympiahalle|251', settings)).toBe(false);
        expect(lyricsCache.hasCachedLyrics('blackened|metallica|and justice for all|405', settings)).toBe(true);

        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { force: true });
        }
    });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const lyricsCache = require('../lib/lyricsCache.js');

const buildServerSettings = (dbPath) => ({
    features: {
        lyrics: {
            cache: {
                enabled: true,
                maxSizeMB: 64,
                path: dbPath,
                prefetch: 'off'
            }
        }
    }
});

describe('lyricsCache removeLiveLyrics', () => {
    let tempDir;
    let dbPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnp-lyrics-cache-'));
        dbPath = path.join(tempDir, 'lyrics-cache.sqlite');
    });

    afterEach(() => {
        lyricsCache.closeCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('removes cached entries and prefetch markers for live songs and albums', () => {
        const serverSettings = buildServerSettings(dbPath);

        const liveTrackPayload = {
            status: 'ok',
            provider: 'lrclib',
            trackKey: 'track-live',
            signature: {
                trackName: 'Song Name (Live)',
                artistName: 'Band',
                albumName: 'Studio Album',
                duration: 200
            },
            id: 1,
            trackName: 'Song Name (Live)',
            artistName: 'Band',
            albumName: 'Studio Album',
            duration: 200,
            instrumental: false,
            syncedLyrics: '[00:00.00] line'
        };
        const liveAlbumPayload = {
            ...liveTrackPayload,
            trackKey: 'track-live-album',
            id: 2,
            trackName: 'Another Song',
            albumName: 'World Tour Live'
        };
        const normalPayload = {
            ...liveTrackPayload,
            trackKey: 'track-normal',
            id: 3,
            trackName: 'Regular Song',
            albumName: 'Studio Album'
        };

        lyricsCache.storeLyrics(liveTrackPayload, serverSettings);
        lyricsCache.storeLyrics(liveAlbumPayload, serverSettings);
        lyricsCache.storeLyrics(normalPayload, serverSettings);

        lyricsCache.markAlbumPrefetchComplete('band', 'world tour live', serverSettings);
        lyricsCache.markAlbumPrefetchComplete('band', 'studio album', serverSettings);

        const cleanup = lyricsCache.removeLiveLyrics(serverSettings);

        expect(cleanup).toMatchObject({
            removedLyrics: 2,
            removedAlbumPrefetch: 1
        });

        expect(lyricsCache.getCachedLyrics('track-live', serverSettings).status).toBe('miss');
        expect(lyricsCache.getCachedLyrics('track-live-album', serverSettings).status).toBe('miss');
        expect(lyricsCache.getCachedLyrics('track-normal', serverSettings).status).toBe('hit');
        expect(lyricsCache.hasAlbumPrefetchComplete('band', 'world tour live', serverSettings)).toBe(false);
        expect(lyricsCache.hasAlbumPrefetchComplete('band', 'studio album', serverSettings)).toBe(true);
    });
});

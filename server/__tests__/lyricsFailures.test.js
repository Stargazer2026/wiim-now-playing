const fs = require('fs');
const os = require('os');
const path = require('path');

const lyricsFailures = require('../lib/lyricsFailures.js');

describe('lyricsFailures.js', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnp-lyrics-failures-'));
    const dbPath = path.join(tempDir, 'lyrics-failures.sqlite');
    const serverSettings = {
        features: {
            lyrics: {
                cache: {
                    enabled: true,
                    maxSizeMB: 5,
                    path: dbPath
                }
            }
        }
    };

    it('records and lists failed lookups', () => {
        const stored = lyricsFailures.recordFailure({
            reason: 'not-found',
            signature: {
                trackName: 'Song',
                artistName: 'Artist',
                albumName: 'Album',
                duration: 123
            },
            normalized: {
                trackName: 'song',
                artistName: 'artist',
                albumName: 'album'
            },
            queryString: 'track_name=Song&artist_name=Artist&album_name=Album&duration=123',
            requests: [{ endpoint: 'search', result: 'miss', response: [] }],
            diagnostics: { totalMs: 10 }
        }, serverSettings);

        expect(stored).toBe(true);

        const entries = lyricsFailures.listFailures(serverSettings, 10);
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[0]).toMatchObject({
            reason: 'not-found',
            wiimTrackName: 'Song',
            wiimArtistName: 'Artist',
            wiimAlbumName: 'Album',
            normalizedTrackName: 'song',
            normalizedArtistName: 'artist',
            normalizedAlbumName: 'album'
        });
        expect(Array.isArray(entries[0].requests)).toBe(true);
    });
});

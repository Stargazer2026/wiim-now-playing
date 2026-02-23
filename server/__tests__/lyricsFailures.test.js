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

    it('replaces duplicate failed lookups for the same song and keeps different songs', () => {
        const firstStored = lyricsFailures.recordFailure({
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
        expect(firstStored).toBe(true);

        const duplicateStored = lyricsFailures.recordFailure({
            reason: 'error',
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
            requests: [{ endpoint: 'search', result: 'error', response: [] }],
            diagnostics: { totalMs: 12 }
        }, serverSettings);
        expect(duplicateStored).toBe(true);

        const differentSongStored = lyricsFailures.recordFailure({
            reason: 'not-found',
            signature: {
                trackName: 'New Song',
                artistName: 'New Artist',
                albumName: 'New Album',
                duration: 321
            },
            normalized: {
                trackName: 'new song',
                artistName: 'new artist',
                albumName: 'new album'
            },
            queryString: 'track_name=New%20Song&artist_name=New%20Artist&album_name=New%20Album&duration=321',
            requests: [{ endpoint: 'search', result: 'miss', response: [] }],
            diagnostics: { totalMs: 15 }
        }, serverSettings);
        expect(differentSongStored).toBe(true);

        const entries = lyricsFailures.listFailures(serverSettings, 10);
        expect(entries).toHaveLength(2);

        const duplicateEntry = entries.find((entry) => entry.normalizedTrackName === 'song');
        expect(duplicateEntry).toMatchObject({
            reason: 'error',
            wiimTrackName: 'Song',
            wiimArtistName: 'Artist',
            wiimAlbumName: 'Album',
            normalizedTrackName: 'song',
            normalizedArtistName: 'artist',
            normalizedAlbumName: 'album'
        });
        expect(Array.isArray(duplicateEntry.requests)).toBe(true);

        const differentEntry = entries.find((entry) => entry.normalizedTrackName === 'new song');
        expect(differentEntry).toMatchObject({
            reason: 'not-found',
            wiimTrackName: 'New Song',
            wiimArtistName: 'New Artist',
            wiimAlbumName: 'New Album',
            normalizedTrackName: 'new song',
            normalizedArtistName: 'new artist',
            normalizedAlbumName: 'new album'
        });
    });


    it('removes an existing failed lookup when requested', () => {
        const stored = lyricsFailures.recordFailure({
            reason: 'not-found',
            signature: {
                trackName: 'Delete Song',
                artistName: 'Delete Artist',
                albumName: 'Delete Album',
                duration: 111
            },
            normalized: {
                trackName: 'delete song',
                artistName: 'delete artist',
                albumName: 'delete album'
            },
            queryString: 'track_name=Delete+Song&artist_name=Delete+Artist&album_name=Delete+Album&duration=111',
            requests: [],
            diagnostics: null
        }, serverSettings);
        expect(stored).toBe(true);

        const deleted = lyricsFailures.deleteFailureBySignature({
            trackName: 'Delete Song',
            artistName: 'Delete Artist',
            albumName: 'Delete Album',
            duration: 111
        }, {
            trackName: 'delete song',
            artistName: 'delete artist',
            albumName: 'delete album'
        }, serverSettings);
        expect(deleted).toBe(true);

        const entries = lyricsFailures.listFailures(serverSettings, 100);
        const deletedEntry = entries.find((entry) => entry.normalizedTrackName === 'delete song');
        expect(deletedEntry).toBeUndefined();
    });
});

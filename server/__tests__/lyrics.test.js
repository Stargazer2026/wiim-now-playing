const { EventEmitter } = require('events');

jest.mock('https');
jest.mock('../lib/lyricsCache.js', () => ({
    getCacheConfig: jest.fn(() => ({ enabled: false, maxSizeBytes: 0, path: '/tmp/test.sqlite' })),
    getCachedLyrics: jest.fn(() => ({ status: 'miss', durationMs: 0, cacheConfig: { enabled: false, maxSizeBytes: 0 } })),
    getCacheStats: jest.fn(() => ({ totalSize: 0 })),
    hasCachedLyrics: jest.fn(() => false),
    hasLyricsLock: jest.fn(() => false),
    setLyricsLock: jest.fn(),
    deleteCachedLyricsByKey: jest.fn(),
    deleteCachedLyricsByAlbumName: jest.fn(),
    deleteCachedLyricsByArtistAlbumKey: jest.fn(),
    deleteLyricsLocksByPrefix: jest.fn(),
    hasAlbumPrefetchComplete: jest.fn(() => false),
    markAlbumPrefetchComplete: jest.fn(),
    clearAlbumPrefetchComplete: jest.fn(),
    storeLyrics: jest.fn(() => ({ stored: false }))
}));
jest.mock('../lib/lyricsFailures.js', () => ({
    recordFailure: jest.fn(),
    deleteFailureBySignature: jest.fn()
}));

const https = require('https');
const lyrics = require('../lib/lyrics.js');
const lyricsCache = require('../lib/lyricsCache.js');
const lyricsFailures = require('../lib/lyricsFailures.js');

const buildDeviceInfo = (overrides = {}) => ({
    metadata: {
        trackMetaData: {
            'dc:title': overrides.trackName || 'Rising High',
            'upnp:artist': overrides.artistName || 'Beyond The Black',
            'upnp:album': overrides.albumName || 'Break The Silence'
        },
        TrackDuration: overrides.trackDuration || '00:03:12',
        metadataTimeStamp: Date.now()
    },
    state: {
        stateTimeStamp: Date.now()
    },
    lyrics: null
});

const buildServerSettings = () => ({
    timeouts: { metadata: 4000 },
    features: {
        lyrics: {
            enabled: true,
            cache: {
                enabled: false,
                maxSizeMB: 0,
                prefetch: 'off'
            }
        }
    },
    version: { server: 'test' }
});

describe('lyrics.js failure logging', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            res.statusCode = 404;
            process.nextTick(() => {
                cb(res);
                res.emit('end');
            });
            return {
                on: jest.fn()
            };
        });
    });

    it('logs failed lookup when lrclib returns not found', async () => {
        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();

        await lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings);

        expect(lyricsFailures.recordFailure).toHaveBeenCalledTimes(1);
        expect(lyricsFailures.recordFailure.mock.calls[0][0]).toMatchObject({
            reason: 'not-found',
            signature: {
                trackName: 'Rising High',
                artistName: 'Beyond The Black',
                albumName: 'Break The Silence',
                duration: 192
            }
        });

        expect(io.emit).toHaveBeenCalledWith('lyrics', expect.objectContaining({
            status: 'not-found'
        }));
    });

    it('clears stored failure when lookup succeeds', async () => {
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            const requestUrl = typeof url === 'string' ? url : '';
            let payload = '';
            if (requestUrl.includes('/api/search?')) {
                res.statusCode = 200;
                payload = JSON.stringify([
                    {
                        id: 99,
                        trackName: 'Shine and Shade',
                        artistName: 'Band X',
                        albumName: 'Album X',
                        duration: 192,
                        instrumental: false,
                        syncedLyrics: '[00:00.00] Test line'
                    }
                ]);
            } else {
                res.statusCode = 404;
            }

            process.nextTick(() => {
                cb(res);
                if (payload) {
                    res.emit('data', payload);
                }
                res.emit('end');
            });
            return {
                on: jest.fn()
            };
        });

        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo({
            trackName: 'Shine and Shade',
            artistName: 'Band X',
            albumName: 'Album X',
            trackDuration: '00:03:12'
        });
        const serverSettings = buildServerSettings();

        await lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings);

        expect(lyricsFailures.deleteFailureBySignature).toHaveBeenCalledTimes(1);
        expect(lyricsFailures.recordFailure).not.toHaveBeenCalled();
        expect(io.emit).toHaveBeenCalledWith('lyrics', expect.objectContaining({
            status: 'ok'
        }));
    });

    it('records relaxed-match when album-based lookup fails but relaxed search finds synced lyrics', async () => {
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            const requestUrl = typeof url === 'string' ? url : '';
            let payload = '';
            if (requestUrl.includes('/api/search?')
                && requestUrl.includes('album_name=Comeblack%2FAcoustica')) {
                res.statusCode = 200;
                payload = JSON.stringify([
                    {
                        id: 10,
                        trackName: 'Still Loving You',
                        artistName: 'Scorpions',
                        albumName: 'Comeblack/Acoustica',
                        duration: 387,
                        instrumental: false,
                        plainLyrics: 'unsynced only'
                    }
                ]);
            } else if (requestUrl.includes('/api/search?') && !requestUrl.includes('album_name=')) {
                res.statusCode = 200;
                payload = JSON.stringify([
                    {
                        id: 11,
                        trackName: 'Still Loving You',
                        artistName: 'Scorpions',
                        albumName: 'Love at First Sting',
                        duration: 385,
                        instrumental: false,
                        syncedLyrics: '[00:00.00] synced'
                    }
                ]);
            } else {
                res.statusCode = 404;
            }

            process.nextTick(() => {
                cb(res);
                if (payload) {
                    res.emit('data', payload);
                }
                res.emit('end');
            });
            return {
                on: jest.fn()
            };
        });

        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo({
            trackName: 'Still Loving You',
            artistName: 'Scorpions',
            albumName: 'Comeblack/Acoustica',
            trackDuration: '00:06:26'
        });
        const serverSettings = buildServerSettings();

        await lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings);

        expect(lyricsFailures.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'relaxed-match'
        }), serverSettings);
        expect(io.emit).toHaveBeenCalledWith('lyrics', expect.objectContaining({
            status: 'ok',
            reason: 'relaxed-match',
            lookup: {
                mode: 'relaxed-track-artist',
                reason: 'album-no-synced-lyrics'
            }
        }));
    });

    it('accepts relaxed fallback matches when artist or title formatting differs but score and duration match', async () => {
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            const requestUrl = typeof url === 'string' ? url : '';
            let payload = '';
            if (requestUrl.includes('/api/search?')
                && requestUrl.includes('album_name=Comeblack%2FAcoustica')) {
                res.statusCode = 200;
                payload = JSON.stringify([]);
            } else if (requestUrl.includes('/api/search?') && !requestUrl.includes('album_name=')) {
                res.statusCode = 200;
                payload = JSON.stringify([
                    {
                        id: 15,
                        trackName: 'Still Loving You - Remastered',
                        artistName: 'Scorpions feat. Guest',
                        albumName: 'Best Of',
                        duration: 404,
                        instrumental: false,
                        syncedLyrics: '[00:00.00] synced'
                    }
                ]);
            } else {
                res.statusCode = 404;
            }

            process.nextTick(() => {
                cb(res);
                if (payload) {
                    res.emit('data', payload);
                }
                res.emit('end');
            });
            return {
                on: jest.fn()
            };
        });

        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo({
            trackName: 'Still Loving You',
            artistName: 'Scorpions',
            albumName: 'Comeblack/Acoustica',
            trackDuration: '00:06:43'
        });
        const serverSettings = buildServerSettings();

        await lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings);

        expect(io.emit).toHaveBeenCalledWith('lyrics', expect.objectContaining({
            status: 'ok',
            reason: 'relaxed-match',
            id: 15
        }));
    });

});


    it('skips prefetch when album is locked', async () => {
        const io = { emit: jest.fn() };
        const metadata = buildDeviceInfo().metadata;
        const serverSettings = buildServerSettings();
        serverSettings.features.lyrics.cache.enabled = true;
        serverSettings.features.lyrics.cache.maxSizeMB = 10;
        serverSettings.features.lyrics.cache.prefetch = 'album';

        lyricsCache.getCacheConfig.mockReturnValue({
            enabled: true,
            maxSizeBytes: 10 * 1024 * 1024,
            maxPrefetchConcurrency: 4,
            prefetch: 'album',
            path: '/tmp/test.sqlite'
        });
        lyricsCache.hasLyricsLock.mockImplementation((lockType) => lockType === 'album');

        await lyrics.prefetchLyricsForMetadata(io, metadata, serverSettings);

        expect(https.get).not.toHaveBeenCalled();
        expect(lyricsCache.storeLyrics).not.toHaveBeenCalled();
    });

describe('lyrics control actions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('toggles track lock and clears cached lyrics', async () => {
        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();

        lyricsCache.hasLyricsLock.mockImplementation(() => false);

        const result = await lyrics.controlLyricsForCurrentTrack('toggle-track-lock', io, deviceInfo, serverSettings);

        expect(result).toMatchObject({ ok: true, trackLocked: true });
        expect(lyricsCache.setLyricsLock).toHaveBeenCalled();
        expect(lyricsCache.setLyricsLock).toHaveBeenCalledWith('album-track-unlock', expect.any(String), false, serverSettings);
        expect(lyricsCache.deleteCachedLyricsByKey).toHaveBeenCalled();
        expect(lyricsCache.clearAlbumPrefetchComplete).not.toHaveBeenCalled();
    });


    it('supports selectively unlocking a song while album lock is active', async () => {
        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();

        lyricsCache.hasLyricsLock.mockImplementation((lockType) => {
            if (lockType === 'album') return true;
            if (lockType === 'track') return false;
            if (lockType === 'album-track-unlock') return false;
            return false;
        });

        const result = await lyrics.controlLyricsForCurrentTrack('toggle-track-lock', io, deviceInfo, serverSettings);

        expect(result).toMatchObject({ ok: true, albumLocked: true, albumTrackUnlocked: true, trackLocked: false });
        expect(lyricsCache.setLyricsLock).toHaveBeenCalledWith('album-track-unlock', expect.any(String), true, serverSettings);
        expect(lyricsCache.deleteCachedLyricsByKey).toHaveBeenCalled();
        expect(lyricsCache.clearAlbumPrefetchComplete).toHaveBeenCalledWith(
            'beyond the black',
            'break the silence',
            serverSettings
        );
    });

    it('reports effective unlocked track state when album is locked with explicit track unlock', () => {
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();

        lyricsCache.hasLyricsLock.mockImplementation((lockType) => {
            if (lockType === 'album') return true;
            if (lockType === 'track') return false;
            if (lockType === 'album-track-unlock') return true;
            return false;
        });

        const result = lyrics.getLyricsControlStateForCurrentTrack(deviceInfo, serverSettings);
        expect(result).toMatchObject({ available: true, albumLocked: true, trackLocked: false, albumTrackUnlocked: true });
    });


    it('clears all per-track album unlock overrides when album lock is removed', async () => {
        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();
        serverSettings.features.lyrics.cache.enabled = true;
        serverSettings.features.lyrics.cache.maxSizeMB = 10;
        serverSettings.features.lyrics.cache.prefetch = 'album';

        lyricsCache.getCacheConfig.mockReturnValue({
            enabled: true,
            maxSizeBytes: 10 * 1024 * 1024,
            maxPrefetchConcurrency: 4,
            prefetch: 'album',
            path: '/tmp/test.sqlite'
        });

        let albumLocked = true;
        lyricsCache.setLyricsLock.mockImplementation((lockType, _key, locked) => {
            if (lockType === 'album') {
                albumLocked = locked;
            }
        });
        lyricsCache.hasLyricsLock.mockImplementation((lockType) => {
            if (lockType === 'album') return albumLocked;
            return false;
        });
        lyricsCache.hasAlbumPrefetchComplete.mockReturnValue(true);

        const result = await lyrics.controlLyricsForCurrentTrack('toggle-album-lock', io, deviceInfo, serverSettings);
        await new Promise((resolve) => setImmediate(resolve));

        expect(result).toMatchObject({ ok: true, albumLocked: false, prefetchTriggered: true });
        expect(lyricsCache.clearAlbumPrefetchComplete).not.toHaveBeenCalled();
        expect(lyricsCache.deleteCachedLyricsByArtistAlbumKey).toHaveBeenCalledWith(
            'Beyond The Black',
            'Break The Silence',
            serverSettings
        );
        expect(lyricsCache.deleteCachedLyricsByAlbumName).not.toHaveBeenCalled();
        expect(lyricsCache.deleteLyricsLocksByPrefix).toHaveBeenCalledWith(
            'album-track-unlock',
            expect.stringMatching(/\|\|$/),
            serverSettings
        );
        expect(lyricsCache.hasAlbumPrefetchComplete).toHaveBeenCalledWith(
            'beyond the black',
            'break the silence',
            serverSettings
        );
    });

    it('clears album prefetch completion when album lock is enabled', async () => {
        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();

        lyricsCache.hasLyricsLock.mockImplementation((lockType) => {
            if (lockType === 'album') return false;
            return false;
        });

        const result = await lyrics.controlLyricsForCurrentTrack('toggle-album-lock', io, deviceInfo, serverSettings);

        expect(result).toMatchObject({ ok: true, albumLocked: true });
        expect(lyricsCache.clearAlbumPrefetchComplete).toHaveBeenCalledWith(
            'beyond the black',
            'break the silence',
            serverSettings
        );
        expect(lyricsCache.deleteCachedLyricsByArtistAlbumKey).toHaveBeenCalledWith(
            'Beyond The Black',
            'Break The Silence',
            serverSettings
        );
        expect(lyricsCache.deleteCachedLyricsByAlbumName).not.toHaveBeenCalled();
    });



    it('normalizes album lock key so lock applies across album title variants', async () => {
        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo({
            albumName: 'Wildlive (Live at Olympiahalle)',
            artistName: 'Powerwolf',
            trackName: 'Dancing With the Dead',
            trackDuration: '00:04:11'
        });
        const serverSettings = buildServerSettings();

        lyricsCache.hasLyricsLock.mockImplementation(() => false);

        const result = await lyrics.controlLyricsForCurrentTrack('toggle-album-lock', io, deviceInfo, serverSettings);

        expect(result).toMatchObject({ ok: true, albumLocked: true });
        expect(lyricsCache.setLyricsLock).toHaveBeenCalledWith(
            'album',
            'wildlive at olympiahalle',
            true,
            serverSettings
        );
    });

    it('returns error when no alternative lyrics can be found', async () => {
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            res.statusCode = 404;
            process.nextTick(() => {
                cb(res);
                res.emit('end');
            });
            return {
                on: jest.fn()
            };
        });

        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo();
        const serverSettings = buildServerSettings();

        const result = await lyrics.controlLyricsForCurrentTrack('switch-alternative', io, deviceInfo, serverSettings);
        expect(result).toMatchObject({ ok: false, reason: 'no-alternative-match' });
    });
});


describe('lyrics.js synced lyrics preprocessing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('merges closely timed synced lyric lines for display', async () => {
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            const requestUrl = typeof url === 'string' ? url : '';
            let payload = '';

            if (requestUrl.includes('/api/search?')) {
                res.statusCode = 200;
                payload = JSON.stringify([
                    {
                        id: 200,
                        trackName: 'Motorbreath',
                        artistName: 'Metallica',
                        albumName: "Kill 'Em All",
                        duration: 188,
                        instrumental: false,
                        syncedLyrics: '[01:23.63]It is\n[01:24.37]Going to\n[01:25.17]Take your breath away\n'
                    }
                ]);
            } else {
                res.statusCode = 404;
            }

            process.nextTick(() => {
                cb(res);
                if (payload) {
                    res.emit('data', payload);
                }
                res.emit('end');
            });

            return {
                on: jest.fn()
            };
        });

        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo({
            trackName: 'Motorbreath',
            artistName: 'Metallica',
            albumName: "Kill 'Em All",
            trackDuration: '00:03:08'
        });
        const serverSettings = buildServerSettings();

        await lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings);

        expect(io.emit).toHaveBeenCalledWith('lyrics', expect.objectContaining({
            status: 'ok',
            syncedLyrics: '[01:23.63]It is. Going to\n[01:25.17]Take your breath away\n'
        }));
    });

    it('does not append a second dot when first lyric line already ends with dot', async () => {
        https.get.mockImplementation((url, options, cb) => {
            const res = new EventEmitter();
            const requestUrl = typeof url === 'string' ? url : '';
            let payload = '';

            if (requestUrl.includes('/api/search?')) {
                res.statusCode = 200;
                payload = JSON.stringify([
                    {
                        id: 201,
                        trackName: 'Motorbreath',
                        artistName: 'Metallica',
                        albumName: "Kill 'Em All",
                        duration: 188,
                        instrumental: false,
                        syncedLyrics: '[01:23.63]It is.\n[01:24.37]Going to\n[01:26.17]Take your breath away\n'
                    }
                ]);
            } else {
                res.statusCode = 404;
            }

            process.nextTick(() => {
                cb(res);
                if (payload) {
                    res.emit('data', payload);
                }
                res.emit('end');
            });

            return {
                on: jest.fn()
            };
        });

        const io = { emit: jest.fn() };
        const deviceInfo = buildDeviceInfo({
            trackName: 'Motorbreath',
            artistName: 'Metallica',
            albumName: "Kill 'Em All",
            trackDuration: '00:03:08'
        });
        const serverSettings = buildServerSettings();

        await lyrics.getLyricsForMetadata(io, deviceInfo, serverSettings);

        expect(io.emit).toHaveBeenCalledWith('lyrics', expect.objectContaining({
            status: 'ok',
            syncedLyrics: '[01:23.63]It is. Going to\n[01:26.17]Take your breath away\n'
        }));
    });
});

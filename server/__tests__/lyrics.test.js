const { EventEmitter } = require('events');

jest.mock('https');
jest.mock('../lib/lyricsCache.js', () => ({
    getCacheConfig: jest.fn(() => ({ enabled: false, maxSizeBytes: 0, path: '/tmp/test.sqlite' })),
    getCachedLyrics: jest.fn(() => ({ status: 'miss', durationMs: 0, cacheConfig: { enabled: false, maxSizeBytes: 0 } })),
    getCacheStats: jest.fn(() => ({ totalSize: 0 })),
    hasCachedLyrics: jest.fn(() => false),
    hasAlbumPrefetchComplete: jest.fn(() => false),
    markAlbumPrefetchComplete: jest.fn(),
    storeLyrics: jest.fn(() => ({ stored: false }))
}));
jest.mock('../lib/lyricsFailures.js', () => ({
    recordFailure: jest.fn(),
    deleteFailureBySignature: jest.fn()
}));

const https = require('https');
const lyrics = require('../lib/lyrics.js');
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

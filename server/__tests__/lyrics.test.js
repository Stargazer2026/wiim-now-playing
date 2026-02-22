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
    recordFailure: jest.fn()
}));

const https = require('https');
const lyrics = require('../lib/lyrics.js');
const lyricsFailures = require('../lib/lyricsFailures.js');

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
        const deviceInfo = {
            metadata: {
                trackMetaData: {
                    'dc:title': 'Rising High',
                    'upnp:artist': 'Beyond The Black',
                    'upnp:album': 'Break The Silence'
                },
                TrackDuration: '00:03:12',
                metadataTimeStamp: Date.now()
            },
            state: {
                stateTimeStamp: Date.now()
            },
            lyrics: null
        };
        const serverSettings = {
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
        };

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
});

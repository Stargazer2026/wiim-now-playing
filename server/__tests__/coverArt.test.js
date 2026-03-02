const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toContain('Line one');
        expect(snippet).toContain('Line four');
        expect(snippet).not.toContain('[00:00.00]');
        expect(snippet).not.toContain('#comment');
    });

    it('getSongKeyHash creates stable hash for metadata', () => {
        const metadata = {
            trackMetaData: {
                'upnp:artist': 'Muse',
                'upnp:album': 'Absolution',
                'dc:title': 'Time Is Running Out'
            }
        };
        const a = coverArt.getSongKeyHash(metadata);
        const b = coverArt.getSongKeyHash(metadata);
        expect(a).toBe(b);
        expect(typeof a).toBe('string');
        expect(a.length).toBe(16);
    });

    it('getHttpStatusCodeFromError parses HTTP errors', () => {
        expect(coverArt.getHttpStatusCodeFromError(new Error('HTTP 530'))).toBe(530);
        const errWithStatus = new Error('any');
        errWithStatus.statusCode = 530;
        expect(coverArt.getHttpStatusCodeFromError(errWithStatus)).toBe(530);
        expect(coverArt.getHttpStatusCodeFromError(new Error('Request timeout'))).toBeNull();
        expect(coverArt.getHttpStatusCodeFromError(null)).toBeNull();
    });

    it('extractOpenAiImage supports b64_json payloads', () => {
        const pngStubBase64 = Buffer.from('png-bytes').toString('base64');
        const parsed = coverArt.extractOpenAiImage({
            data: [{ b64_json: pngStubBase64 }]
        });

        expect(parsed.mode).toBe('inline');
        expect(Buffer.isBuffer(parsed.image.buffer)).toBe(true);
        expect(parsed.image.bytes).toBe(parsed.image.buffer.length);
        expect(parsed.image.contentType).toBe('image/png');
    });
});

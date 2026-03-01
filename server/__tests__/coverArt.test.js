const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
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
const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
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
const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
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
const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
    });

    it('getHttpStatusCodeFromError parses HTTP errors', () => {
        expect(coverArt.getHttpStatusCodeFromError(new Error('HTTP 530'))).toBe(530);
        const errWithStatus = new Error('any');
        errWithStatus.statusCode = 530;
        expect(coverArt.getHttpStatusCodeFromError(errWithStatus)).toBe(530);
        expect(coverArt.getHttpStatusCodeFromError(new Error('Request timeout'))).toBeNull();
        expect(coverArt.getHttpStatusCodeFromError(null)).toBeNull();
    });

});
const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
    });

    it('getHttpStatusCodeFromError parses HTTP errors', () => {
        expect(coverArt.getHttpStatusCodeFromError(new Error('HTTP 530'))).toBe(530);
        const errWithStatus = new Error('any');
        errWithStatus.statusCode = 530;
        expect(coverArt.getHttpStatusCodeFromError(errWithStatus)).toBe(530);
        expect(coverArt.getHttpStatusCodeFromError(new Error('Request timeout'))).toBeNull();
        expect(coverArt.getHttpStatusCodeFromError(null)).toBeNull();
    });

});
const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
    });

    it('getHttpStatusCodeFromError parses HTTP errors', () => {
        expect(coverArt.getHttpStatusCodeFromError(new Error('HTTP 530'))).toBe(530);
        expect(coverArt.getHttpStatusCodeFromError(new Error('Request timeout'))).toBeNull();
        expect(coverArt.getHttpStatusCodeFromError(null)).toBeNull();
    });

});
const coverArt = require('../lib/coverArt.js');

describe('coverArt helpers', () => {
    it('getLyricsSnippet strips timestamps and limits content', () => {
        const snippet = coverArt.getLyricsSnippet({
            syncedLyrics: '[00:00.00]Line one\n[00:01.00]Line two\n#comment\n[00:02.00]Line three\n[00:03.00]Line four\n[00:04.00]Line five'
        });

        expect(snippet).toBe('Line one Line two Line three Line four');
    });

    it('buildAIPrompt includes song metadata and lyrics context', () => {
        const prompt = coverArt.buildAIPrompt('Muse', 'Absolution', 'Time Is Running Out', {
            plainLyrics: 'I wanted freedom\nBound and restricted'
        });

        expect(prompt).toContain('"Time Is Running Out" by Muse');
        expect(prompt).toContain('from the album "Absolution"');
        expect(prompt).toContain('inspired by these lyrics: I wanted freedom Bound and restricted');
    });
});

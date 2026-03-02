const { getLyricsSnippet } = require('../lib/lyricsSnippet.js');

describe('lyricsSnippet util', () => {
    it('removes section headers and deduplicates lines', () => {
        const snippet = getLyricsSnippet({
            plainLyrics: 'Verse 1\nI run away\nI run away\n[Chorus]\nInto the night\n(Bridge)\nInto the night\nOutro:'
        });

        expect(snippet).toContain('I run away');
        expect(snippet).toContain('Into the night');
        expect(snippet).not.toContain('Verse 1');
        expect(snippet).not.toContain('Chorus');
    });

    it('masks explicit terms and applies char limit', () => {
        const line = 'fuck pussy dick tits cum';
        const snippet = getLyricsSnippet({
            plainLyrics: Array.from({ length: 30 }).map(() => line).join('\n')
        });

        expect(snippet).toContain('desire');
        expect(snippet).not.toContain('fuck');
        expect(snippet.length).toBeLessThanOrEqual(708);
    });
});

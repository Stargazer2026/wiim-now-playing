const { buildTrackKey, normalizeAlbum } = require('../lib/lyricsKeys.js');

describe('lyrics key normalization consistency', () => {
    it('normalizes common album title variants to a stable album key', () => {
        expect(normalizeAlbum('Wildlive (Live at Olympiahalle)')).toBe('wildlive at olympiahalle');
        expect(normalizeAlbum('Wildlive: Live at Olympiahalle')).toBe('wildlive at olympiahalle');
    });

    it('builds identical track key for equivalent album title variants', () => {
        const keyA = buildTrackKey('Dancing With the Dead', 'Powerwolf', 'Wildlive (Live at Olympiahalle)', 251);
        const keyB = buildTrackKey('Dancing With the Dead', 'Powerwolf', 'Wildlive: Live at Olympiahalle', 251);

        expect(keyA).toBe(keyB);
    });
});

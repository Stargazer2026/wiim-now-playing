const { validateConcept } = require('../lib/coverConceptService.js');

describe('cover concept validation', () => {
    it('accepts valid concept', () => {
        const concept = {
            version: 1,
            song: { artist: 'A', album: 'B', title: 'C' },
            variantIndex: 1,
            visualUniverse: 'symbolic_landscape_weather',
            mood: 'moody',
            themes: ['a', 'b', 'c'],
            symbols: ['x', 'y', 'z'],
            composition: 'center composition',
            colorLighting: 'cool dusk',
            avoid: ['text'],
            finalImagePrompt: 'full bleed square, no text',
            alternativePrompts: ['a', 'b']
        };

        expect(validateConcept(concept)).toBe(true);
    });

    it('rejects concept with missing fields', () => {
        expect(validateConcept({ version: 1 })).toBe(false);
    });
});

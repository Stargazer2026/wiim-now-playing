const https = require("https");

const { getLyricsSnippet } = require("./lyricsSnippet.js");

const OPENAI_CHAT_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_API_TIMEOUT_MS = Math.max(30000, Number(process.env.OPENAI_API_TIMEOUT_MS) || 180000);

const ALLOWED_VISUAL_UNIVERSES = [
    "black_and_white_editorial_photo",
    "cinematic_color_photo",
    "graphic_novel_panel",
    "minimalist_bauhaus_geometric",
    "retro_screenprint_poster",
    "risograph_zine",
    "paper_cutout_collage",
    "photomontage_collage",
    "street_art_graffiti",
    "architectural_minimalism",
    "symbolic_landscape_weather",
    "surreal_object_tableau",
    "abstract_energy_field",
    "claymation_3d_diorama",
    "technical_blueprint_style"
];

const conceptOutputJsonSchema = {
    name: "cover_concept",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["version", "song", "variantIndex", "visualUniverse", "mood", "themes", "symbols", "composition", "colorLighting", "avoid", "finalImagePrompt", "alternativePrompts"],
        properties: {
            version: { type: "number" },
            song: {
                type: "object",
                additionalProperties: false,
                required: ["artist", "album", "title"],
                properties: {
                    artist: { type: "string" },
                    album: { type: ["string", "null"] },
                    title: { type: "string" }
                }
            },
            variantIndex: { type: "number" },
            visualUniverse: { type: "string", enum: ALLOWED_VISUAL_UNIVERSES },
            mood: { type: "string" },
            themes: { type: "array", minItems: 3, maxItems: 7, items: { type: "string" } },
            symbols: { type: "array", minItems: 3, maxItems: 7, items: { type: "string" } },
            composition: { type: "string" },
            colorLighting: { type: "string" },
            avoid: { type: "array", items: { type: "string" } },
            finalImagePrompt: { type: "string" },
            alternativePrompts: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } }
        }
    }
};

const SYSTEM_PROMPT = [
    "You are an art director creating safe, high-quality album cover prompts.",
    "Output JSON only and follow the provided schema exactly.",
    "Allowed visual universes:",
    ...ALLOWED_VISUAL_UNIVERSES.map((v) => `- ${v}`),
    "Hard rules for every finalImagePrompt and alternativePrompts:",
    "- full bleed square cover image",
    "- no mockup, no frame, no wall, no room, no poster in environment",
    "- no text, no logos, no watermark, no artist/band names in image",
    "- family friendly, no nudity, no sexual content, no fetish, no suggestive poses",
    "- no violence, no gore, nothing disturbing",
    "- interpret lyrics metaphorically, prefer symbolic/object/landscape/architecture/abstract compositions",
    "- humans/faces are not default; if used then silhouettes, hands or rear view only, fully clothed, no close portraits",
    "Deliver 1 primary prompt and 2-4 alternatives.",
    "Keep prompts concise but specific, in english language."
].join("\n");

const postJson = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(new URL(url), {
        method: "POST",
        timeout: OPENAI_API_TIMEOUT_MS,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...headers
        }
    }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
            data += chunk;
        });
        res.on("end", () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                const error = new Error(`HTTP ${res.statusCode}`);
                error.statusCode = res.statusCode;
                error.bodyPreview = data.replace(/\s+/g, " ").slice(0, 500);
                reject(error);
                return;
            }
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                reject(error);
            }
        });
    });
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
});

const validateConcept = (concept) => {
    if (!concept || typeof concept !== "object") {
        return false;
    }
    if (concept.version !== 1) {
        return false;
    }
    if (!ALLOWED_VISUAL_UNIVERSES.includes(concept.visualUniverse)) {
        return false;
    }
    if (!Array.isArray(concept.themes) || concept.themes.length < 3 || concept.themes.length > 7) {
        return false;
    }
    if (!Array.isArray(concept.symbols) || concept.symbols.length < 3 || concept.symbols.length > 7) {
        return false;
    }
    if (!Array.isArray(concept.alternativePrompts) || concept.alternativePrompts.length < 2 || concept.alternativePrompts.length > 4) {
        return false;
    }
    if (typeof concept.finalImagePrompt !== "string" || !concept.finalImagePrompt.trim()) {
        return false;
    }
    return true;
};

const buildFallbackConcept = ({ artist, album, title, variantIndex }) => {
    const prompt = `Square full-bleed album cover, symbolic_landscape_weather, cinematic but calm, metaphorical weather and horizon motifs representing \"${title}\" by ${artist}, no mockup, no frame, no wall, no room, no text, no logo, no watermark, family-friendly, no nudity, no violence.`;
    return {
        version: 1,
        song: { artist, album: album || null, title },
        variantIndex,
        visualUniverse: "symbolic_landscape_weather",
        mood: "atmospheric",
        themes: ["emotion", "journey", "contrast"],
        symbols: ["sky", "horizon", "light"],
        composition: "clean central depth with layered foreground and background",
        colorLighting: "moody gradient light with restrained highlights",
        avoid: ["text", "logos", "mockup context"],
        finalImagePrompt: prompt,
        alternativePrompts: [prompt, prompt]
    };
};

const generateCoverConcept = async ({ artist, album, title, lyricsPayload, variantIndex, conceptSeed = null, previousPrompts = [] }) => {
    const lyricsSnippet = getLyricsSnippet(lyricsPayload);
    const variantInstruction = variantIndex > 0
        ? "This is a regenerate request. Produce a distinctly different concept and different visualUniverse than earlier variants if possible while staying semantically accurate."
        : "Variant 0: choose the best-fit concept for this song.";

    const userPayload = {
        song: { artist, album: album || null, title },
        variantIndex,
        conceptSeed,
        variantInstruction,
        previousPrompts,
        lyricsSnippet
    };
    const model = process.env.OPENAI_CONCEPT_MODEL || "gpt-4.1-mini";
    const chatRequestPayload = {
        model,
        temperature: 1,
        response_format: {
            type: "json_schema",
            json_schema: conceptOutputJsonSchema
        },
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(userPayload) }
        ]
    };
    const conceptInputText = JSON.stringify(chatRequestPayload, null, 2);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const fallbackConcept = buildFallbackConcept({ artist, album, title, variantIndex });
        return {
            concept: fallbackConcept,
            alternatives: [],
            debug: {
                fallback: true,
                reason: "missing_api_key",
                conceptInputText,
                conceptOutputText: JSON.stringify(fallbackConcept, null, 2)
            }
        };
    }

    try {
        const response = await postJson(OPENAI_CHAT_API_URL, chatRequestPayload, {
            Authorization: `Bearer ${apiKey}`
        });

        const content = response?.choices?.[0]?.message?.content;
        const parsed = JSON.parse(content);
        if (!validateConcept(parsed)) {
            throw new Error("Invalid concept payload");
        }

        return {
            concept: parsed,
            alternatives: parsed.alternativePrompts,
            debug: {
                visualUniverse: parsed.visualUniverse,
                variantIndex: parsed.variantIndex,
                promptPreview: parsed.finalImagePrompt.slice(0, 200),
                conceptInputText,
                conceptOutputText: content
            }
        };
    } catch (error) {
        const fallbackConcept = buildFallbackConcept({ artist, album, title, variantIndex });
        return {
            concept: fallbackConcept,
            alternatives: [],
            debug: {
                fallback: true,
                reason: error.message,
                conceptInputText,
                conceptOutputText: JSON.stringify(fallbackConcept, null, 2)
            }
        };
    }
};

module.exports = {
    ALLOWED_VISUAL_UNIVERSES,
    conceptOutputJsonSchema,
    validateConcept,
    generateCoverConcept
};

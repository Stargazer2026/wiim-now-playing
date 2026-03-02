const sanitize = (value) => (typeof value === "string" ? value.trim() : "");

const EXPLICIT_REPLACEMENTS = [
    { pattern: /\bfuck(?:ing|ed|s)?\b/gi, replacement: "desire" },
    { pattern: /\bpussy\b/gi, replacement: "intimacy" },
    { pattern: /\bdick\b/gi, replacement: "rush" },
    { pattern: /\btits?\b/gi, replacement: "love" },
    { pattern: /\bcum(?:ming)?\b/gi, replacement: "whisper" },
    { pattern: /\bblowjob\b/gi, replacement: "tenderness" }
];

const SECTION_LINE_REGEX = /^(\[(?:verse|chorus|bridge|intro|outro|pre-chorus|hook)[^\]]*\]|\((?:verse|chorus|bridge|intro|outro|pre-chorus|hook)[^)]+\)|(?:verse|chorus|bridge|intro|outro|pre-chorus|hook)\s*:?\s*\d*)$/i;

const normalizeLine = (line) => line
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^\(([^)]+)\)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

const collectLyricsSource = (lyricsPayload) => {
    if (!lyricsPayload) {
        return "";
    }
    if (typeof lyricsPayload === "string") {
        return lyricsPayload;
    }
    if (typeof lyricsPayload !== "object") {
        return "";
    }
    const candidates = [
        lyricsPayload.plainLyrics,
        lyricsPayload.syncedLyrics,
        lyricsPayload.lyrics,
        lyricsPayload.text,
        lyricsPayload.content,
        lyricsPayload.data && lyricsPayload.data.lyrics,
        lyricsPayload.result && lyricsPayload.result.lyrics
    ];

    for (const item of candidates) {
        if (typeof item === "string" && item.trim()) {
            return item;
        }
    }

    return "";
};

const applyFamilyFriendlyMasking = (text) => {
    let output = text;
    EXPLICIT_REPLACEMENTS.forEach(({ pattern, replacement }) => {
        output = output.replace(pattern, replacement);
    });
    return output;
};

const getLyricsSnippet = (lyricsPayload) => {
    const source = collectLyricsSource(lyricsPayload);
    if (!source) {
        return "";
    }

    const seen = new Set();
    const lines = source.split(/\r?\n/)
        .map(normalizeLine)
        .filter((line) => line && !line.startsWith("#") && !SECTION_LINE_REGEX.test(line))
        .filter((line) => {
            const key = line.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });

    if (!lines.length) {
        return "";
    }

    const picked = [];
    const pushLine = (index) => {
        if (index >= 0 && index < lines.length) {
            const line = lines[index];
            if (!picked.includes(line)) {
                picked.push(line);
            }
        }
    };

    const maxLines = Math.min(10, lines.length);
    for (let i = 0; i < Math.ceil(maxLines / 3); i++) pushLine(i);
    for (let i = Math.floor(lines.length / 2); picked.length < Math.ceil((maxLines * 2) / 3) && i < lines.length; i++) pushLine(i);
    for (let i = Math.max(0, lines.length - maxLines); picked.length < maxLines && i < lines.length; i++) pushLine(i);

    const merged = applyFamilyFriendlyMasking(picked.join("\n")).slice(0, 700);
    return merged ? `"""\n${merged}\n"""` : "";
};

module.exports = {
    getLyricsSnippet
};

const Analyze = {
    r: {
        failuresContainer: null,
        btnReload: null,
        failureLimit: null,
        entryCounter: null
    }
};

Analyze.init = function () {
    this.r.failuresContainer = document.getElementById("failuresContainer");
    this.r.btnReload = document.getElementById("btnReload");
    this.r.failureLimit = document.getElementById("failureLimit");
    this.r.entryCounter = document.getElementById("entryCounter");

    this.r.btnReload.addEventListener("click", () => this.loadFailures());
    this.r.failureLimit.addEventListener("change", () => this.loadFailures());

    this.loadFailures();
};

Analyze.escapeHtml = function (value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

Analyze.formatTime = function (timestamp) {
    if (!timestamp) {
        return "-";
    }
    return new Date(timestamp).toLocaleString("en-GB", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
};

Analyze.renderFailure = function (entry) {
    const queryString = entry.queryString || "-";
    const requests = Array.isArray(entry.requests) ? entry.requests : [];

    const requestList = requests.map((request) => {
        const response = request && request.response !== undefined
            ? JSON.stringify(request.response, null, 2)
            : "null";
        return `
            <div class="request-entry border rounded p-2 mb-2">
                <div><strong>Endpoint:</strong> ${this.escapeHtml(request.endpoint || "-")}</div>
                <div><strong>Path:</strong> <code>${this.escapeHtml(request.path || "-")}</code></div>
                <div><strong>Duration:</strong> ${this.escapeHtml(request.durationMs)} ms</div>
                <div><strong>Result:</strong> ${this.escapeHtml(request.result || "-")}</div>
                ${request.error ? `<div><strong>Error:</strong> ${this.escapeHtml(request.error)}</div>` : ""}
                <details class="mt-2">
                    <summary>Response JSON</summary>
                    <pre class="mb-0 mt-1">${this.escapeHtml(response)}</pre>
                </details>
            </div>
        `;
    }).join("");

    return `
        <article class="card shadow-sm failure-entry">
            <details class="failure-toggle">
                <summary class="card-body">
                    <h2 class="h5 mb-1">${this.escapeHtml(entry.wiimArtistName)} — ${this.escapeHtml(entry.wiimTrackName)} (${this.escapeHtml(entry.wiimAlbumName)})</h2>
                    <div class="small text-muted mb-0">${this.formatTime(entry.failedAt)} · Reason: ${this.escapeHtml(entry.reason || "-")}</div>
                </summary>

                <div class="card-body pt-0">
                    <div class="mb-2"><strong>Requested query string:</strong></div>
                    <pre class="query-string">${this.escapeHtml(queryString)}</pre>

                    <div class="row g-3 mt-1">
                        <div class="col-md-6">
                            <div class="small text-muted mb-1">WiiM raw values</div>
                            <ul class="list-group list-group-flush border rounded">
                                <li class="list-group-item"><strong>Artist:</strong> ${this.escapeHtml(entry.wiimArtistName)}</li>
                                <li class="list-group-item"><strong>Track:</strong> ${this.escapeHtml(entry.wiimTrackName)}</li>
                                <li class="list-group-item"><strong>Album:</strong> ${this.escapeHtml(entry.wiimAlbumName)}</li>
                                <li class="list-group-item"><strong>Duration:</strong> ${this.escapeHtml(entry.wiimDuration)}</li>
                            </ul>
                        </div>
                        <div class="col-md-6">
                            <div class="small text-muted mb-1">Normalized values (LRCLIB query basis)</div>
                            <ul class="list-group list-group-flush border rounded">
                                <li class="list-group-item"><strong>Artist:</strong> ${this.escapeHtml(entry.normalizedArtistName)}</li>
                                <li class="list-group-item"><strong>Track:</strong> ${this.escapeHtml(entry.normalizedTrackName)}</li>
                                <li class="list-group-item"><strong>Album:</strong> ${this.escapeHtml(entry.normalizedAlbumName)}</li>
                            </ul>
                        </div>
                    </div>

                    <div class="mt-3">
                        <h3 class="h6">LRCLIB endpoint responses</h3>
                        ${requestList || "<div class='text-muted'>No request data available.</div>"}
                    </div>
                </div>
            </details>
        </article>
    `;
};

Analyze.loadFailures = async function () {
    const limit = this.r.failureLimit.value || "250";
    this.r.failuresContainer.innerHTML = '<div class="text-muted">Loading…</div>';

    try {
        const response = await fetch(`/api/lyrics-failures?limit=${encodeURIComponent(limit)}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const entries = Array.isArray(payload.entries) ? payload.entries : [];

        this.r.entryCounter.textContent = `${entries.length} entries`;

        if (!entries.length) {
            this.r.failuresContainer.innerHTML = '<div class="alert alert-light border">No failed lyrics lookups found.</div>';
            return;
        }

        this.r.failuresContainer.innerHTML = entries.map((entry) => this.renderFailure(entry)).join("");
    } catch (error) {
        this.r.failuresContainer.innerHTML = `<div class="alert alert-danger">Failed to load: ${this.escapeHtml(error.message)}</div>`;
    }
};

document.addEventListener("DOMContentLoaded", () => Analyze.init());

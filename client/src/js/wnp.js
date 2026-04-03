// =======================================================
// WiiM Now Playing

// Namespacing
window.WNP = window.WNP || {};

// Default settings
WNP.s = {
    // Host runs on default port 80, but in cases where another port is chosen adapt
    locHostname: location.hostname,
    locPort: (location.port && location.port != "80" && location.port != "1234") ? location.port : "80",
    rndAlbumArtUri: "./img/fake-album-1.jpg",
    // Device selection
    aDeviceUI: ["wnpApp", "btnPrev", "btnPlay", "btnNext", "btnRefresh", "selDeviceChoices", "devName", "devNameHolder", "mediaTitle", "mediaSubTitle", "mediaArtist", "mediaAlbum", "mediaBitRate", "mediaBitDepth", "mediaSampleRate", "mediaQualityIdent", "devVol", "btnRepeat", "btnShuffle", "progressPlayed", "progressLeft", "progressPercent", "mediaSource", "albumArt", "bgAlbumArtBlur", "btnDevSelect", "oDeviceList", "btnDevPreset", "oPresetList", "btnDevVolume", "rVolume", "lyricsContainer", "lyricsPrev", "lyricsCurrent", "lyricsNext", "btnLyricsLockTrack", "btnLyricsLockAlbum", "btnLyricsSwitchAlternative", "lyricsUnlockActions", "btnLyricsUnlockTrackQuick", "btnLyricsUnlockAlbumQuick", "mediaTitleArtist", "mediaTitleCompact", "mediaArtistCompact", "mediaAlbumQuality", "mediaAlbumCompact", "mediaQualityCompact", "mediaSourceCompact", "mediaSourceFooter", "btnSleepTimer", "sleepTimerModal", "sleepTimerMinutes", "btnSleepTimerApplyCustom", "sleepTimerOverlay"],
    // Server actions to be used in the app
    aServerUI: [
        "btnReboot",
        "btnUpdate",
        "btnShutdown",
        "btnReloadUI",
        "sServerUrlHostname",
        "sServerUrlIP",
        "sServerVersion",
        "sClientVersion",
        "chkLyricsEnabled",
        "lyricsOffsetMs",
        "chkLyricsInsertBlankLineForLongGaps",
        "lyricsMediumGapSec",
        "lyricsLongGapSec",
        "chkLyricsCacheEnabled",
        "lyricsCacheSizeMB",
        "lyricsPrefetchMode",
        "chkCoverArtEnabled",
        "selCoverArtProvider",
        "coverArtMemoryPoolMB",
        "chkWledEnabled",
        "btnWledQuickToggle",
        "wledHost",
        "wledPreset",
        "wledPausePreset",
        "wledOffDelaySec",
        "wledToggleUrl",
        "voicePresetId",
        "defaultPresetId",
        "voicePresetLookupEnabled",
        "kioskHost",
        "kioskPassword",
        "kioskDelaySec"
    ],
};

// Data placeholders.
WNP.d = {
    serverSettings: null, // Server settings, used to store the server settings
    deviceList: null, // Device list, used to store the devices found through SSDP
    prevTransportState: null, // Previous transport state, used to detect changes in the transport state
    prevPlayMedium: null, // Previous play medium, used to detect changes in the play medium
    prevSourceIdent: null, // Previous source ident, used to detect changes in the source
    prevTrackInfo: null, // Previous track info, used to detect changes in the metadata
    lastState: null, // Last known state, used for lyrics timing
    lyrics: null, // Current lyrics payload
    lyricsIndex: null, // Current lyrics line index
    lyricsLines: [], // Parsed lyrics lines
    lyricsLongGapContextIndex: null, // Current long-gap context index
    lyricsTransitionTimer: null, // Single timer for all three lyrics lines
    lyricsCookieApplied: false, // Track if cookie setting has been applied
    currentLyricsTrackKey: null,
    currentTrackMetadataTimeStamp: null,
    currentTrackDurationSec: null,
    pendingLyricsLines: [],
    pendingLyricsTrackKey: null,
    waitingForSongStart: false,
    recentSongSwitchAtMs: null,
    currentTrackKey: null,
    currentTrackCoverLocked: false,
    pendingTrackCoverUri: null,
    pendingTrackCoverSource: null,
    currentTrackCoverSource: null,
    currentTrackFailedCoverUri: null,
    lyricsControlState: null,
    sleepTimerState: {
        active: false,
        mode: null,
        targetTimeStamp: null,
        durationMinutes: null
    }
};

// Reference placeholders.
// These are set in the init function
// and are used to reference the UI elements in the app.
WNP.r = {};

/**
 * Initialisation of app.
 * @returns {undefined}
 */
WNP.Init = function () {
    console.log("WNP", "Initialising...");

    // Init Socket.IO, connect to port where server resides
    console.log("WNP", "Listening on " + this.s.locHostname + ":" + this.s.locPort)
    window.socket = io.connect(":" + this.s.locPort);

    // Set references to the UI elements
    this.setUIReferences();

    // Set Socket.IO definitions
    this.setSocketDefinitions();

    // Set UI event listeners
    this.setUIListeners();

    // Initial calls, wait a bit for socket to start
    setTimeout(() => {
        // Get server settings
        socket.emit("server-settings");
        socket.emit("sleep-timer-status");
        // Get devices
        socket.emit("devices-get");
    }, 500);

    // Create random album intervals, every 3 minutes
    WNP.s.rndAlbumArtUri = WNP.rndAlbumArt("fake-album-");
    var rndAlbumInterval = setInterval(function () {
        WNP.s.rndAlbumArtUri = WNP.rndAlbumArt("fake-album-");
    }, 3 * 60 * 1000);

    setInterval(() => {
        WNP.updateSleepTimerButton();
    }, 1000);

};

/**
 * Reference to the UI elements of the app.
 * @returns {undefined}
 */
WNP.setUIReferences = function () {
    console.log("WNP", "Set UI references...")

    function addElementToRef(id) {
        const element = document.getElementById(id);
        if (element) {
            WNP.r[id] = element;
        } else {
            console.log("WNP", `Element with ID '${id}' not found in current HTML.`);
        }
    }

    // Set references to the UI elements
    this.s.aDeviceUI.forEach((id) => { addElementToRef(id); });
    this.s.aServerUI.forEach((id) => { addElementToRef(id); });

};

/**
 * Setting the listeners on the UI elements of the app.
 * @returns {undefined}
 */
WNP.emitWledSettingsUpdate = function (changes) {
    socket.emit("server-settings-update", {
        features: {
            wled: changes
        }
    });
};

WNP.emitVoicePresetSettingsUpdate = function (changes) {
    socket.emit("server-settings-update", {
        features: {
            voicePreset: changes
        }
    });
};

WNP.setWledQuickToggleState = function (enabled) {
    if (!WNP.r.btnWledQuickToggle) {
        return;
    }
    var isEnabled = Boolean(enabled);
    WNP.r.btnWledQuickToggle.classList.toggle("is-on", isEnabled);
    WNP.r.btnWledQuickToggle.setAttribute("aria-pressed", isEnabled ? "true" : "false");
    WNP.r.btnWledQuickToggle.title = isEnabled ? "Disable WLED integration" : "Enable WLED integration";
    var iconEl = WNP.r.btnWledQuickToggle.querySelector("i");
    if (iconEl) {
        iconEl.classList.toggle("bi-lightbulb-fill", isEnabled);
        iconEl.classList.toggle("bi-lightbulb", !isEnabled);
    }
};

WNP.setUIListeners = function () {
    console.log("WNP", "Set UI Listeners...")

    // ------------------------------------------------
    // Player buttons

    // Previous button
    this.r.btnPrev.addEventListener("click", function () {
        var wnpAction = this.getAttribute("wnp-action");
        if (wnpAction) {
            this.disabled = true;
            socket.emit("device-action", wnpAction);
        }
    });

    // Play/Pause/Stop button
    this.r.btnPlay.addEventListener("click", function () {
        var wnpAction = this.getAttribute("wnp-action");
        if (wnpAction) {
            this.disabled = true;
            socket.emit("device-action", wnpAction);
        }
    });

    // Next button
    this.r.btnNext.addEventListener("click", function () {
        var wnpAction = this.getAttribute("wnp-action");
        if (wnpAction) {
            this.disabled = true;
            socket.emit("device-action", wnpAction);
        }
    });

    // ------------------------------------------------
    // Device control inputs (only for default GUI, not TV mode)

    // Device select button
    if (this.r.btnDevPreset) {
        this.r.btnDevPreset.addEventListener("click", function () {
            socket.emit("device-api", "getPresetInfo");
        });
    }

    // Device volume range input
    if (this.r.rVolume) {
        this.r.rVolume.addEventListener('input', function () {
            if (!isNaN(this.value) && this.value >= 0 && this.value <= 100) {
                socket.emit("device-api", "setPlayerCmd:vol:" + this.value);
            }
        });
    }

    // ------------------------------------------------
    // Settings buttons

    // Device selection dropdown
    this.r.selDeviceChoices.addEventListener("change", function () {
        socket.emit("device-set", this.value);
    });

    // Refresh devices button
    this.r.btnRefresh.addEventListener("click", function () {
        socket.emit("devices-refresh");
        // Wait for discovery to finish
        setTimeout(() => {
            socket.emit("devices-get");
            socket.emit("server-settings");
        }, 5000);
    });

    // Reboot button
    this.r.btnReboot.addEventListener("click", function () {
        socket.emit("server-reboot");
    });

    // Update button
    this.r.btnUpdate.addEventListener("click", function () {
        socket.emit("server-update");
    });

    // Shutdown button
    this.r.btnShutdown.addEventListener("click", function () {
        socket.emit("server-shutdown");
    });

    // Reload UI button
    this.r.btnReloadUI.addEventListener("click", function () {
        location.reload();
    });

    // Lyrics toggle
    if (this.r.chkLyricsEnabled) {
        this.r.chkLyricsEnabled.addEventListener("change", function () {
            WNP.setCookie("wnpLyricsEnabled", this.checked, 180);
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        enabled: this.checked
                    }
                }
            });
        });
    }

    if (this.r.lyricsOffsetMs) {
        this.r.lyricsOffsetMs.addEventListener("change", function () {
            var offsetValue = parseInt(this.value, 10);
            if (isNaN(offsetValue)) {
                offsetValue = 0;
            }
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        offsetMs: offsetValue
                    }
                }
            });
        });
    }

    if (this.r.chkLyricsInsertBlankLineForLongGaps) {
        this.r.chkLyricsInsertBlankLineForLongGaps.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        insertBlankLineForLongGaps: this.checked
                    }
                }
            });
        });
    }

    if (this.r.lyricsMediumGapSec) {
        this.r.lyricsMediumGapSec.addEventListener("change", function () {
            var mediumGapSec = parseInt(this.value, 10);
            if (isNaN(mediumGapSec) || mediumGapSec < 10) {
                mediumGapSec = 10;
            }
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        mediumGapSec: mediumGapSec
                    }
                }
            });
        });
    }

    if (this.r.lyricsLongGapSec) {
        this.r.lyricsLongGapSec.addEventListener("change", function () {
            var longGapSec = parseInt(this.value, 10);
            if (isNaN(longGapSec) || longGapSec < 16) {
                longGapSec = 16;
            }
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        longGapSec: longGapSec
                    }
                }
            });
        });
    }

    if (this.r.chkLyricsCacheEnabled) {
        this.r.chkLyricsCacheEnabled.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        cache: {
                            enabled: this.checked
                        }
                    }
                }
            });
        });
    }

    if (this.r.lyricsCacheSizeMB) {
        this.r.lyricsCacheSizeMB.addEventListener("change", function () {
            var sizeValue = parseInt(this.value, 10);
            if (isNaN(sizeValue) || sizeValue < 0) {
                sizeValue = 0;
            }
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        cache: {
                            maxSizeMB: sizeValue
                        }
                    }
                }
            });
        });
    }

    if (this.r.lyricsPrefetchMode) {
        this.r.lyricsPrefetchMode.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                features: {
                    lyrics: {
                        cache: {
                            prefetch: this.value
                        }
                    }
                }
            });
        });
    }

    if (this.r.chkCoverArtEnabled) {
        this.r.chkCoverArtEnabled.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                features: {
                    coverArt: {
                        enabled: this.checked
                    }
                }
            });
        });
    }

    if (this.r.selCoverArtProvider) {
        this.r.selCoverArtProvider.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                features: {
                    coverArt: {
                        provider: this.value
                    }
                }
            });
        });
    }

    if (this.r.coverArtMemoryPoolMB) {
        this.r.coverArtMemoryPoolMB.addEventListener("change", function () {
            var poolValue = parseInt(this.value, 10);
            if (isNaN(poolValue) || poolValue < 1) {
                poolValue = 1;
            }
            socket.emit("server-settings-update", {
                features: {
                    coverArt: {
                        memoryPoolMB: poolValue
                    }
                }
            });
        });
    }

    if (this.r.chkWledEnabled) {
        this.r.chkWledEnabled.addEventListener("change", function () {
            WNP.setWledQuickToggleState(this.checked);
            WNP.emitWledSettingsUpdate({
                enabled: this.checked
            });
        });
    }

    if (this.r.btnWledQuickToggle) {
        this.r.btnWledQuickToggle.addEventListener("click", function () {
            var nextEnabled = !this.classList.contains("is-on");
            if (WNP.r.chkWledEnabled) {
                WNP.r.chkWledEnabled.checked = nextEnabled;
            }
            WNP.setWledQuickToggleState(nextEnabled);
            WNP.emitWledSettingsUpdate({
                enabled: nextEnabled
            });
        });
    }

    if (this.r.wledHost) {
        this.r.wledHost.addEventListener("change", function () {
            WNP.emitWledSettingsUpdate({
                host: this.value.trim()
            });
        });
    }

    if (this.r.wledPreset) {
        this.r.wledPreset.addEventListener("change", function () {
            var presetValue = parseInt(this.value, 10);
            if (isNaN(presetValue) || presetValue < 0) {
                presetValue = 0;
            }
            WNP.emitWledSettingsUpdate({
                playbackPreset: presetValue
            });
        });
    }

    if (this.r.wledPausePreset) {
        this.r.wledPausePreset.addEventListener("change", function () {
            var presetValue = parseInt(this.value, 10);
            if (isNaN(presetValue) || presetValue < 0) {
                presetValue = 0;
            }
            WNP.emitWledSettingsUpdate({
                pausePreset: presetValue
            });
        });
    }

    if (this.r.wledOffDelaySec) {
        this.r.wledOffDelaySec.addEventListener("change", function () {
            var delayValue = parseInt(this.value, 10);
            if (isNaN(delayValue) || delayValue < 0) {
                delayValue = 0;
            }
            WNP.emitWledSettingsUpdate({
                offDelaySec: delayValue
            });
        });
    }

    if (this.r.voicePresetId) {
        this.r.voicePresetId.addEventListener("change", function () {
            var presetValue = parseInt(this.value, 10);
            if (isNaN(presetValue) || presetValue < 0) {
                presetValue = 0;
            }
            WNP.emitVoicePresetSettingsUpdate({
                voicePresetId: presetValue
            });
        });
    }

    if (this.r.defaultPresetId) {
        this.r.defaultPresetId.addEventListener("change", function () {
            var presetValue = parseInt(this.value, 10);
            if (isNaN(presetValue) || presetValue < 0) {
                presetValue = 0;
            }
            WNP.emitVoicePresetSettingsUpdate({
                defaultPresetId: presetValue
            });
        });
    }
    if (this.r.voicePresetLookupEnabled) {
        this.r.voicePresetLookupEnabled.addEventListener("change", function () {
            WNP.emitVoicePresetSettingsUpdate({
                lookupEnabled: this.checked
            });
        });
    }

    if (this.r.kioskHost) {
        this.r.kioskHost.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                kiosk: {
                    host: this.value
                }
            });
        });
    }

    if (this.r.kioskPassword) {
        this.r.kioskPassword.addEventListener("change", function () {
            socket.emit("server-settings-update", {
                kiosk: {
                    password: this.value
                }
            });
        });
    }

    if (this.r.kioskDelaySec) {
        this.r.kioskDelaySec.addEventListener("change", function () {
            var delayValue = parseInt(this.value, 10);
            if (isNaN(delayValue) || delayValue < 0) {
                delayValue = 0;
            }
            socket.emit("server-settings-update", {
                kiosk: {
                    screenOffDelaySec: delayValue
                }
            });
        });
    }

    if (this.r.albumArt) {
        // Avoid double error handlers (inline HTML onerror + JS listener) that can race each other
        // and prevent failed URI tracking from stabilizing.
        this.r.albumArt.removeAttribute("onerror");

        this.r.albumArt.addEventListener("load", function () {
            var albumArtContainer = this.parentElement;
            if (albumArtContainer && this.naturalWidth && this.naturalHeight) {
                albumArtContainer.style.setProperty("--album-art-ratio", this.naturalWidth + " / " + this.naturalHeight);
            }

            if (!WNP.d.pendingTrackCoverUri) {
                return;
            }
            if (WNP.normalizeCoverUri(this.src) === WNP.d.pendingTrackCoverUri) {
                WNP.d.currentTrackCoverLocked = true;
                WNP.d.currentTrackCoverSource = WNP.d.pendingTrackCoverSource || null;
                WNP.d.pendingTrackCoverUri = null;
                WNP.d.pendingTrackCoverSource = null;
            }

        });

        this.r.albumArt.addEventListener("error", function () {
            var albumArtContainer = this.parentElement;
            if (albumArtContainer) {
                albumArtContainer.style.removeProperty("--album-art-ratio");
            }

            if (WNP.d.pendingTrackCoverUri && WNP.normalizeCoverUri(this.src) === WNP.d.pendingTrackCoverUri) {
                // Prevent retry loops for the same failing URI on every metadata poll.
                WNP.d.currentTrackCoverLocked = false;
                WNP.d.currentTrackFailedCoverUri = WNP.d.pendingTrackCoverUri;
                WNP.logCover("error->mark-failed", {
                    src: this.src,
                    failedUri: WNP.d.currentTrackFailedCoverUri,
                    pendingSource: WNP.d.pendingTrackCoverSource,
                    trackKey: WNP.d.currentTrackKey
                });
                WNP.d.pendingTrackCoverUri = null;
                WNP.d.pendingTrackCoverSource = null;
            }

            // Show a stable local fallback when any cover fails.
            if (WNP.normalizeCoverUri(this.src) !== WNP.normalizeCoverUri(WNP.s.rndAlbumArtUri)) {
                WNP.setAlbumArt(WNP.s.rndAlbumArtUri);
            }

        });
    }

    if (this.r.btnLyricsLockTrack) {
        this.r.btnLyricsLockTrack.addEventListener("click", function () {
            WNP.runLyricsControlAction("toggle-track-lock");
        });
    }
    if (this.r.btnLyricsLockAlbum) {
        this.r.btnLyricsLockAlbum.addEventListener("click", function () {
            WNP.runLyricsControlAction("toggle-album-lock");
        });
    }
    if (this.r.btnLyricsSwitchAlternative) {
        this.r.btnLyricsSwitchAlternative.addEventListener("click", function () {
            WNP.runLyricsControlAction("switch-alternative");
        });
    }

    if (this.r.btnLyricsUnlockTrackQuick) {
        this.r.btnLyricsUnlockTrackQuick.addEventListener("click", function () {
            WNP.runLyricsControlAction("toggle-track-lock");
        });
    }

    if (this.r.btnLyricsUnlockAlbumQuick) {
        this.r.btnLyricsUnlockAlbumQuick.addEventListener("click", function () {
            WNP.runLyricsControlAction("toggle-album-lock");
        });
    }

    if (this.r.btnSleepTimer) {
        const cancelSleepTimerFromButton = function (evt) {
            const isActive = Boolean(
                (WNP.d.sleepTimerState && WNP.d.sleepTimerState.active)
                || WNP.r.btnSleepTimer.classList.contains("is-active")
            );
            if (!isActive) {
                return;
            }
            evt.preventDefault();
            evt.stopPropagation();
            socket.emit("sleep-timer-cancel");
            WNP.setSleepTimerState({
                active: false,
                mode: null,
                targetTimeStamp: null,
                durationMinutes: null
            });
        };
        this.r.btnSleepTimer.addEventListener("pointerdown", cancelSleepTimerFromButton);
        this.r.btnSleepTimer.addEventListener("click", cancelSleepTimerFromButton);
    }

    document.querySelectorAll(".btnSleepTimerPreset").forEach((btn) => {
        btn.addEventListener("click", function () {
            var minutes = parseInt(this.getAttribute("data-minutes"), 10);
            if (!isNaN(minutes) && minutes > 0) {
                socket.emit("sleep-timer-set", { mode: "minutes", minutes: minutes });
                WNP.hideSleepTimerModal();
            }
        });
    });

    document.querySelectorAll(".btnSleepTimerSongEnd").forEach((btn) => {
        btn.addEventListener("click", function () {
            socket.emit("sleep-timer-set", { mode: "song-end" });
            WNP.hideSleepTimerModal();
        });
    });

    if (this.r.btnSleepTimerApplyCustom && this.r.sleepTimerMinutes) {
        this.r.btnSleepTimerApplyCustom.addEventListener("click", function () {
            var minutes = parseInt(WNP.r.sleepTimerMinutes.value, 10);
            if (!isNaN(minutes) && minutes > 0) {
                socket.emit("sleep-timer-set", { mode: "minutes", minutes: minutes });
                WNP.hideSleepTimerModal();
            }
        });
    }

};

/**
 * Set the socket definitions to listen for specific websocket traffic and handle accordingly.
 * @returns {undefined}
 */
WNP.setSocketDefinitions = function () {
    console.log("WNP", "Setting Socket definitions...")

    const shouldReloadForVersionChange = function (msg) {
        const previousClientVersion = WNP.d.serverSettings && WNP.d.serverSettings.version ? WNP.d.serverSettings.version.client : null;
        const nextClientVersion = msg && msg.version ? msg.version.client : null;

        if (previousClientVersion && nextClientVersion && previousClientVersion !== nextClientVersion) {
            return true;
        }

        const serverVersion = msg && msg.version ? msg.version.server : null;
        if (serverVersion && nextClientVersion && serverVersion !== nextClientVersion) {
            const mismatchSignature = serverVersion + "::" + nextClientVersion;
            if (sessionStorage.getItem("wnp-version-mismatch-reloaded") !== mismatchSignature) {
                sessionStorage.setItem("wnp-version-mismatch-reloaded", mismatchSignature);
                return true;
            }
        }

        return false;
    };

    // On server settings
    socket.on("server-settings", function (msg) {

        if (shouldReloadForVersionChange(msg)) {
            console.log("WNP", "Version change detected, reloading UI...");
            location.reload();
            return;
        }

        // Store server settings
        WNP.d.serverSettings = msg;

        // RPi has bash, so possibly able to reboot/shutdown.
        if (msg && msg.os && msg.os.userInfo && msg.os.userInfo.shell === "/bin/bash") {
            WNP.r.btnReboot.disabled = false;
            WNP.r.btnUpdate.disabled = false;
            WNP.r.btnShutdown.disabled = false;
        };

        // Set device name
        WNP.r.devName.innerText = (msg && msg.selectedDevice && msg.selectedDevice.friendlyName) ? msg.selectedDevice.friendlyName : "-";

        // Set the server local url
        if (msg && msg.os && msg.os.hostname) {
            var sUrl = "http://" + msg.os.hostname.toLowerCase() + ".local";
            sUrl += (location && location.port && location.port != 80) ? ":" + location.port + "/" : "/";
            WNP.r.sServerUrlHostname.innerHTML = "<a href=\"" + sUrl + "\">" + sUrl + "</a>";
        }
        else {
            WNP.r.sServerUrlHostname.innerText = "-";
        }
        // Set the server ip address
        if (msg && msg.selectedDevice && msg.selectedDevice.location && msg.os && msg.os.networkInterfaces) {
            // Grab the ip address pattern of the selected device
            // Assumption is that the wiim-now-playing server is on the same ip range as the client..
            var sLocationIp = msg.selectedDevice.location.split("/")[2]; // Extract ip address from location
            var aIpAddress = sLocationIp.split("."); // Split ip address in parts
            aIpAddress.pop(); // Remove the last part
            var sIpPattern = aIpAddress.join("."); // Construct ip address pattern
            // Search for server ip address(es) in this range...
            Object.keys(msg.os.networkInterfaces).forEach(function (key, index) {
                var sIpFound = msg.os.networkInterfaces[key].find(addr => addr.address.startsWith(sIpPattern))
                if (sIpFound) {
                    // Construct ip address and optional port
                    var sUrl = "http://" + sIpFound.address;
                    sUrl += (location && location.port && location.port != 80) ? ":" + location.port + "/" : "/";
                    WNP.r.sServerUrlIP.innerHTML = "<a href=\"" + sUrl + "\">" + sUrl + "</a>";
                }
            });
        }
        else {
            WNP.r.sServerUrlIP.innerText = "-";
        }

        // Set the server version
        WNP.r.sServerVersion.innerText = (msg && msg.version && msg.version.server) ? msg.version.server : "-";
        // Set the client version
        WNP.r.sClientVersion.innerText = (msg && msg.version && msg.version.client) ? msg.version.client : "-";

        if (WNP.r.chkLyricsEnabled) {
            WNP.r.chkLyricsEnabled.checked = Boolean(msg && msg.features && msg.features.lyrics && msg.features.lyrics.enabled);
        }
        if (WNP.r.lyricsOffsetMs) {
            var offsetMs = (msg && msg.features && msg.features.lyrics && typeof msg.features.lyrics.offsetMs === "number") ? msg.features.lyrics.offsetMs : 0;
            WNP.r.lyricsOffsetMs.value = offsetMs;
        }
        if (WNP.r.chkLyricsInsertBlankLineForLongGaps) {
            WNP.r.chkLyricsInsertBlankLineForLongGaps.checked = !(msg && msg.features && msg.features.lyrics && msg.features.lyrics.insertBlankLineForLongGaps === false);
        }
        if (WNP.r.lyricsMediumGapSec) {
            var mediumGapSec = (msg && msg.features && msg.features.lyrics && typeof msg.features.lyrics.mediumGapSec === "number")
                ? msg.features.lyrics.mediumGapSec
                : 10;
            WNP.r.lyricsMediumGapSec.value = mediumGapSec;
        }
        if (WNP.r.lyricsLongGapSec) {
            var longGapSec = (msg && msg.features && msg.features.lyrics && typeof msg.features.lyrics.longGapSec === "number")
                ? msg.features.lyrics.longGapSec
                : 20;
            WNP.r.lyricsLongGapSec.value = longGapSec;
        }
        if (WNP.r.chkLyricsCacheEnabled || WNP.r.lyricsCacheSizeMB || WNP.r.lyricsPrefetchMode) {
            var cacheSettings = (msg && msg.features && msg.features.lyrics && msg.features.lyrics.cache) ? msg.features.lyrics.cache : {};
            var cacheSizeMB = (typeof cacheSettings.maxSizeMB === "number") ? cacheSettings.maxSizeMB : 0;
            var cacheEnabled = cacheSettings.enabled !== false && cacheSizeMB > 0;
            if (WNP.r.chkLyricsCacheEnabled) {
                WNP.r.chkLyricsCacheEnabled.checked = cacheEnabled;
            }
            if (WNP.r.lyricsCacheSizeMB) {
                WNP.r.lyricsCacheSizeMB.value = cacheSizeMB;
            }
            if (WNP.r.lyricsPrefetchMode) {
                WNP.r.lyricsPrefetchMode.value = cacheSettings.prefetch || "off";
            }
        }

        if (WNP.r.chkCoverArtEnabled) {
            WNP.r.chkCoverArtEnabled.checked = Boolean(msg && msg.features && msg.features.coverArt && msg.features.coverArt.enabled);
        }
        if (WNP.r.selCoverArtProvider) {
            WNP.r.selCoverArtProvider.value = (msg && msg.features && msg.features.coverArt && msg.features.coverArt.provider) ? msg.features.coverArt.provider : "caa";
        }
        if (WNP.r.coverArtMemoryPoolMB) {
            WNP.r.coverArtMemoryPoolMB.value = (msg && msg.features && msg.features.coverArt && typeof msg.features.coverArt.memoryPoolMB === "number") ? msg.features.coverArt.memoryPoolMB : 100;
        }

        var wledSettings = (msg && msg.features && msg.features.wled) ? msg.features.wled : {};
        var wledEnabled = Boolean(wledSettings.enabled);
        if (WNP.r.chkWledEnabled) {
            WNP.r.chkWledEnabled.checked = wledEnabled;
        }
        WNP.setWledQuickToggleState(wledEnabled);
        if (WNP.r.wledHost) {
            WNP.r.wledHost.value = wledSettings.host || "";
        }
        if (WNP.r.wledPreset) {
            var presetValue = (typeof wledSettings.playbackPreset === "number") ? wledSettings.playbackPreset : 0;
            WNP.r.wledPreset.value = presetValue;
        }
        if (WNP.r.wledPausePreset) {
            var pausePresetValue = (typeof wledSettings.pausePreset === "number") ? wledSettings.pausePreset : 0;
            WNP.r.wledPausePreset.value = pausePresetValue;
        }
        if (WNP.r.wledOffDelaySec) {
            var offDelayValue = (typeof wledSettings.offDelaySec === "number") ? wledSettings.offDelaySec : 300;
            WNP.r.wledOffDelaySec.value = offDelayValue;
        }
        if (WNP.r.wledToggleUrl) {
            var relativeUrl = "/api/wled/toggle";
            WNP.r.wledToggleUrl.href = relativeUrl;
            WNP.r.wledToggleUrl.innerText = relativeUrl;
        }
        if (WNP.r.voicePresetId) {
            var voicePresetSettings = (msg && msg.features && msg.features.voicePreset) ? msg.features.voicePreset : {};
            WNP.r.voicePresetId.value = (typeof voicePresetSettings.voicePresetId === "number") ? voicePresetSettings.voicePresetId : 0;
        }
        if (WNP.r.defaultPresetId) {
            var defaultSettings = (msg && msg.features && msg.features.voicePreset) ? msg.features.voicePreset : {};
            WNP.r.defaultPresetId.value = (typeof defaultSettings.defaultPresetId === "number") ? defaultSettings.defaultPresetId : 0;
        }
        if (WNP.r.voicePresetLookupEnabled) {
            var lookupSettings = (msg && msg.features && msg.features.voicePreset) ? msg.features.voicePreset : {};
            WNP.r.voicePresetLookupEnabled.checked = lookupSettings.lookupEnabled !== false;
        }

        if (WNP.r.chkLyricsEnabled && !WNP.d.lyricsCookieApplied) {
            var cookieValue = WNP.getCookie("wnpLyricsEnabled");
            if (cookieValue !== null) {
                var cookieEnabled = cookieValue === "true";
                if (WNP.r.chkLyricsEnabled.checked !== cookieEnabled) {
                    WNP.r.chkLyricsEnabled.checked = cookieEnabled;
                    socket.emit("server-settings-update", {
                        features: {
                            lyrics: {
                                enabled: cookieEnabled
                            }
                        }
                    });
                }
            } else {
                WNP.setCookie("wnpLyricsEnabled", WNP.r.chkLyricsEnabled.checked, 180);
            }
            WNP.d.lyricsCookieApplied = true;
        }

        if (WNP.r.kioskHost) {
            var kioskHost = (msg && msg.kiosk && msg.kiosk.host) ? msg.kiosk.host : "";
            WNP.r.kioskHost.value = kioskHost;
        }
        if (WNP.r.kioskPassword) {
            var kioskPassword = (msg && msg.kiosk && msg.kiosk.password) ? msg.kiosk.password : "";
            WNP.r.kioskPassword.value = kioskPassword;
        }
        if (WNP.r.kioskDelaySec) {
            var kioskDelaySec = (msg && msg.kiosk && typeof msg.kiosk.screenOffDelaySec === "number") ? msg.kiosk.screenOffDelaySec : 300;
            WNP.r.kioskDelaySec.value = kioskDelaySec;
        }

    });

    socket.on("sleep-timer-state", function (msg) {
        WNP.setSleepTimerState(msg);
    });

    // On devices get
    socket.on("devices-get", function (msg) {

        // Store and sort device list
        WNP.d.deviceList = msg;
        WNP.d.deviceList.sort((a, b) => { return (a.friendlyName < b.friendlyName) ? -1 : 1 });

        // Clear choices
        WNP.r.selDeviceChoices.innerHTML = "<option value=\"\">Select a device...</em></li>"; // Settings modal
        if (WNP.r.oDeviceList) WNP.r.oDeviceList.innerHTML = ""; // Device dropup

        // Add WiiM devices
        var devicesWiiM = WNP.d.deviceList.filter((d) => { return d.manufacturer.startsWith("Linkplay") });
        if (devicesWiiM.length > 0) {

            // Device select options
            var optGroup = document.createElement("optgroup");
            optGroup.label = "WiiM devices";
            devicesWiiM.forEach((device) => {
                var opt = document.createElement("option");
                opt.value = device.location;
                opt.innerText = device.friendlyName;
                opt.title = "By " + device.manufacturer;
                if (WNP.d.serverSettings && WNP.d.serverSettings.selectedDevice && WNP.d.serverSettings.selectedDevice.location === device.location) {
                    opt.setAttribute("selected", "selected");
                };
                optGroup.appendChild(opt);
            })
            WNP.r.selDeviceChoices.appendChild(optGroup);

            // Device dropup
            if (WNP.r.oDeviceList) {
                devicesWiiM.forEach((device) => {
                    var ddItem = document.createElement("li");
                    var ddItemA = document.createElement("a");
                    ddItemA.className = "dropdown-item";
                    ddItemA.href = "javascript:WNP.setDeviceByLocation('" + device.location + "');";
                    ddItemA.innerText = device.friendlyName;
                    if (WNP.d.serverSettings && WNP.d.serverSettings.selectedDevice && WNP.d.serverSettings.selectedDevice.location === device.location) {
                        ddItemA.classList.add("active");
                        ddItemA.setAttribute("aria-current", "true");
                    }
                    ddItem.appendChild(ddItemA);
                    WNP.r.oDeviceList.appendChild(ddItem);
                })
            }

        };

        // Other devices
        // Possibly removing this section in future releases.
        var devicesOther = WNP.d.deviceList.filter((d) => { return !d.manufacturer.startsWith("Linkplay") });
        if (devicesOther.length > 0) {

            // Device select dropdown options
            var optGroup = document.createElement("optgroup");
            optGroup.label = "Other devices";
            devicesOther.forEach((device) => {
                var opt = document.createElement("option");
                opt.value = device.location;
                opt.innerText = device.friendlyName;
                opt.title = "By " + device.manufacturer;
                if (WNP.d.serverSettings && WNP.d.serverSettings.selectedDevice && WNP.d.serverSettings.selectedDevice.location === device.location) {
                    opt.setAttribute("selected", "selected");
                };
                optGroup.appendChild(opt);
            })
            WNP.r.selDeviceChoices.appendChild(optGroup);

            // Device dropup
            // We won't show non-WiiM devices in the dropup for now.

        };

        // No devices found
        if (devicesWiiM.length == 0 && devicesOther.length == 0) {
            WNP.r.selDeviceChoices.innerHTML = "<option disabled=\"disabled\">No devices found!</em></li>";
            if (WNP.r.oDeviceList) WNP.r.oDeviceList.innerHTML = "<li><span class=\"dropdown-header\">No devices found!</span></li>";
        };

    });

    // On state
    socket.on("state", function (msg) {
        if (!msg) { return false; }

        // Get player progress data from the state message.
        var timeStampDiff = 0;
        if (msg.CurrentTransportState === "PLAYING") {
            timeStampDiff = (msg.stateTimeStamp && msg.metadataTimeStamp) ? Math.round((msg.stateTimeStamp - msg.metadataTimeStamp) / 1000) : 0;
        }
        var relTime = (msg.RelTime) ? msg.RelTime : "00:00:00";
        var trackDuration = (msg.TrackDuration) ? msg.TrackDuration : "00:00:00";

        // Get current player progress and set UI elements accordingly.
        var oPlayerProgress = WNP.getPlayerProgress(relTime, trackDuration, timeStampDiff, msg.CurrentTransportState);
        WNP.r.progressPlayed.children[0].innerText = oPlayerProgress.played;
        WNP.r.progressLeft.children[0].innerText = (oPlayerProgress.left != "") ? "-" + oPlayerProgress.left : "";
        WNP.r.progressPercent.setAttribute("aria-valuenow", oPlayerProgress.percent)
        WNP.r.progressPercent.children[0].setAttribute("style", "width:" + oPlayerProgress.percent + "%");

        WNP.d.lastState = msg;
        WNP.d.currentTrackDurationSec = WNP.parseDurationToSeconds(trackDuration);
        if (WNP.d.waitingForSongStart && WNP.d.pendingLyricsLines.length > 0 && WNP.shouldUseStateForCurrentTrack(msg)) {
            if (!WNP.isLyricsProgressTooFarAhead(relTime, timeStampDiff)) {
                var relTimeSeconds = WNP.convertToSeconds(relTime);
                if (relTimeSeconds <= 1) {
                    WNP.activateLyricsForTrackStart(relTime, timeStampDiff);
                }
                else {
                    // Lyrics can arrive late (or without a trusted state snapshot) after the song already advanced.
                    // In that case, activate immediately on the first matching state update.
                    WNP.activateLyricsForTrackStart(relTime, timeStampDiff);
                }
            }
        }
        WNP.updateLyricsProgress(relTime, timeStampDiff);

        // Device transport state or play medium changed...?
        if (WNP.d.prevTransportState !== msg.CurrentTransportState || WNP.d.prevPlayMedium !== msg.PlayMedium) {
            if (msg.CurrentTransportState === "TRANSITIONING") {
                WNP.r.btnPlay.children[0].className = "bi bi-circle-fill";
                WNP.r.btnPlay.disabled = true;
            };
            if (msg.CurrentTransportState === "PLAYING") {
                // Radio live streams are preferrentialy stopped as pausing keeps cache for minutes/hours(?).
                // Stop > Play resets the stream to 'now'. Pause works like 'live tv time shift'.
                if (msg.PlayMedium && msg.PlayMedium === "RADIO-NETWORK") {
                    WNP.r.btnPlay.children[0].className = "bi bi-stop-circle-fill";
                    WNP.r.btnPlay.setAttribute("wnp-action", "Stop");
                }
                else {
                    WNP.r.btnPlay.children[0].className = "bi bi-pause-circle-fill";
                    WNP.r.btnPlay.setAttribute("wnp-action", "Pause");
                }
                WNP.r.btnPlay.disabled = false;
            }
            else if (msg.CurrentTransportState === "PAUSED_PLAYBACK" || msg.CurrentTransportState === "STOPPED") {
                WNP.r.btnPlay.children[0].className = "bi bi-play-circle-fill";
                WNP.r.btnPlay.setAttribute("wnp-action", "Play");
                WNP.r.btnPlay.disabled = false;
            };
            WNP.d.prevTransportState = msg.CurrentTransportState; // Remember the last transport state
            WNP.d.prevPlayMedium = msg.PlayMedium; // Remember the last PlayMedium
        }

        // If internet radio, there is no skipping... just start and stop!
        if (msg.PlayMedium && msg.PlayMedium === "RADIO-NETWORK") {
            WNP.r.btnPrev.disabled = true;
            WNP.r.btnNext.disabled = true;
        }
        else {
            WNP.r.btnPrev.disabled = false;
            WNP.r.btnNext.disabled = false;
        }

    });

    // On metadata
    socket.on("metadata", function (msg) {
        if (!msg) { return false; }
        WNP.fetchLyricsControlState();

        // Source detection
        var playMedium = (msg.PlayMedium) ? msg.PlayMedium : "";
        var trackSource = (msg.TrackSource) ? msg.TrackSource : "";
        var sourceIdent = WNP.getSourceIdent(playMedium, trackSource);
        var sourceAlt = playMedium + ": " + trackSource;
        var compactSourceText = trackSource || playMedium;
        // Did the source ident change...?
        if (sourceIdent !== WNP.d.prevSourceIdent) {
            if (sourceIdent !== "") {
                var identImg = document.createElement("img");
                identImg.src = sourceIdent;
                identImg.alt = sourceAlt;
                identImg.title = sourceAlt;
                mediaSource.innerHTML = identImg.outerHTML;
            }
            else {
                mediaSource.innerText = sourceAlt;
            }
            WNP.d.prevSourceIdent = sourceIdent; // Remember the last Source Ident
        }

        // Song Title, Subtitle, Artist, Album
        WNP.r.mediaTitle.innerText = (msg.trackMetaData && msg.trackMetaData["dc:title"]) ? msg.trackMetaData["dc:title"] : "";
        WNP.r.mediaSubTitle.innerText = (msg.trackMetaData && msg.trackMetaData["dc:subtitle"]) ? msg.trackMetaData["dc:subtitle"] : "";
        WNP.r.mediaArtist.innerText = (msg.trackMetaData && msg.trackMetaData["upnp:artist"]) ? msg.trackMetaData["upnp:artist"] : "";
        WNP.r.mediaAlbum.innerText = (msg.trackMetaData && msg.trackMetaData["upnp:album"]) ? msg.trackMetaData["upnp:album"] : "";
        if (playMedium === "SONGLIST-NETWORK" && !trackSource && msg.CurrentTransportState === "STOPPED") {
            WNP.r.mediaTitle.innerText = "No Music Selected";
        }

        // Audio quality
        var songBitrate = (msg.trackMetaData && msg.trackMetaData["song:bitrate"]) ? msg.trackMetaData["song:bitrate"] : "";
        var songBitDepth = (msg.trackMetaData && msg.trackMetaData["song:format_s"]) ? msg.trackMetaData["song:format_s"] : "";
        var songSampleRate = (msg.trackMetaData && msg.trackMetaData["song:rate_hz"]) ? msg.trackMetaData["song:rate_hz"] : "";
        WNP.r.mediaBitRate.innerText = (songBitrate > 0) ? ((songBitrate > 1000) ? (songBitrate / 1000).toFixed(2) + " mbps, " : songBitrate + " kbps, ") : "";
        WNP.r.mediaBitDepth.innerText = (songBitDepth > 0) ? ((songBitDepth > 24) ? "24 bit/" : songBitDepth + " bit/") : "";
        WNP.r.mediaSampleRate.innerText = (songSampleRate > 0) ? (songSampleRate / 1000).toFixed(1) + " kHz" : "";
        if (!songBitrate && !songBitDepth && !songSampleRate) {
            WNP.r.mediaQualityIdent.style.display = "none";
        }
        else {
            WNP.r.mediaQualityIdent.style.display = "inline-block";
        }

        // Audio quality ident badge (HD/Hi-res/CD/...)
        var songQuality = (msg.trackMetaData && msg.trackMetaData["song:quality"]) ? msg.trackMetaData["song:quality"] : "";
        var songActualQuality = (msg.trackMetaData && msg.trackMetaData["song:actualQuality"]) ? msg.trackMetaData["song:actualQuality"] : "";
        var qualiIdent = WNP.getQualityIdent(songQuality, songActualQuality, songBitrate, songBitDepth, songSampleRate);
        var qualiIdentLower = (qualiIdent || "").toLowerCase();
        if (qualiIdentLower !== "") {
            WNP.r.mediaQualityIdent.innerText = qualiIdentLower;
            WNP.r.mediaQualityIdent.title = "Quality: " + songQuality + ", " + songActualQuality;
        }
        else {
            var identId = document.createElement("i");
            identId.className = "bi bi-soundwave text-secondary";
            identId.title = "Quality: " + songQuality + ", " + songActualQuality;
            WNP.r.mediaQualityIdent.innerHTML = identId.outerHTML;
        }

        var isCompactTvMode = !!(
            WNP.r.wnpApp &&
            WNP.r.wnpApp.classList &&
            (WNP.r.wnpApp.classList.contains("tv-mode") || WNP.r.wnpApp.classList.contains("wallart-mode") || WNP.r.wnpApp.classList.contains("wallart-portrait-mode") || WNP.r.wnpApp.classList.contains("wallart-landscape-mode"))
        );
        if (isCompactTvMode) {
            var compactStripParen = function (input) {
                var text = (input || "").toString();
                var pidx = text.indexOf("(");
                if (pidx >= 0) {
                    text = text.substring(0, pidx);
                }
                return text.trim();
            };
            var displayTitle = compactStripParen(WNP.r.mediaTitle.innerText);
            var displayArtist = compactStripParen(WNP.r.mediaArtist.innerText);

            if (WNP.r.mediaTitleCompact && WNP.r.mediaTitleArtist) {
                WNP.r.mediaTitleCompact.innerText = displayTitle;
                WNP.r.mediaTitleArtist.style.display = displayTitle ? "" : "none";
            }
            if (WNP.r.mediaArtistCompact && WNP.r.mediaAlbumQuality) {
                WNP.r.mediaArtistCompact.innerText = displayArtist;
                WNP.r.mediaAlbumQuality.style.display = displayArtist ? "" : "none";
            }
            if (WNP.r.mediaQualityCompact) {
                var compactQuality = qualiIdentLower || "";
                WNP.r.mediaQualityCompact.innerText = compactQuality;
                WNP.r.mediaQualityCompact.style.display = compactQuality ? "" : "none";
            }
            if (WNP.r.mediaSourceCompact) {
                var compactSource = compactSourceText || "";
                WNP.r.mediaSourceCompact.innerText = compactSource;
                WNP.r.mediaSourceCompact.title = sourceAlt;
                WNP.r.mediaSourceCompact.style.display = compactSource ? "" : "none";
            }
            if (WNP.r.mediaSourceFooter) {
                var footerSource = compactSourceText || "";
                WNP.r.mediaSourceFooter.innerText = footerSource;
                WNP.r.mediaSourceFooter.title = sourceAlt;
                WNP.r.mediaSourceFooter.style.display = footerSource ? "inline-block" : "none";
            }
        }
        else {
            if (WNP.r.mediaTitleCompact && WNP.r.mediaArtistCompact && WNP.r.mediaTitleArtist) {
                WNP.setCompactLine(
                    WNP.r.mediaTitleArtist,
                    WNP.r.mediaTitleCompact,
                    WNP.r.mediaArtistCompact,
                    null,
                    WNP.r.mediaTitle.innerText,
                    WNP.r.mediaArtist.innerText
                );
            }
            if (WNP.r.mediaAlbumCompact && WNP.r.mediaQualityCompact && WNP.r.mediaSourceCompact && WNP.r.mediaAlbumQuality) {
                var compactAlbum = WNP.r.mediaAlbum.innerText;
                var compactQuality = qualiIdentLower || "";
                var compactSource = compactSourceText || "";
                WNP.r.mediaAlbumCompact.innerText = compactAlbum;
                WNP.r.mediaAlbumCompact.style.display = compactAlbum ? "" : "none";
                WNP.r.mediaQualityCompact.innerText = compactQuality;
                WNP.r.mediaQualityCompact.style.display = compactQuality ? "" : "none";
                WNP.r.mediaSourceCompact.innerText = compactSource;
                WNP.r.mediaSourceCompact.title = sourceAlt;
                WNP.r.mediaSourceCompact.style.display = compactSource ? "" : "none";
                WNP.r.mediaAlbumQuality.style.display = (compactAlbum || compactQuality || compactSource) ? "" : "none";
            }
        }

        // Pre-process Album Art uri, if any is available from the metadata.
        var albumArtUriRaw = (msg.trackMetaData && msg.trackMetaData["upnp:albumArtURI"]) ? msg.trackMetaData["upnp:albumArtURI"] : "";
        var albumArtUri = WNP.checkAlbumArtURI(albumArtUriRaw, msg.metadataTimeStamp);

        // Set Album Art with stable behavior per track.
        // 1) On track change we always set once (device art if available, otherwise placeholder).
        // 2) If the same track later receives a valid device art URI, set once and lock.
        var trackArtist = (msg.trackMetaData && msg.trackMetaData["upnp:artist"]) ? msg.trackMetaData["upnp:artist"] : "";
        var trackAlbum = (msg.trackMetaData && msg.trackMetaData["upnp:album"]) ? msg.trackMetaData["upnp:album"] : "";
        var trackTitle = (msg.trackMetaData && msg.trackMetaData["dc:title"]) ? msg.trackMetaData["dc:title"] : "";
        WNP.d.currentLyricsTrackKey = msg.lyricsTrackKey || WNP.buildLyricsTrackKey(
            trackTitle,
            trackArtist,
            trackAlbum,
            WNP.parseDurationToSeconds(msg.TrackDuration)
        );
        WNP.d.currentTrackMetadataTimeStamp = msg.metadataTimeStamp || null;

        var nextTrackKey = (trackArtist + "|" + trackAlbum + "|" + trackTitle).trim().toLowerCase();
        var currentTrackInfo = WNP.r.mediaTitle.innerText + "|" + WNP.r.mediaSubTitle.innerText + "|" + WNP.r.mediaArtist.innerText + "|" + WNP.r.mediaAlbum.innerText;
        if (WNP.d.currentTrackKey !== nextTrackKey) {
            WNP.d.prevTrackInfo = currentTrackInfo; // Remember the last track info for diagnostics only
            WNP.d.currentTrackKey = nextTrackKey;
            WNP.d.currentTrackCoverLocked = false;
            WNP.d.pendingTrackCoverUri = null;
            WNP.d.pendingTrackCoverSource = null;
            WNP.d.currentTrackCoverSource = null;
            WNP.d.currentTrackFailedCoverUri = null;
            console.log("WNP", "Track changed:", currentTrackInfo);
            WNP.logCover("track-changed reset", {
                trackKey: WNP.d.currentTrackKey,
                albumArtUriRaw: albumArtUriRaw,
                albumArtUri: albumArtUri
            });
            WNP.d.recentSongSwitchAtMs = Date.now();
            WNP.clearLyrics();
            if (albumArtUriRaw) {
                WNP.trySetTrackCover(albumArtUri, "device");
            }
            else {
                WNP.setAlbumArt(albumArtUri);
            }
        } else if (albumArtUriRaw) {
            // Same song: allow switching from fallback/proxy to device art,
            // but do not keep retrying URIs that already failed for this track.
            var normalizedAlbumArtUri = WNP.normalizeCoverUri(albumArtUri);
            var isKnownFailedUri = Boolean(WNP.d.currentTrackFailedCoverUri)
                && WNP.d.currentTrackFailedCoverUri === normalizedAlbumArtUri;

            if (isKnownFailedUri) {
                WNP.logCover("skip known failing device cover uri", {
                    albumArtUri: albumArtUri,
                    trackKey: WNP.d.currentTrackKey
                });
            } else if (WNP.r.albumArt.src !== albumArtUri) {
                if (WNP.d.currentTrackCoverSource !== "device" || !WNP.d.currentTrackCoverLocked) {
                    WNP.trySetTrackCover(albumArtUri, "device");
                }
            }
        }

        // Device volume
        WNP.r.devVol.innerText = (msg.CurrentVolume) ? msg.CurrentVolume : "-"; // Set the volume on the UI
        if (WNP.r.rVolume && (WNP.r.rVolume.value !== WNP.r.devVol.innerText)) { // If volume on the range slider is different then update the range input value
            WNP.r.rVolume.value = WNP.r.devVol.innerText;
        }

        // Loop mode status
        if (msg.LoopMode) {
            switch (msg.LoopMode) {
                case "5": // repeat-1 | shuffle
                    WNP.r.btnRepeat.className = "btn btn-outline-success";
                    WNP.r.btnRepeat.children[0].className = "bi bi-repeat-1";
                    WNP.r.btnShuffle.className = "btn btn-outline-success";
                    break;
                case "3": // no repeat | shuffle
                    WNP.r.btnRepeat.className = "btn btn-outline-light";
                    WNP.r.btnRepeat.children[0].className = "bi bi-repeat";
                    WNP.r.btnShuffle.className = "btn btn-outline-success";
                    break;
                case "2": // repeat | shuffle
                    WNP.r.btnRepeat.className = "btn btn-outline-success";
                    WNP.r.btnRepeat.children[0].className = "bi bi-repeat";
                    WNP.r.btnShuffle.className = "btn btn-outline-success";
                    break;
                case "1": // repeat-1 | no shuffle
                    WNP.r.btnRepeat.className = "btn btn-outline-success";
                    WNP.r.btnRepeat.children[0].className = "bi bi-repeat-1";
                    WNP.r.btnShuffle.className = "btn btn-outline-light";
                    // change repeat icon
                    break;
                case "0": // repeat | no shuffle
                    WNP.r.btnRepeat.className = "btn btn-outline-success";
                    WNP.r.btnRepeat.children[0].className = "bi bi-repeat";
                    WNP.r.btnShuffle.className = "btn btn-outline-light";
                    break;
                default: // no repeat | no shuffle #4
                    WNP.r.btnRepeat.className = "btn btn-outline-light";
                    WNP.r.btnRepeat.children[0].className = "bi bi-repeat";
                    WNP.r.btnShuffle.className = "btn btn-outline-light";
            }
        }
        else { // Unknown, so set default
            WNP.r.btnRepeat.className = "btn btn-outline-light";
            WNP.r.btnRepeat.children[0].className = "bi bi-repeat";
            WNP.r.btnShuffle.className = "btn btn-outline-light";
        }

    });

    socket.on("cover-art-resolved", function (msg) {
        WNP.logCover("cover-art-resolved event", {
            msgTrackKey: msg && msg.trackKey,
            currentTrackKey: WNP.d.currentTrackKey,
            cacheKey: msg && msg.cacheKey,
            currentSource: WNP.d.currentTrackCoverSource,
            locked: WNP.d.currentTrackCoverLocked
        });
        if (!msg || !msg.cacheKey || !WNP.d.currentTrackKey || msg.trackKey !== WNP.d.currentTrackKey) {
            WNP.logCover("cover-art-resolved ignored (invalid/stale)");
            return;
        }
        if (WNP.d.currentTrackCoverLocked || WNP.d.currentTrackCoverSource === "device") {
            return;
        }
        var coverUri = WNP.buildResolvedCoverUri(msg.cacheKey);
        WNP.trySetTrackCover(coverUri, "resolved");
    });

    // On lyrics
    socket.on("lyrics", function (msg) {
        if (!msg) {
            WNP.clearLyrics();
            return;
        }

        if (msg.trackKey && WNP.d.currentLyricsTrackKey && msg.trackKey !== WNP.d.currentLyricsTrackKey) {
            return;
        }

        WNP.d.lyrics = msg;
        WNP.d.lyricsIndex = null;
        WNP.fetchLyricsControlState();

        if (msg.status !== "ok" || !msg.syncedLyrics) {
            WNP.clearLyrics();
            return;
        }

        var parsedLyrics = WNP.parseSyncedLyrics(msg.syncedLyrics);
        if (!parsedLyrics.length) {
            WNP.clearLyrics();
            return;
        }

        var lyricsDurationSec = WNP.parseDurationToSeconds(msg.duration);
        if (lyricsDurationSec === null && msg.signature && msg.signature.duration) {
            lyricsDurationSec = WNP.parseDurationToSeconds(msg.signature.duration);
        }
        if (lyricsDurationSec === null && typeof WNP.d.currentTrackDurationSec === "number") {
            lyricsDurationSec = WNP.d.currentTrackDurationSec;
        }

        WNP.d.pendingLyricsLines = WNP.buildDisplayLyricsLines(parsedLyrics, lyricsDurationSec);
        WNP.d.pendingLyricsTrackKey = msg.trackKey || null;
        WNP.d.waitingForSongStart = false;

        if (WNP.isInSongSwitchGuardWindow()) {
            WNP.activateLyricsForTrackStart("00:00:00", 0);
        }

        if (WNP.d.lastState && WNP.shouldUseStateForCurrentTrack(WNP.d.lastState)) {
            var lastRelTime = WNP.convertToSeconds(WNP.d.lastState.RelTime || "00:00:00");
            var lastOffset = 0;
            if (WNP.d.lastState.CurrentTransportState === "PLAYING") {
                lastOffset = (WNP.d.lastState.stateTimeStamp && WNP.d.lastState.metadataTimeStamp)
                    ? Math.round((WNP.d.lastState.stateTimeStamp - WNP.d.lastState.metadataTimeStamp) / 1000)
                    : 0;
            }
            if (WNP.isLyricsProgressTooFarAhead(WNP.d.lastState.RelTime || "00:00:00", lastOffset)) {
                WNP.d.waitingForSongStart = true;
                return;
            }
            if (lastRelTime <= 1) {
                // Fresh track start: initially pin lyrics to the beginning.
                WNP.d.waitingForSongStart = true;
                WNP.activateLyricsForTrackStart(WNP.d.lastState.RelTime || "00:00:00", lastOffset);
                return;
            }
            // Lyrics arrived after start (e.g. slow provider/cache miss): show immediately at current time.
            WNP.activateLyricsForTrackStart(WNP.d.lastState.RelTime || "00:00:00", lastOffset);
            return;
        }

        // No reliable state snapshot yet; keep pending until the next state update.
        WNP.d.waitingForSongStart = true;
    });

    // On device set
    socket.on("device-set", function (msg) {
        // Device switch? Fetch settings and device info again.
        socket.emit("server-settings");
        socket.emit("devices-get");
    });

    // On device refresh
    socket.on("devices-refresh", function (msg) {
        WNP.r.selDeviceChoices.innerHTML = "<option disabled=\"disabled\">Waiting for devices...</em></li>";
        if (WNP.r.oDeviceList) WNP.r.oDeviceList.innerHTML = "<li><span class=\"dropdown-header\">Waiting for devices...</span></li>";
    });

    // On device action (i.e. for play, pause, next, previous)
    socket.on("device-action", function (msg, param) {
        // Actions do not return a message.
        // so we don't need to do anything here.
        // Maybe later we can use this to show a notification or similar.
        console.log("WNP", "Action:", msg);
    });

    // On device API response
    socket.on("device-api", function (msg, param) {
        // console.log("IO: device-api", msg, param);
        switch (msg) {
            case "getPresetInfo":
                // Preset info response
                if (!param || param.preset_num < 1) {
                    // No presets
                    WNP.r.oPresetList.innerHTML = "<li><span class=\"dropdown-header\">No presets found!</span></li>";
                    return false;
                }
                else {
                    // Presets found
                    WNP.r.oPresetList.innerHTML = ""; // Clear existing list
                    var sCurrentTitle = WNP.r.mediaTitle.innerText;
                    var sCurrentSubtitle = WNP.r.mediaSubTitle.innerText;
                    param.preset_list.forEach((preset) => {
                        var ddItem = document.createElement("li");
                        var ddItemA = document.createElement("a");
                        ddItemA.className = "dropdown-item";
                        ddItemA.href = "javascript:WNP.setPresetByNumber(" + preset.number + ");";
                        ddItemA.innerHTML = "<img src=\"" + WNP.checkAlbumArtURI(preset.picurl, Date.now()) + "\"/> " + preset.name;
                        if (sCurrentTitle === preset.name || sCurrentSubtitle === preset.name) {
                            ddItemA.classList.add("active");
                            ddItemA.setAttribute("aria-current", "true");
                        }
                        ddItem.appendChild(ddItemA);
                        WNP.r.oPresetList.appendChild(ddItem);
                    })
                }
                break;
            case msg.startsWith("MCUKeyShortClick:") ? msg : false:
                // Preset set response, no further action needed
                break;
            case "getPlayerStatus":
                // Player status response
                // Called when getting volume
                if (param && param.vol !== undefined) {
                    WNP.r.devVol.innerText = param.vol;
                }
                break;
            case msg.startsWith("setPlayerCmd:vol:") ? msg : false:
                // Volume set response
                socket.emit("device-api", "getPlayerStatus"); // Refresh volume UI
                break;
            default:
                // No action
                break;
        }
    });

    // On server reboot
    socket.on("server-reboot", function (msg) {
        // Possibly show a notification that reboot is in progress
        console.log("WNP", "Server reboot:", msg);
    });

    // On server update
    socket.on("server-update", function (msg) {
        // Possibly show a notification that update is in progress
        console.log("WNP", "Server update:", msg);
    });

    // On server shutdown
    socket.on("server-shutdown", function (msg) {
        // Possibly show a notification that shutdown is in progress
        console.log("WNP", "Server shutdown:", msg);
    });

};

WNP.hideSleepTimerModal = function () {
    if (!WNP.r.sleepTimerModal || !window.bootstrap || !bootstrap.Modal) {
        return;
    }
    var modalInstance = bootstrap.Modal.getInstance(WNP.r.sleepTimerModal);
    if (modalInstance) {
        modalInstance.hide();
    }
};

WNP.setSleepTimerState = function (state) {
    if (state && typeof state === "object") {
        WNP.d.sleepTimerState = state;
    } else {
        WNP.d.sleepTimerState = {
            active: false,
            mode: null,
            targetTimeStamp: null,
            durationMinutes: null
        };
    }
    WNP.updateSleepTimerButton();
};

WNP.getSleepTimerRemainingMs = function () {
    if (!WNP.d.sleepTimerState || !WNP.d.sleepTimerState.active) {
        return 0;
    }
    if (WNP.d.sleepTimerState.mode === "song-end") {
        return null;
    }
    var targetTimeStamp = Number(WNP.d.sleepTimerState.targetTimeStamp || 0);
    if (!targetTimeStamp) {
        return 0;
    }
    return Math.max(0, targetTimeStamp - Date.now());
};

WNP.formatRemainingTimer = function (remainingMs) {
    if (remainingMs === null) {
        return "Song";
    }
    var totalSeconds = Math.ceil(remainingMs / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
};

WNP.updateSleepTimerButton = function () {
    if (!WNP.r.btnSleepTimer) {
        WNP.updateSleepTimerOverlay();
        return;
    }
    if (!WNP.d.sleepTimerState || !WNP.d.sleepTimerState.active) {
        WNP.r.btnSleepTimer.setAttribute("data-bs-toggle", "modal");
        WNP.r.btnSleepTimer.setAttribute("data-bs-target", "#sleepTimerModal");
        WNP.r.btnSleepTimer.innerHTML = "<i class=\"bi bi-clock\"></i>";
        WNP.r.btnSleepTimer.title = "Set sleep timer";
        WNP.r.btnSleepTimer.classList.remove("is-active");
        WNP.updateSleepTimerOverlay();
        return;
    }

    WNP.r.btnSleepTimer.removeAttribute("data-bs-toggle");
    WNP.r.btnSleepTimer.removeAttribute("data-bs-target");
    var remainingMs = WNP.getSleepTimerRemainingMs();
    var remainingLabel = WNP.formatRemainingTimer(remainingMs);
    WNP.r.btnSleepTimer.innerHTML = "<i class=\"bi bi-clock-history\"></i> <span>" + remainingLabel + "</span>";
    WNP.r.btnSleepTimer.title = "Sleep timer active. Click to abort the timer.";
    WNP.r.btnSleepTimer.classList.add("is-active");
    WNP.updateSleepTimerOverlay();
};

WNP.updateSleepTimerOverlay = function () {
    if (!WNP.r.sleepTimerOverlay) {
        return;
    }
    if (!WNP.d.sleepTimerState || !WNP.d.sleepTimerState.active) {
        WNP.r.sleepTimerOverlay.classList.remove("is-visible");
        WNP.r.sleepTimerOverlay.innerHTML = "";
        return;
    }
    var remainingMs = WNP.getSleepTimerRemainingMs();
    if (remainingMs === null) {
        WNP.r.sleepTimerOverlay.innerHTML = "<i class=\"bi bi-clock-history\"></i><span>Song end</span>";
    } else {
        WNP.r.sleepTimerOverlay.innerHTML = "<i class=\"bi bi-clock-history\"></i><span>" + WNP.formatRemainingTimer(remainingMs) + "</span>";
    }
    WNP.r.sleepTimerOverlay.classList.add("is-visible");
};

// =======================================================
// Helper functions

/**
 * Set device according to the chosen one through the Device dropup.
 * @param {string} deviceLocation - The location of the device to set.
 * @return {undefined}
  */
WNP.setDeviceByLocation = function (deviceLocation) {
    if (deviceLocation) {
        socket.emit("device-set", deviceLocation);
    }
    return false;
};

/**
 * Set the preset on the device.
 * @param {integer} presetNumber - The number of the preset to set.
 * @return {undefined}
 */

WNP.setPresetByNumber = function (presetNumber) {
    if (presetNumber && !isNaN(presetNumber) && presetNumber > 0) {
        socket.emit("device-api", "MCUKeyShortClick:" + presetNumber);
    }
    return false;
};

/**
 * Get player progress helper.
 * @param {string} relTime - Time elapsed while playing, format 00:00:00
 * @param {string} trackDuration - Total play time, format 00:00:00
 * @param {integer} timeStampDiff - Possible play time offset in seconds
 * @param {string} currentTransportState - The current transport state "PLAYING" or otherwise
 * @returns {object} An object with corrected played, left, total and percentage played
 */
WNP.getPlayerProgress = function (relTime, trackDuration, timeStampDiff, currentTransportState) {
    var relTimeSec = this.convertToSeconds(relTime) + timeStampDiff;
    var trackDurationSec = this.convertToSeconds(trackDuration);
    if (trackDurationSec > 0 && relTimeSec < trackDurationSec) {
        var percentPlayed = ((relTimeSec / trackDurationSec) * 100).toFixed(1);
        return {
            played: WNP.convertToMinutes(relTimeSec),
            left: WNP.convertToMinutes(trackDurationSec - relTimeSec),
            total: WNP.convertToMinutes(trackDurationSec),
            percent: percentPlayed
        };
    }
    else if (trackDurationSec == 0 && currentTransportState == "PLAYING") {
        return {
            played: "Live",
            left: "",
            total: "",
            percent: 100
        };
    }
    else {
        return {
            played: "Paused",
            left: "",
            total: "",
            percent: 0
        };
    };
};

/**
 * Convert time format '00:00:00' to total number of seconds.
 * @param {string} sDuration - Time, format 00:00:00.
 * @returns {integer} The number of seconds that the string represents.
 */
WNP.convertToSeconds = function (sDuration) {
    const timeSections = sDuration.split(":");
    let totalSeconds = 0;
    for (let i = 0; i < timeSections.length; i++) {
        var nFactor = timeSections.length - 1 - i; // Count backwards
        var nMultiplier = Math.pow(60, nFactor); // 60^n
        totalSeconds += nMultiplier * parseInt(timeSections[i]); // Calculate the seconds
    }
    return totalSeconds
};

/**
 * Convert number of seconds to '00:00' string format. 
 * Sorry for those hour+ long songs...
 * @param {integer} seconds - Number of seconds total.
 * @returns {string} The string representation of seconds in minutes, format 00:00.
 */
WNP.convertToMinutes = function (seconds) {
    var tempDate = new Date(0);
    tempDate.setSeconds(seconds);
    var result = tempDate.toISOString().substring(14, 19);
    return result;
};

/**
 * Parse synced lyrics (LRC format) into timestamps.
 * @param {string} syncedLyrics - LRC formatted lyrics string.
 * @returns {array} Array of lyric lines with time in ms.
 */
WNP.parseSyncedLyrics = function (syncedLyrics) {
    if (!syncedLyrics) {
        return [];
    }
    const lines = syncedLyrics.split(/\r?\n/);
    const parsed = [];
    const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

    lines.forEach((line) => {
        let match;
        const text = line.replace(timeRegex, "").trim();
        while ((match = timeRegex.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const fraction = match[3] ? match[3].padEnd(3, "0") : "000";
            const millis = (minutes * 60 + seconds) * 1000 + parseInt(fraction, 10);
            parsed.push({
                timeMs: millis,
                text: text
            });
        }
    });

    return parsed
        .filter((entry) => entry.text !== "")
        .sort((a, b) => a.timeMs - b.timeMs);
};

WNP.getLyricsGapSettings = function () {
    var lyricsSettings = WNP.d.serverSettings && WNP.d.serverSettings.features && WNP.d.serverSettings.features.lyrics
        ? WNP.d.serverSettings.features.lyrics
        : {};
    var mediumGapSec = (typeof lyricsSettings.mediumGapSec === "number") ? lyricsSettings.mediumGapSec : 10;
    var longGapSec = (typeof lyricsSettings.longGapSec === "number") ? lyricsSettings.longGapSec : 20;

    mediumGapSec = Math.max(10, Math.round(mediumGapSec));
    longGapSec = Math.max(16, Math.round(longGapSec));
    if (longGapSec <= mediumGapSec) {
        longGapSec = mediumGapSec + 1;
    }

    return {
        mediumGapMs: mediumGapSec * 1000,
        longGapMs: longGapSec * 1000,
        introShiftMs: 3000,
        outroShiftMs: 3000,
        noteSymbol: "♪"
    };
};

WNP.buildDisplayLyricsLines = function (lyricsLines, trackDurationSec) {
    if (!lyricsLines || lyricsLines.length === 0) {
        return [];
    }

    var settings = WNP.getLyricsGapSettings();
    var displayLines = lyricsLines.map(function (line) {
        return {
            timeMs: line.timeMs,
            text: line.text,
            suppressPrevOnActivate: false
        };
    });

    var timelineLines = displayLines.slice();
    var durationMs = (typeof trackDurationSec === "number" && Number.isFinite(trackDurationSec) && trackDurationSec > 0)
        ? Math.round(trackDurationSec * 1000)
        : null;

    if (durationMs !== null) {
        var lastLine = timelineLines[timelineLines.length - 1];
        if (lastLine && durationMs > lastLine.timeMs && (durationMs - lastLine.timeMs) >= settings.mediumGapMs) {
            timelineLines.push({
                timeMs: durationMs,
                text: "",
                suppressPrevOnActivate: false
            });
        }
    }

    for (let i = 0; i < timelineLines.length - 1; i++) {
        var line = timelineLines[i];
        var nextLine = timelineLines[i + 1];

        var gapMs = nextLine.timeMs - line.timeMs;
        if (gapMs < settings.mediumGapMs) {
            continue;
        }

        var noteTimeMs = line.timeMs + settings.mediumGapMs;
        if (noteTimeMs >= nextLine.timeMs) {
            continue;
        }

        var noteEntry = {
            timeMs: noteTimeMs,
            text: settings.noteSymbol,
            isGapNote: true
        };

        if (gapMs >= settings.longGapMs) {
            noteEntry.isLongGapNote = true;
            noteEntry.longGapOriginalMs = gapMs;
        }

        displayLines.push(noteEntry);

    }

    return displayLines.sort((a, b) => a.timeMs - b.timeMs);
};

WNP.getLongGapDisplayState = function (currentMs, currentIndex) {
    var currentLineObj = WNP.d.lyricsLines[currentIndex];
    var prevLineObj = currentIndex > 0 ? WNP.d.lyricsLines[currentIndex - 1] : null;
    var nextLineObj = WNP.d.lyricsLines[currentIndex + 1] || null;
    var settings = WNP.getLyricsGapSettings();

    if (currentLineObj && currentLineObj.isLongGapNote && !nextLineObj) {
        var durationMs = (typeof WNP.d.currentTrackDurationSec === "number" && Number.isFinite(WNP.d.currentTrackDurationSec) && WNP.d.currentTrackDurationSec > 0)
            ? Math.round(WNP.d.currentTrackDurationSec * 1000)
            : null;
        var remainingGapMs = (typeof currentLineObj.longGapOriginalMs === "number" && Number.isFinite(currentLineObj.longGapOriginalMs))
            ? Math.max(settings.longGapMs, currentLineObj.longGapOriginalMs - settings.mediumGapMs)
            : settings.longGapMs;
        var fallbackNextTimeMs = durationMs && durationMs > currentLineObj.timeMs
            ? durationMs
            : (currentLineObj.timeMs + remainingGapMs);

        nextLineObj = {
            timeMs: fallbackNextTimeMs,
            text: "",
            suppressPrevOnActivate: false
        };
    }

    var defaultPrev = currentLineObj && currentLineObj.suppressPrevOnActivate
        ? ""
        : (prevLineObj ? prevLineObj.text : "");

    var defaultState = {
        mode: "normal",
        prevLine: defaultPrev,
        currentLine: currentLineObj ? currentLineObj.text : "",
        nextLine: nextLineObj ? nextLineObj.text : "",
        pending: false
    };

    if (!currentLineObj || !currentLineObj.isLongGapNote || !nextLineObj) {
        return defaultState;
    }

    var clearPrevAtMs = currentLineObj.timeMs + settings.outroShiftMs;
    var preloadCurrentAtMs = Math.max(currentLineObj.timeMs, nextLineObj.timeMs - settings.introShiftMs);

    if (currentMs < clearPrevAtMs) {
        return {
            mode: "long-phase-a",
            prevLine: prevLineObj ? prevLineObj.text : "",
            currentLine: currentLineObj.text,
            nextLine: nextLineObj.text,
            pending: false
        };
    }

    if (currentMs < preloadCurrentAtMs) {
        return {
            mode: "long-phase-b",
            prevLine: "",
            currentLine: currentLineObj.text,
            nextLine: nextLineObj.text,
            pending: false
        };
    }

    var phaseCNextLine = WNP.d.lyricsLines[currentIndex + 2] ? WNP.d.lyricsLines[currentIndex + 2].text : "";

    return {
        mode: "long-phase-c",
        prevLine: currentLineObj.text,
        currentLine: nextLineObj.text,
        nextLine: phaseCNextLine,
        pending: true,
        upcomingIndex: currentIndex + 1
    };
};

WNP.normalizeLyricsText = function (value) {
    if (!value) {
        return "";
    }
    return value
        .toString()
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/&/g, " and ")
        .replace(/feat\.?/g, " ")
        .replace(/ft\.?/g, " ")
        .replace(/[-–—]/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};

WNP.normalizeLyricsAlbum = function (value) {
    if (!value) {
        return "";
    }
    return value
        .toString()
        .toLowerCase()
        .replace(/[\[\]()]/g, " ")
        .replace(/&/g, " and ")
        .replace(/feat\.?/g, " ")
        .replace(/ft\.?/g, " ")
        .replace(/[-–—:]/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\b(deluxe|edition|remaster(ed)?|expanded|bonus|anniversary|live|acoustic|mono|stereo|version)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

WNP.normalizeLyricsDurationForKey = function (duration) {
    if (duration === null || duration === undefined) {
        return "";
    }
    if (typeof duration === "number" && Number.isFinite(duration)) {
        return Math.round(duration);
    }
    return duration;
};

WNP.parseDurationToSeconds = function (duration) {
    if (!duration) {
        return null;
    }
    if (typeof duration === "number" && Number.isFinite(duration)) {
        return Math.round(duration);
    }
    var parts = duration.toString().split(":").map((item) => parseInt(item, 10));
    if (parts.some((item) => Number.isNaN(item))) {
        return null;
    }
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return null;
};

WNP.buildLyricsTrackKey = function (trackName, artistName, albumName, duration) {
    return [
        WNP.normalizeLyricsText(trackName),
        WNP.normalizeLyricsText(artistName),
        WNP.normalizeLyricsAlbum(albumName),
        WNP.normalizeLyricsDurationForKey(duration)
    ].join("|");
};

WNP.activateLyricsForTrackStart = function (relTime, timeStampDiff) {
    if (!WNP.d.pendingLyricsLines || WNP.d.pendingLyricsLines.length === 0) {
        return;
    }
    WNP.d.lyricsLines = WNP.d.pendingLyricsLines;
    WNP.d.pendingLyricsLines = [];
    WNP.d.currentLyricsTrackKey = WNP.d.pendingLyricsTrackKey;
    WNP.d.pendingLyricsTrackKey = null;
    WNP.d.lyricsIndex = null;
    WNP.d.lyricsLongGapContextIndex = null;
    if (WNP.r.lyricsContainer) {
        WNP.r.lyricsContainer.classList.add("is-visible");
    }
    WNP.setLyricsPending(true);
    WNP.setLyricsLines(
        "",
        WNP.d.lyricsLines[0] ? WNP.d.lyricsLines[0].text : "",
        WNP.d.lyricsLines[1] ? WNP.d.lyricsLines[1].text : ""
    );
    WNP.d.waitingForSongStart = false;
    WNP.updateLyricsProgress(relTime, timeStampDiff);
};

WNP.isInSongSwitchGuardWindow = function () {
    if (!WNP.d.recentSongSwitchAtMs) {
        return false;
    }
    return (Date.now() - WNP.d.recentSongSwitchAtMs) <= 3000;
};

WNP.isLyricsProgressTooFarAhead = function (relTime, timeStampDiff) {
    if (!WNP.isInSongSwitchGuardWindow()) {
        return false;
    }
    var relSeconds = WNP.convertToSeconds(relTime || "00:00:00");
    var offsetSeconds = timeStampDiff || 0;
    return (relSeconds + offsetSeconds) > 5;
};

WNP.shouldUseStateForCurrentTrack = function (stateMsg) {
    if (!stateMsg) {
        return false;
    }
    if (!WNP.d.currentTrackMetadataTimeStamp || !stateMsg.metadataTimeStamp) {
        return true;
    }
    return Number(stateMsg.metadataTimeStamp) === Number(WNP.d.currentTrackMetadataTimeStamp);
};

/**
 * Clear lyrics UI.
 * @returns {undefined}
 */
WNP.clearLyrics = function () {
    if (WNP.r.lyricsContainer) {
        WNP.r.lyricsContainer.classList.remove("is-visible");
        WNP.r.lyricsContainer.classList.remove("is-pending");
    }
    WNP.setLyricsLines("", "", "");
    WNP.d.lyricsLines = [];
    WNP.d.lyricsIndex = null;
    WNP.d.lyricsLongGapContextIndex = null;
    WNP.d.pendingLyricsLines = [];
    WNP.d.pendingLyricsTrackKey = null;
    WNP.d.waitingForSongStart = false;
};

WNP.fetchLyricsControlState = async function () {
    try {
        const response = await fetch("/api/lyrics-control-state");
        if (!response.ok) {
            return;
        }
        const state = await response.json();
        WNP.applyLyricsControlState(state);
    } catch (err) {
        console.log("WNP", "Lyrics control state fetch failed", err && err.message ? err.message : err);
    }
};

WNP.applyLyricsControlState = function (state) {
    WNP.d.lyricsControlState = state || null;

    var available = Boolean(state && state.available);
    var trackLocked = Boolean(state && state.trackLocked);
    var albumLocked = Boolean(state && state.albumLocked);

    if (WNP.r.btnLyricsLockTrack) {
        WNP.r.btnLyricsLockTrack.disabled = !available;
        WNP.r.btnLyricsLockTrack.classList.toggle("is-active", trackLocked);
        WNP.r.btnLyricsLockTrack.title = trackLocked
            ? "Unlock lyrics for this song"
            : "Lock lyrics for this song";
    }

    if (WNP.r.btnLyricsLockAlbum) {
        WNP.r.btnLyricsLockAlbum.disabled = !available;
        WNP.r.btnLyricsLockAlbum.classList.toggle("is-active", albumLocked);
        WNP.r.btnLyricsLockAlbum.title = albumLocked
            ? "Unlock lyrics for this album"
            : "Lock lyrics for this album";
    }

    if (WNP.r.btnLyricsSwitchAlternative) {
        WNP.r.btnLyricsSwitchAlternative.disabled = !available || trackLocked || albumLocked;
    }

    var lockedFromLyricsState = Boolean(WNP.d.lyrics && WNP.d.lyrics.status === "locked");
    var showQuickUnlock = trackLocked || lockedFromLyricsState;
    if (WNP.r.lyricsUnlockActions) {
        WNP.r.lyricsUnlockActions.classList.toggle("is-visible", showQuickUnlock);
    }

    if (WNP.r.btnLyricsUnlockTrackQuick) {
        WNP.r.btnLyricsUnlockTrackQuick.disabled = !showQuickUnlock;
    }

    if (WNP.r.btnLyricsUnlockAlbumQuick) {
        WNP.r.btnLyricsUnlockAlbumQuick.disabled = !(showQuickUnlock && available);
        WNP.r.btnLyricsUnlockAlbumQuick.title = albumLocked
            ? "Unlock lyrics for this album"
            : "Lock lyrics for this album";
    }
};

WNP.runLyricsControlAction = async function (action) {
    if (!action) {
        return;
    }

    var controls = [WNP.r.btnLyricsLockTrack, WNP.r.btnLyricsLockAlbum, WNP.r.btnLyricsSwitchAlternative, WNP.r.btnLyricsUnlockTrackQuick, WNP.r.btnLyricsUnlockAlbumQuick].filter(Boolean);
    controls.forEach(function (btn) { btn.disabled = true; });

    try {
        const response = await fetch("/api/lyrics-control", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ action: action })
        });
        if (!response.ok) {
            return;
        }
        const result = await response.json();
        if (result && result.controls) {
            WNP.applyLyricsControlState(result.controls);
        } else {
            WNP.fetchLyricsControlState();
        }
    } catch (err) {
        console.log("WNP", "Lyrics control action failed", err && err.message ? err.message : err);
    } finally {
        setTimeout(function () {
            WNP.fetchLyricsControlState();
        }, 300);
    }
};

/**
 * Toggle pending lyrics state.
 * @param {boolean} isPending - Whether lyrics are pending.
 * @returns {undefined}
 */
WNP.setLyricsPending = function (isPending) {
    if (!WNP.r.lyricsContainer) {
        return;
    }
    if (isPending) {
        WNP.r.lyricsContainer.classList.add("is-pending");
    } else {
        WNP.r.lyricsContainer.classList.remove("is-pending");
    }
};

/**
 * Update lyrics display based on player progress.
 * @param {string|null} relTime - Time elapsed while playing, format 00:00:00.
 * @param {integer} timeStampDiff - Possible play time offset in seconds.
 * @returns {undefined}
 */
WNP.updateLyricsProgress = function (relTime, timeStampDiff) {
    if (!WNP.d.lyricsLines || WNP.d.lyricsLines.length === 0) {
        return;
    }

    if (WNP.isLyricsProgressTooFarAhead(relTime, timeStampDiff)) {
        return;
    }

    var currentRelTime = relTime || (WNP.d.lastState && WNP.d.lastState.RelTime) || "00:00:00";
    var currentOffset = timeStampDiff || 0;
    var currentSeconds = WNP.convertToSeconds(currentRelTime) + currentOffset;
    var currentMs = currentSeconds * 1000 + WNP.getLyricsOffsetMs();

    var currentIndex = -1;
    for (let i = 0; i < WNP.d.lyricsLines.length; i++) {
        if (WNP.d.lyricsLines[i].timeMs <= currentMs) {
            currentIndex = i;
        } else {
            break;
        }
    }

    if (currentIndex === -1) {
        WNP.setLyricsPending(true);
        WNP.setLyricsLines(
            "",
            WNP.d.lyricsLines[0] ? WNP.d.lyricsLines[0].text : "",
            WNP.d.lyricsLines[1] ? WNP.d.lyricsLines[1].text : ""
        );
        WNP.d.lyricsIndex = -1;
        return;
    }

    var state = WNP.getLongGapDisplayState(currentMs, currentIndex);
    var activeIndex = (typeof state.upcomingIndex === "number") ? state.upcomingIndex : currentIndex;
    var wasPending = WNP.r.lyricsContainer ? WNP.r.lyricsContainer.classList.contains("is-pending") : false;
    var pendingChanged = wasPending !== Boolean(state.pending);
    WNP.setLyricsPending(Boolean(state.pending));

    if (WNP.d.lyricsIndex === activeIndex
        && WNP.r.lyricsPrev.innerText === (state.prevLine || "")
        && WNP.r.lyricsCurrent.innerText === (state.currentLine || "")
        && WNP.r.lyricsNext.innerText === (state.nextLine || "")
        && !pendingChanged) {
        return;
    }

    var nextPlusOneLine = WNP.d.lyricsLines[activeIndex + 2] ? WNP.d.lyricsLines[activeIndex + 2].text : "";

    WNP.d.lyricsIndex = activeIndex;
    WNP.d.lyricsLongGapContextIndex = currentIndex;
    WNP.setLyricsLines(state.prevLine, state.currentLine, state.nextLine, nextPlusOneLine);
};

/**
 * Update lyrics line text.
 * @param {string} prevLine - Previous line.
 * @param {string} currentLine - Current line.
 * @param {string} nextLine - Next line.
 * @param {string} nextPlusOneLine - Next+1 line (lookahead for repeated passages).
 * @returns {undefined}
 */
WNP.setLyricsLines = function (prevLine, currentLine, nextLine, nextPlusOneLine) {
    if (!WNP.r.lyricsPrev || !WNP.r.lyricsCurrent || !WNP.r.lyricsNext) {
        return;
    }
    var nextPrev = prevLine || "";
    var nextCurrent = currentLine || "";
    var nextNext = nextLine || "";
    var nextAfterNext = nextPlusOneLine || "";

    var sameContent = WNP.r.lyricsPrev.innerText === nextPrev
        && WNP.r.lyricsCurrent.innerText === nextCurrent
        && WNP.r.lyricsNext.innerText === nextNext;
    var isRepeatPassage = (nextNext !== "" && nextNext === nextCurrent)
        || (nextCurrent !== "" && nextCurrent === nextPrev)
        || (nextNext !== "" && nextNext === nextAfterNext);
    var shouldAnimate = !sameContent || isRepeatPassage;

    if (!shouldAnimate) {
        return;
    }

    if (WNP.d.lyricsTransitionTimer) {
        clearTimeout(WNP.d.lyricsTransitionTimer);
        WNP.d.lyricsTransitionTimer = null;
    }

    WNP.r.lyricsPrev.classList.add("is-transitioning");
    WNP.r.lyricsCurrent.classList.add("is-transitioning");
    WNP.r.lyricsNext.classList.add("is-transitioning");

    WNP.d.lyricsTransitionTimer = setTimeout(function () {
        WNP.r.lyricsPrev.innerText = nextPrev;
        WNP.r.lyricsCurrent.innerText = nextCurrent;
        WNP.r.lyricsNext.innerText = nextNext;

        WNP.r.lyricsPrev.classList.remove("is-transitioning");
        WNP.r.lyricsCurrent.classList.remove("is-transitioning");
        WNP.r.lyricsNext.classList.remove("is-transitioning");
        WNP.d.lyricsTransitionTimer = null;
    }, 70);
};

/**
 * Set compact media line values.
 * @param {HTMLElement} container - Container element for the line.
 * @param {HTMLElement} leftEl - Left text element.
 * @param {HTMLElement} rightEl - Right text element.
 * @param {HTMLElement} sepEl - Separator element.
 * @param {string} leftValue - Left text.
 * @param {string} rightValue - Right text.
 * @returns {undefined}
 */
WNP.setCompactLine = function (container, leftEl, rightEl, sepEl, leftValue, rightValue) {
    if (!container || !leftEl || !rightEl) {
        return;
    }
    leftEl.innerText = leftValue || "";
    rightEl.innerText = rightValue || "";
    var hasLeft = Boolean(leftValue);
    var hasRight = Boolean(rightValue);
    if (sepEl) {
        sepEl.style.display = (hasLeft && hasRight) ? "" : "none";
    }
    rightEl.style.display = hasRight ? "" : "none";
    container.style.display = (hasLeft || hasRight) ? "" : "none";
};

/**
 * Get lyrics offset (in ms) from server settings.
 * @returns {number}
 */
WNP.getLyricsOffsetMs = function () {
    if (WNP.d.serverSettings && WNP.d.serverSettings.features && WNP.d.serverSettings.features.lyrics && typeof WNP.d.serverSettings.features.lyrics.offsetMs === "number") {
        return WNP.d.serverSettings.features.lyrics.offsetMs;
    }
    return 0;
};

/**
 * Set a cookie with optional expiration in days.
 * @param {string} name - Cookie name.
 * @param {string|boolean|number} value - Cookie value.
 * @param {number} days - Days until expiration.
 * @returns {undefined}
 */
WNP.setCookie = function (name, value, days) {
    var expires = "";
    if (typeof days === "number") {
        var date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(String(value)) + expires + "; path=/";
};

/**
 * Get a cookie by name.
 * @param {string} name - Cookie name.
 * @returns {string|null}
 */
WNP.getCookie = function (name) {
    var nameEQ = name + "=";
    var ca = document.cookie.split(";");
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i].trim();
        if (c.indexOf(nameEQ) === 0) {
            return decodeURIComponent(c.substring(nameEQ.length, c.length));
        }
    }
    return null;
};

WNP.logCover = function (message, payload) {
    if (typeof payload === "undefined") {
        console.log("WNP", "[cover]", message);
        return;
    }
    console.log("WNP", "[cover]", message, payload);
};

WNP.buildResolvedCoverUri = function (cacheKey) {
    if (!cacheKey) {
        return WNP.s.rndAlbumArtUri;
    }
    if (WNP.s.locPort != "80") {
        return "http://" + WNP.s.locHostname + ":" + WNP.s.locPort + "/cover-art/" + encodeURIComponent(cacheKey);
    }
    return "http://" + WNP.s.locHostname + "/cover-art/" + encodeURIComponent(cacheKey);
};

WNP.normalizeUri = function (uri) {
    try {
        return new URL(uri, window.location.href).href;
    } catch {
        return uri;
    }
};

WNP.normalizeCoverUri = function (uri) {
    var normalized = WNP.normalizeUri(uri);
    try {
        var parsed = new URL(normalized);
        if (parsed.pathname === "/proxy-art") {
            parsed.searchParams.delete("ts");
            return parsed.toString();
        }
    } catch {
        return normalized;
    }
    return normalized;
};

WNP.trySetTrackCover = function (imgUri, source) {
    WNP.d.pendingTrackCoverUri = WNP.normalizeCoverUri(imgUri);
    WNP.d.pendingTrackCoverSource = source || null;
    if (WNP.d.pendingTrackCoverSource === "resolved") {
        console.log("WNP", "Fallback cover applied", {
            imgUri: imgUri,
            trackKey: WNP.d.currentTrackKey
        });
    }
    WNP.setAlbumArt(imgUri);
};

/**
 * Check if the album art is a valid URI. Returns the URI if valid, otherwise a random URI.
 * Error handling is handled by the onerror event on the image itself.
 * @param {string} sAlbumArtUri - The URI of the album art.
 * @param {integer} nTimestamp - The time in milliseconds, used as cache buster.
 * @returns {string} The URI of the album art.
 */
WNP.checkAlbumArtURI = function (sAlbumArtUri, nTimestamp) {
    // If the URI starts with https, the self signed certificate may not trusted by the browser.
    // Hence we always try and load the image through a reverse proxy, ignoring the certificate.
    if (sAlbumArtUri && sAlbumArtUri.startsWith("https")) {
        var sAlbumArtProxyUri = "";
        if (WNP.s.locPort != "80") { // If the server is not running on port 80, we need to add the port to the URI
            sAlbumArtProxyUri = "http://" + WNP.s.locHostname + ":" + WNP.s.locPort + "/proxy-art?url=" + encodeURIComponent(sAlbumArtUri) + "&ts=" + nTimestamp; // Use the current timestamp as cache buster
        } else {
            sAlbumArtProxyUri = "http://" + WNP.s.locHostname + "/proxy-art?url=" + encodeURIComponent(sAlbumArtUri) + "&ts=" + nTimestamp; // Use the current timestamp as cache buster
        }
        return sAlbumArtProxyUri;
    } else if (sAlbumArtUri && sAlbumArtUri.startsWith("http")) {
        return sAlbumArtUri;
    } else {
        // Looks like an invalid/un_known album art, use the fallback.
        return WNP.s.rndAlbumArtUri;
    }
};

/**
 * Sets the album art. Both on the foreground and background.
 * @param {integer} imgUri - The URI of the album art.
 * @returns {undefined}
 */
WNP.setAlbumArt = function (imgUri) {
    if (WNP.r.albumArt && WNP.normalizeCoverUri(WNP.r.albumArt.src) === WNP.normalizeCoverUri(imgUri)) {
        WNP.logCover("setAlbumArt skipped (same uri)", {
            imgUri: imgUri,
            trackKey: WNP.d.currentTrackKey,
            source: WNP.d.pendingTrackCoverSource || WNP.d.currentTrackCoverSource || null
        });
        return;
    }
    console.log("WNP", "Set Album Art", imgUri);
    this.r.albumArt.src = imgUri;
    this.r.bgAlbumArtBlur.style.backgroundImage = "url('" + imgUri + "')";
};

/**
 * Come up with a random album art URI (locally from the img folder).
 * @param {string} prefix - The prefix for the album art URI, i.e. 'fake-album-'
 * @returns {string} An URI for album art
 */
WNP.rndAlbumArt = function (prefix) {
    return "./img/" + prefix + this.rndNumber(1, 16) + ".jpg";
};

/**
 * Get a random number between min and max, including min and max.
 * @param {integer} min - Minimum number to pick, keep it lower than max.
 * @param {integer} max - Maximum number to pick.
 * @returns {integer} The random number
 */
WNP.rndNumber = function (min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

/**
 * Get an identifier for the current play medium combined with the tracksource.
 * TODO: Verify all/most sources...
 * @param {string} playMedium - The PlayMedium as indicated by the device. Values: SONGLIST-NETWORK, RADIO-NETWORK, STATION-NETWORK, CAST, AIRPLAY, SPOTIFY, UNKOWN
 * @param {string} trackSource - The stream source as indicated by the device. Values: Prime, Qobuz, SPOTIFY, newTuneIn, iHeartRadio, Deezer, UPnPServer, Tidal, vTuner
 * @returns {string} The uri to the source identifier (image url)
 */
WNP.getSourceIdent = function (playMedium, trackSource) {

    var sIdentUri = "";

    switch (playMedium.toLowerCase()) {
        case "airplay":
            sIdentUri = "./img/sources/airplay2.png";
            break;
        case "third-dlna":
            sIdentUri = "./img/sources/dlna2.png";
            break;
        case "cast":
            sIdentUri = "./img/sources/chromecast2.png";
            break;
        case "radio-network":
            sIdentUri = "./img/sources/radio.png";
            break;
        case "songlist-network":
            sIdentUri = "./img/sources/ethernet2.png";
            break;
        case "spotify":
            sIdentUri = "./img/sources/spotify.png";
            break;
        case "squeezelite":
            sIdentUri = "./img/sources/music-assistant2.png";
            break;
        case "none":
            sIdentUri = "./img/sources/none2.png";
            break;
        case "bluetooth":
            sIdentUri = "./img/sources/bluetooth2.png";
            break;
        case "hdmi":
            sIdentUri = "./img/sources/hdmi2.png";
            break;
        case "line-in":
            sIdentUri = "./img/sources/line-in2.png";
            break;
        case "optical":
            sIdentUri = "./img/sources/spdif2.png";
            break;
    };

    switch (trackSource.toLowerCase()) {
        case "deezer":
        case "deezer2":
            sIdentUri = "./img/sources/deezer.png";
            break;
        case "iheartradio":
            sIdentUri = "./img/sources/iheart.png";
            break;
        case "newtunein":
            sIdentUri = "./img/sources/newtunein.png";
            break;
        case "plex":
            sIdentUri = "./img/sources/plex.png";
            break;
        case "prime":
            sIdentUri = "./img/sources/amazon-music2.png";
            break;
        case "qobuz":
            sIdentUri = "./img/sources/qobuz2.png";
            break;
        case "tidal":
            sIdentUri = "./img/sources/tidal2.png";
            break;
        case "upnpserver":
            sIdentUri = "./img/sources/dlna2.png";
            break;
        case "vtuner":
            sIdentUri = "./img/sources/vtuner2.png";
            break;
    };

    return sIdentUri;

};

/**
 * Get an identifier for the current audio/song quality.
 * TODO: Verify all/most sources...
 * Found so far:
 * 
 * CD Quality: 44.1 KHz/16 bit. Bitrate 1,411 kbps. For mp3 bitrate can vary, but also be 320/192/160/128/... kbps.
 * Hi-Res quality: 96 kHz/24 bit and up. Bitrate 9,216 kbps.
 * 
 * Spotify Lossless: bitrate 700 kbps, 44.1 kHz/24 bit
 * Spotify and Pandora usual bitrate 160 kbps, premium is 320 kbps
 * Tidal has CD quality, and FLAC, MQA, Master, ...
 * Qobuz apparently really has hi-res?
 * Amazon Music (Unlimited) does Atmos?
 * Apple Music -> Airplay 2, does hi-res?
 * YouTube Music -> Cast, does what?
 * 
 * TIDAL -
 * Sample High: "song:quality":"2","song:actualQuality":"LOSSLESS"
 * Sample MQA: "song:quality":"3","song:actualQuality":"HI_RES"
 * Sample FLAC: "song:quality":"4","song:actualQuality":"HI_RES_LOSSLESS"
 * 
 * @param {integer} songQuality - A number identifying the quality, as indicated by the streaming service(?).
 * @param {string} songActualQuality - An indicator for the actual quality, as indicated by the streaming service(?).
 * @param {integer} songBitrate - The current bitrate in kilobit per second.
 * @param {integer} songBitDepth - The current sample depth in bits.
 * @param {integer} songSampleRate - The current sample rate in Hz.
 * @returns {string} The identifier for the audio quality, just a string.
 */
WNP.getQualityIdent = function (songQuality, songActualQuality, songBitrate, songBitDepth, songSampleRate) {
    // console.log(songQuality, songActualQuality, songBitrate, songBitDepth, songSampleRate);

    var sIdent = "";

    if (songBitrate >= 700 && songBitDepth == 24 && songSampleRate == 44100) {
        sIdent = "Lossless";
    }
    if (songBitrate > 1000 && songBitDepth == 16 && songSampleRate == 44100) {
        sIdent = "CD";
    }
    else if (songBitrate > 7000 && songBitDepth >= 24 && songSampleRate >= 96000) {
        sIdent = "Hi-Res";
    }

    // Based of Tidal/Amazon Music Unlimited/Deezer/Qobuz
    switch (songQuality + ":" + songActualQuality) {
        case "2:LOSSLESS": // Tidal
        case ":LOSSLESS": // Tidal
            sIdent = "HIGH";
            break;
        case "3:HI_RES": // Tidal
            sIdent = "MQA";
            break;
        case "4:HI_RES_LOSSLESS": // Tidal
        case ":HI_RES_LOSSLESS": // Tidal
        case "0:LOSSLESS": // Deezer
            sIdent = "FLAC";
            break;
        case ":UHD": // Amazon Music
            sIdent = "ULTRA HD";
            break;
        case ":HD":
            sIdent = "HD"; // Amazon Music
            break;
        case "3:7":
        case "4:27":
            sIdent = "Hi-Res"; // Qobuz
            break;
        case "2:6":
            sIdent = "CD"; // Qobuz
            break;
    };

    return sIdent;

};

// =======================================================
// Start WiiM Now Playing app
WNP.Init();

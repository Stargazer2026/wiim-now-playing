# REST Interface (Remote Control)

These REST endpoints allow for simple control of the currently selected WiiM/Linkplay device via HTTP `GET`.

## Base URL

By default, the server runs on port `80`:

- Local: `http://localhost`
- In the network: `http://<server-ip-or-hostname>`

## Overview of Endpoints

| Function | Method | URL | Description |
|---|---|---|---|
| Play/Pause Toggle | `GET` | `/api/remote/play-pause-toggle` | Toggles between `Play` and `Pause` (depending on the current transport status). |
| Forward | `GET` | `/api/remote/forward` | Skips to the next track (`Next`). |
| Backward | `GET` | `/api/remote/backward` | Skips to the previous track (`Previous`). |
| Volume Up (relative) | `GET` | `/api/remote/volume-up?delta=:n` | Increases the volume relatively by `:n` (default: `5`, if `delta` is missing). |
| Volume Down (relative) | `GET` | `/api/remote/volume-down?delta=:n` | Decreases the volume relatively by `:n` (default: `5`, if `delta` is missing). |
| Start Preset/Playlist #n | `GET` | `/api/remote/preset/:id` | Starts preset/playlist with numeric ID `:id` (e.g., `3`). |

## Responses (JSON)

On success:

```json
{
  "ok": true
}
```

Depending on the endpoint, the response may contain additional fields such as `action`, `command`, or `presetId`.

Typical errors:

- `400 invalid-preset-id`: Preset ID is not valid.
- `400 invalid-delta`: `delta` is not valid (must be a whole number `> 0`).
- `409 no-device-selected`: No target device is selected.
- `409 action-not-supported`: The selected device does not support the requested action.
- `409 volume-unavailable`: Current volume is not yet available (e.g., immediately after startup/device change).

## Example Commands with cURL

> Note: If your server is not running on port 80, append the port to the URL (e.g., `:8080`).

### 1) Toggle Play/Pause

```bash
curl -X GET "http://localhost/api/remote/play-pause-toggle"
```

### 2) Next Track (Forward)

```bash
curl -X GET "http://localhost/api/remote/forward"
```

### 3) Previous Track (Backward)

```bash
curl -X GET "http://localhost/api/remote/backward"
```

### 4) Start Preset/Playlist with ID 2

```bash
curl -X GET "http://localhost/api/remote/preset/2"
```

### 5) Volume Up (Default Increment `5`)

```bash
curl -X GET "http://localhost/api/remote/volume-up"
```

### 6) Volume Down by `10`

```bash
curl -X GET "http://localhost/api/remote/volume-down?delta=10"
```

### 7) Start Preset/Playlist with Variable ID (Shell Variable)

```bash
PRESET_ID=5
curl -X GET "http://localhost/api/remote/preset/${PRESET_ID}"
```

# REST-Schnittstelle (Remote-Steuerung)

Diese REST-Endpunkte ermöglichen eine einfache Steuerung des aktuell gewählten WiiM/Linkplay-Geräts per HTTP `GET`.

## Basis-URL

Standardmäßig läuft der Server auf Port `80`:

- Lokal: `http://localhost`
- Im Netzwerk: `http://<server-ip-oder-hostname>`

## Übersicht der Endpunkte

| Funktion | Methode | URL | Beschreibung |
|---|---|---|---|
| Play/Pause Toggle | `GET` | `/api/remote/play-pause-toggle` | Schaltet zwischen `Play` und `Pause` um (abhängig vom aktuellen Transport-Status). |
| Vorwärts | `GET` | `/api/remote/forward` | Springt zum nächsten Titel (`Next`). |
| Rückwärts | `GET` | `/api/remote/backward` | Springt zum vorherigen Titel (`Previous`). |
| Preset/Playlist #n starten | `GET` | `/api/remote/preset/:id` | Startet Preset/Playlist mit numerischer ID `:id` (z. B. `3`). |

## Antworten (JSON)

Bei Erfolg:

```json
{
  "ok": true
}
```

Je nach Endpunkt enthält die Antwort zusätzliche Felder wie `action`, `command` oder `presetId`.

Typische Fehler:

- `400 invalid-preset-id`: Preset-ID ist nicht gültig.
- `409 no-device-selected`: Es ist kein Zielgerät ausgewählt.
- `409 action-not-supported`: Das ausgewählte Gerät unterstützt die angeforderte Aktion nicht.

## Fertige Beispiele mit Carl (cURL)

> Hinweis: Falls dein Server nicht auf Port 80 läuft, ergänze den Port in der URL (z. B. `:8080`).

### 1) Play/Pause umschalten

```bash
curl -X GET "http://localhost/api/remote/play-pause-toggle"
```

### 2) Nächster Titel (Vorwärts)

```bash
curl -X GET "http://localhost/api/remote/forward"
```

### 3) Vorheriger Titel (Rückwärts)

```bash
curl -X GET "http://localhost/api/remote/backward"
```

### 4) Preset/Playlist mit ID 2 starten

```bash
curl -X GET "http://localhost/api/remote/preset/2"
```

### 5) Preset/Playlist mit variabler ID starten (Shell-Variable)

```bash
PRESET_ID=5
curl -X GET "http://localhost/api/remote/preset/${PRESET_ID}"
```

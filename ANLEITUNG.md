# StarHit – Einrichtung

Songs hören, auf dem eigenen Zeitstrahl einordnen, wer zuerst X Karten hat, gewinnt.
Die App ist eine reine Webseite (HTML/JS). **Kein Server, keine Datenbank, keine Domain nötig.**

## Was du brauchst

| | Nötig? |
|---|---|
| Spotify **Premium** (für dich als Spielleiter) | Ja – Spotify erlaubt Wiedergabe-Steuerung nur mit Premium, und seit 2026 braucht auch der Besitzer einer Entwickler-App Premium |
| Spotify-Entwickler-App (kostenlos) | Ja, einmalig anlegen |
| Hosting mit HTTPS | Ja, aber kostenlos (GitHub Pages, Netlify, Cloudflare Pages) |
| Eigener Server | Nein |
| Eigene Domain | Nein (optional, rein kosmetisch) |
| Spotify-Konto für Mitspieler | Nein – sie spielen an deinem Handy mit |

## 1. Spotify-Entwickler-App anlegen (5 Minuten)

1. <https://developer.spotify.com/dashboard> öffnen, mit deinem Spotify-Konto einloggen.
2. **Create app**: Name z. B. „StarHit“, Beschreibung egal.
3. **Redirect URIs**: die Adresse, unter der die App später läuft, exakt mit `/` am Ende, z. B.
   `https://starhit2811.github.io/StarHit/`
   Zum lokalen Testen zusätzlich: `http://127.0.0.1:8765/`
   (Spotify akzeptiert nur HTTPS oder `127.0.0.1`, nicht `localhost`.)
4. Bei „Which API/SDKs“: **Web API** anhaken. Speichern.
5. **Client ID** kopieren und in [config.js](config.js) eintragen (die ist nicht geheim).

## 2. Online stellen (kostenlos)

**GitHub Pages** (dauerhaft, empfohlen):
1. Kostenloses Konto auf github.com, neues **öffentliches** Repository `StarHit`.
2. „Add file → Upload files“: alle Dateien aus diesem Ordner hochladen.
3. Settings → Pages → Source: „Deploy from a branch“, Branch `main`, Ordner `/ (root)`.
4. Nach ~1 Minute läuft die App unter `https://starhit2811.github.io/StarHit/`.

Alternative: **Netlify** (netlify.com → „Add new site → Deploy manually“ → Ordner reinziehen). Dann die Netlify-Adresse als Redirect-URI eintragen.

## 3. Spielen

1. App am Handy öffnen → **Mit Spotify verbinden**.
2. Playlist wählen oder Link einfügen. Wichtig: Seit 2026 dürfen Apps nur **eigene oder kollaborative** Playlists lesen. Fremde Playlist? In Spotify alle Songs markieren → „Zu Playlist hinzufügen“ → neue eigene Playlist.
3. Unter **Songs** die mit ⚠ markierten Jahreszahlen prüfen (Spotify liefert das Album-Jahr; bei Best-ofs/Remasters ist das falsch). Korrekturen bleiben gespeichert.
4. **Spotify-App einmal öffnen** (damit sie als Gerät erreichbar ist), zurück in den Browser, Namen eintragen, los.
5. Tipp: Bluetooth-Box verbinden. Achtung: Sperrbildschirm/Benachrichtigung von Spotify zeigt den Titel – Handy mit Display nach unten hinlegen.

Playlist ändern = einfach in Spotify Songs hinzufügen/löschen, dann in der App auf ↻ tippen.

## Freunde

- **Am selben Tisch:** Nur du meldest dich an, alle spielen an deinem Handy. Keine Begrenzung.
- **Freunde wollen selbst Spielleiter sein (eigenes Handy, eigene Playlist):** Im Developer-Dashboard unter *User Management* ihre Spotify-E-Mail eintragen. Spotify erlaubt im Entwicklermodus **max. 5 Konten** pro App, und sie brauchen ebenfalls Premium. Mehr Nutzer gibt es nur mit „Extended Quota“, was Spotify praktisch nur großen Firmen gewährt.
- Alternativ legt jede Person ihre **eigene** Spotify-Entwickler-App an und trägt ihre Client-ID in der App unter ⚙︎ ein – dieselbe Webseite funktioniert dann für alle.

## Lokal testen

```
python -m http.server 8765 --bind 127.0.0.1
```
im Ordner starten, dann <http://127.0.0.1:8765/> öffnen. Ohne Spotify: „Demo-Songs laden“.

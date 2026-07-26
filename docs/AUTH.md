# Benutzerverwaltung, Login, TOTP und Passkeys

Das Dashboard verwendet echte Benutzerkonten mit Passwort-Login statt eines
geteilten Admin-Tokens. Zusätzlich stehen zwei Zwei-Faktor-Methoden zur Wahl:
zeitbasierte Codes (TOTP) und Passkeys (WebAuthn).

Agents authentifizieren sich **weiterhin** über einen separaten Bearer-Token
(`DASH_TOKEN`, siehe [docs/AGENTS.md](AGENTS.md)) — das ist ein eigenständiges
Modell für Maschine-zu-Maschine-Kommunikation und von der hier beschriebenen
Benutzerverwaltung unabhängig.

## Erstes Administrator-Konto

Beim ersten Aufruf des Dashboards ist die Benutzertabelle leer. In diesem
Zustand zeigt die Oberfläche automatisch eine Einrichtungsseite an, auf der
das erste Konto (mit Administratorrechten) angelegt wird — kein
Kommandozeilenzugriff nötig.

Für automatisierte/nicht-interaktive Installationen richtet `install-server.sh`
alternativ ein Bootstrap-Konto über Umgebungsvariablen ein:

| Variable | Bedeutung |
|----------|-----------|
| `DASH_BOOTSTRAP_USER` | Benutzername des ersten Kontos |
| `DASH_BOOTSTRAP_PASSWORD` | Zugehöriges Passwort |

Diese Variablen wirken **nur, solange noch kein Benutzer existiert** — sie
können dauerhaft in der systemd-Unit stehen bleiben, ohne dass sie nach dem
ersten Start noch etwas bewirken. Das vom Installer generierte Passwort liegt
zusätzlich unter `/etc/backupdash.bootstrap.password` (chmod 600).

**Nach dem ersten Login:** Passwort ändern und optional TOTP oder einen
Passkey unter **Konto** einrichten.

## Login-Ablauf

1. Benutzername + Passwort (`POST /api/auth/login`).
2. Falls für das Konto TOTP oder ein Passkey aktiv ist, folgt ein zweiter
   Schritt (`mfa_required`), bei dem einer der aktivierten zweiten Faktoren
   verwendet wird.
3. Bei Erfolg setzt das Dashboard ein serverseitiges, per HttpOnly-Cookie
   referenziertes Sitzungs-Token (Standard-Gültigkeit 12 Stunden, einstellbar
   über `DASH_SESSION_HOURS`).

Fehlgeschlagene Anmeldeversuche (Passwort **und** TOTP-Codes) zählen pro Konto;
nach 5 Fehlversuchen wird das Konto für 15 Minuten gesperrt.

## Zwei-Faktor-Authentifizierung (TOTP)

Unter **Konto → Zwei-Faktor-Authentifizierung → Aktivieren** wird ein neuer
Schlüssel erzeugt und als QR-Code (kompatibel mit Google Authenticator, Aegis,
1Password u. a.) sowie als Klartext-Schlüssel zur manuellen Eingabe angezeigt.
Erst nach Eingabe eines gültigen Codes wird TOTP für das Konto aktiv. Zum
Deaktivieren ist erneut das Passwort erforderlich.

## Passkeys (WebAuthn)

Passkeys ermöglichen eine passwortlose Anmeldung über das Gerät (Fingerabdruck,
Gesichtserkennung, Sicherheitsschlüssel). Verwaltung unter **Konto → Passkeys**.

**Wichtige Einschränkung:** Browser erlauben WebAuthn nur in einem *sicheren
Kontext* — das ist entweder eine **HTTPS**-Verbindung oder der Hostname
**„localhost"**. Der in [docs/INSTALL.md](INSTALL.md) beschriebene Standardfall
(Zugriff über eine LAN-IP-Adresse per HTTP) erfüllt das nicht: reine
IP-Adressen sind laut WebAuthn-Spezifikation kein gültiger RP-Identifier, egal
ob verschlüsselt oder nicht. Wenn das zutrifft, blendet das Dashboard die
Passkey-Funktionen aus und zeigt einen Hinweis; **Passwort und TOTP
funktionieren davon unabhängig immer.**

Um Passkeys nutzen zu können, das Dashboard entweder:

- hinter einem Reverse-Proxy mit gültigem TLS-Zertifikat und echtem
  Hostnamen betreiben, oder
- lokal über `http://localhost:<port>` aufrufen (z. B. per SSH-Tunnel).

## Benutzerverwaltung

Unter **Benutzer** (nur für Administrator-Konten sichtbar) lassen sich weitere
Konten anlegen und löschen. Jedes Konto kann unabhängig als Administrator
markiert werden. Der letzte verbleibende Administrator kann nicht gelöscht
werden, um ein Aussperren zu verhindern.

| Aktion | Endpunkt | Berechtigung |
|--------|----------|--------------|
| Benutzer auflisten/anlegen | `GET`/`POST /api/users` | Administrator |
| Benutzer löschen | `DELETE /api/users/{id}` | Administrator |
| Eigenes Passwort ändern | `POST /api/account/password` | angemeldeter Benutzer |
| TOTP einrichten/deaktivieren | `POST /api/account/totp/*` | angemeldeter Benutzer |
| Passkey registrieren/entfernen | `POST/DELETE /api/account/webauthn/*` | angemeldeter Benutzer |

Alle Peers- und Einstellungen-Funktionen stehen jedem angemeldeten Konto zur
Verfügung (kein zusätzliches Rollenmodell) — nur die Benutzerverwaltung selbst
ist Administratoren vorbehalten.

## Technische Details

- **Passwort-Hashing:** `scrypt` (Python-Standardbibliothek `hashlib`, kein
  externes Paket), mit zufälligem Salt pro Konto.
- **Sitzungen:** zufälliges Token, serverseitig nur als SHA-256-Hash
  gespeichert; das Cookie ist `HttpOnly`, `SameSite=Lax` und — sobald über
  HTTPS aufgerufen — zusätzlich `Secure`.
- **CSRF-Schutz:** Da alle schreibenden Endpunkte einen JSON-Body erwarten und
  keine CORS-Header gesetzt werden, können weder klassische Cross-Site-Formulare
  noch Cross-Origin-`fetch`-Aufrufe diese Endpunkte auslösen; in Kombination
  mit `SameSite=Lax` entfällt ein zusätzliches CSRF-Token.
- **Passkeys:** Implementiert über die Bibliothek [`webauthn`](https://pypi.org/project/webauthn/)
  (keine selbst geschriebene Kryptografie). Öffentliche Schlüssel werden pro
  Konto gespeichert, private Schlüssel verlassen nie das Endgerät.
- **TOTP:** RFC 6238 über [`pyotp`](https://pypi.org/project/pyotp/), QR-Codes
  werden lokal als SVG erzeugt (`qrcode`-Paket) — keine externen Dienste.

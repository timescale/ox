# ox

Starten Sie KI-Coding-Agenten in isolierten Sandboxen, eine Aufgabe nach der anderen.

Ox automatisiert den gesamten Workflow beim Starten einer Coding-Aufgabe: Es erstellt einen Feature-Branch, fork optional Ihre Datenbank und startet einen KI-Agenten in einer isolierten Sandbox – alles mit einem einzigen Befehl oder einer interaktiven Terminal-Benutzeroberfläche.

### Funktionen

- **Sandboxed Execution** – Agenten laufen in isolierten Docker-Containern oder Cloud-Sandboxen, nie auf Ihrem Host-Rechner
- **Branch-per-Task** – Erstellt automatisch einen Git-Branch mit einem LLM-generierten Namen für jede Aufgabe
- **Datenbank-Forking** – Forken Sie optional Ihre Timescale-Datenbank pro Branch für vollständige Umgebungsisolation
- **Mehrere Agenten** – Unterstützt Claude Code und OpenCode out of the box
- **Interaktive TUI** – Rich Terminal UI für die Verwaltung von Sessions mit einer Befehlspalette, 30+ Themes und Tastenkombinationen
- **Session-Verwaltung** – Starten, stoppen, fortsetzen, anhängen und shell in Agent-Sessions jederzeit
- **Zwei Sandbox-Provider** – Laufen Sie lokal mit Docker oder remote mit Cloud-Sandboxen
- **Auto-Update** – Hält sich im Hintergrund aktuell

## Schnellstart

```bash
# Installation
curl -fsSL https://get.ox.build | bash

# Interaktive TUI ausführen
ox

# Oder starten Sie direkt eine Aufgabe
ox "Add input validation to the signup form"
```

## Installation

### Schnelle Installation (Empfohlen)

```bash
curl -fsSL https://get.ox.build | bash
```

Nach der Installation starten Sie Ihre Shell neu oder führen Sie `source ~/.zshrc` (oder `source ~/.bashrc`) aus, um Ihren PATH zu aktualisieren.

Führen Sie den Befehl jederzeit erneut aus, um auf die neueste Version zu aktualisieren.

### Homebrew

```bash
brew install timescale/tap/ox
```

### npm

```bash
npm i -g @ox.build/cli
```

### Quelle (Entwickler)

```bash
git clone https://github.com/timescale/ox.git
cd ox
./bun i && ./bun link
source ~/.zshrc  # oder Terminal neu starten
```

### Empfohlenes Terminal

Obwohl jedes Terminal funktionieren sollte, empfehlen wir [Ghostty](https://ghostty.org/) für die beste TUI-Erfahrung:

```bash
brew install --cask ghostty
```

## Verwendung

### Interaktive TUI

Führen Sie `ox` ohne Argumente aus, um die vollständige Terminal-UI zu öffnen. Von hier aus können Sie einen Prompt schreiben, um eine neue Aufgabe zu starten, aktive Sessions durchsuchen, frühere Arbeiten fortsetzen und die Konfiguration verwalten.

```bash
ox
```

### Einzelne Aufgabe

Übergeben Sie eine Beschreibung in natürlicher Sprache, um eine Aufgabe direkt zu starten:

```bash
ox "Refactor the auth middleware to use JWT tokens"
```

Ox erstellt einen Branch, richtet eine Sandbox ein und startet den konfigurierten Agenten mit Ihrem Prompt. Der Agent läuft im Hintergrund – verwenden Sie `ox sessions`, um ihn zu überprüfen, oder `ox`, um die TUI zu öffnen und anzuhängen.

### Interaktiver Modus

Um mit dem Agenten in einer Live-Terminal-Sitzung zu arbeiten:

```bash
ox -i "Fix the failing integration tests"
```

### Shell-Zugriff

Öffnen Sie eine Bash-Shell in einer neuen Sandbox, ohne einen Agenten zu starten:

```bash
ox shell
```

Oder shell in eine laufende Session:

```bash
ox resume --shell <session>
```

## Sandbox-Provider

Ox unterstützt zwei Sandbox-Provider zum Ausführen von Agenten:

### Docker (Standard)

Agenten laufen in lokalen Docker-Containern, die aus speziell erstellten Images erstellt wurden, die häufig verwendete Entwicklungstools, Sprach-Runtimes und KI-Agent-CLIs enthalten. Ihr Code wird entweder von GitHub geklont oder aus Ihrem lokalen Dateisystem eingebunden.

```bash
# Mount your local working directory into the sandbox
ox --mount "Add tests for the new API endpoints"
```

### Cloud

Agenten laufen in Remote-Cloud-Sandboxen, die von Deno Deploy betrieben werden. Dies ist nützlich, um Arbeiten von Ihrem Rechner auszulagern oder Aufgaben parallel auszuführen, ohne lokale Ressourcenbeschränkungen zu haben.

```bash
# Verwenden Sie den Cloud-Provider
ox --provider cloud "Migrate the database schema"
```

Konfigurieren Sie den Standard-Provider in Ihrer Konfiguration:

```yaml
# .ox/config.yml
sandboxProvider: cloud
cloudRegion: ord  # ord (Chicago) oder ams (Amsterdam)
```

## Agent-Unterstützung

Ox wird mit Unterstützung für zwei KI-Coding-Agenten geliefert:

| Agent | Beschreibung |
|-------|-------------|
| **OpenCode** | Open-Source-Coding-Agent-CLI mit Unterstützung für mehrere Model Provider |
| **Claude Code** | Anthropic's Claude Code CLI |

Wählen Sie einen Agenten pro Aufgabe oder setzen Sie einen Standard:

```bash
# Verwenden Sie einen bestimmten Agenten für diese Aufgabe
ox --agent claude "Implement the new dashboard component"

# Setzen Sie einen Standard in der Konfiguration
ox config
```

Sie können auch ein bestimmtes Modell auswählen:

```bash
ox --model opus "Design the database schema for the new feature"
```

## Datenbank-Forking

Bei der Arbeit mit einer [Timescale](https://www.timescale.com/)-Datenbank kann Ox automatisch einen isolierten Datenbank-Fork für jeden Task-Branch erstellen. Dies gibt jeder Agent-Sitzung ihre eigene Kopie der Datenbank zum Arbeiten, sodass Schema-Änderungen und Test-Daten niemals zwischen Aufgaben kollidieren.

Datenbank-Forking ist optional. Wenn kein Timescale-Service konfiguriert ist, überspringt Ox diesen Schritt und erstellt die Sandbox ohne Datenbank-Fork.

```yaml
# .ox/config.yml
tigerServiceId: your-service-id  # oder null zum Deaktivieren
```

## Konfiguration

Ox verwendet ein zweistufiges YAML-Konfigurationssystem:

| Stufe | Ort | Zweck |
|-------|----------|---------|
| **Benutzer** | `~/.config/ox/config.yml` | Persönliche Standards für alle Projekte |
| **Projekt** | `.ox/config.yml` | Projektspezifische Überschreibungen (gitignored) |

Projektkonfiguration hat Vorrang vor Benutzerkonfiguration.

### Interaktives Setup

Führen Sie `ox config` aus, um einen interaktiven Setup-Assistenten zu durchlaufen, der Ihren Sandbox-Provider, Agenten, Modell und Authentifizierung konfiguriert.

### Wichtige Optionen

```yaml
# .ox/config.yml
agent: opencode             # Standard-Agent: opencode oder claude
model: sonnet               # Standard-Modell für den ausgewählten Agenten
sandboxProvider: docker      # Sandbox-Provider: docker oder cloud
cloudRegion: ord             # Cloud-Region: ord (Chicago) oder ams (Amsterdam)
tigerServiceId: null         # Timescale-Service-ID für DB-Forking (null zum Deaktivieren)
overlayMounts:               # Pfade zum Isolieren im Mount-Modus (z.B. node_modules)
  - node_modules
initScript: 'npm install'   # Shell-Befehl, der vor dem Start des Agenten ausgeführt wird
themeName: opencode          # TUI-Theme (30+ eingebaute Themes)
```

### Umgebungsvariablen

Platzieren Sie eine `.ox/.env`-Datei in Ihrem Projektverzeichnis, um Umgebungsvariablen in die Sandbox zu übergeben:

```env
DATABASE_URL=postgres://localhost:5432/mydb
API_KEY=your-key-here
```

## Session-Verwaltung

### Sessions auflisten

```bash
# Öffnen Sie die TUI-Sitzungsliste
ox sessions

# Tabellenausgabe
ox sessions --output table

# JSON-Ausgabe zum Scripting
ox sessions --output json

# Stoppte Sessions einschließen
ox sessions --all
```

### Sessions fortsetzen

```bash
# Setzen Sie eine gestoppte Session fort
ox resume <session>

# Setzen Sie mit einem neuen Prompt fort
ox resume <session> "Continue by adding error handling"

# Setzen Sie im Hintergrund fort
ox resume --detach <session>
```

### Bereinigung

```bash
# Entfernen Sie gestoppte Container
ox sessions clean

# Entfernen Sie alle Container (einschließlich laufender)
ox sessions clean --all

# Bereinigen Sie alte Bilder, Volumes und Snapshots
ox resources clean
```

## CLI-Referenz

| Befehl | Beschreibung |
|---------|-------------|
| `ox [prompt]` | Starten Sie eine neue Aufgabe oder öffnen Sie die TUI |
| `ox sessions` | Listen und verwalten Sie Sessions |
| `ox resume <session>` | Setzen Sie eine gestoppte Session fort |
| `ox shell` | Öffnen Sie eine Shell in einer neuen Sandbox |
| `ox config` | Interaktiver Konfigurationsassistent |
| `ox auth check <provider>` | Überprüfen Sie den Authentifizierungsstatus |
| `ox auth login <provider>` | Melden Sie sich bei einem Provider an |
| `ox resources` | Verwalten Sie Sandbox-Images, Volumes und Snapshots |
| `ox logs` | Anzeigen von Ox-Logs |
| `ox upgrade` | Prüfen Sie auf Updates und installieren Sie diese |
| `ox completions [shell]` | Richten Sie Shell-Tab-Vervollständigungen ein |
| `ox claude [args...]` | Führen Sie Claude Code in einer Sandbox aus |
| `ox opencode [args...]` | Führen Sie OpenCode in einer Sandbox aus |
| `ox gh [args...]` | Führen Sie die GitHub-CLI in einer Sandbox aus |
| `ox colors` | Zeigen Sie Theme-Farbmuster an |

Verwenden Sie `ox <command> --help` für detaillierte Optionen für jeden Befehl.

## Lizenz

Apache 2.0 – siehe [LICENSE](LICENSE) für Details.

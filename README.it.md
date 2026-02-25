# hermes

Uno strumento CLI per eseguire agenti di codifica AI in sandbox isolate per attività.

## Installazione

### Installazione Rapida (Consigliata)

```bash
curl -fsSL https://install.hermetic.ly | sh
```

Dopo l'installazione, riavvia la shell o esegui `source ~/.zshrc` (o `source ~/.bashrc`) per aggiornare il tuo PATH.

Riesegui il comando precedente in qualsiasi momento per aggiornare alla versione più recente.

### Terminal Consigliato

Sebbene qualsiasi terminal sia utilizzabile, consigliamo [Ghostty](https://ghostty.org/) per la migliore esperienza TUI:

```bash
brew install --cask ghostty
```

### Installazione dal Sorgente (Sviluppatori)

Se preferisci clonare il repository ed eseguire dal sorgente:

```bash
git clone https://github.com/timescale/hermes.git
cd hermes
./bun i && ./bun link
source ~/.zshrc # oppure riavvia la shell
```

## Utilizzo

```bash
cd myproject
# Esperienza TUI completa
hermes

# O esegui semplicemente una singola attività:
hermes "Build a new feature that ..."
```

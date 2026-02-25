# hermes

Un outil CLI pour exécuter des agents de codage IA dans des bacs à sable isolés par tâche.

## Installation

### Installation rapide (recommandée)

```bash
curl -fsSL https://install.hermetic.ly | sh
```

Après l'installation, redémarrez votre shell ou exécutez `source ~/.zshrc` (ou `source ~/.bashrc`) pour mettre à jour votre PATH.

Réexécutez la commande ci-dessus à tout moment pour mettre à jour vers la dernière version.

### Terminal recommandé

Bien que n'importe quel terminal soit utilisable, nous recommandons [Ghostty](https://ghostty.org/) pour la meilleure expérience TUI :

```bash
brew install --cask ghostty
```

### Installation depuis la source (Développeurs)

Si vous préférez cloner le dépôt et l'exécuter depuis la source :

```bash
git clone https://github.com/timescale/hermes.git
cd hermes
./bun i && ./bun link
source ~/.zshrc # ou redémarrez votre shell
```

## Utilisation

```bash
cd myproject
# Expérience TUI complète
hermes

# Ou exécutez simplement une seule tâche :
hermes "Build a new feature that ..."
```

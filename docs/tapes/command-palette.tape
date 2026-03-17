# Command Palette
# Shows the command palette opening with Ctrl+P, fuzzy search, and navigation.

Output docs/images/command-palette.gif

Set Shell bash
Set Width 1000
Set Height 600
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 30
Set TypingSpeed 80ms

# Launch ox TUI
Type "ox"
Enter
Sleep 3s

# Open command palette
Ctrl+P
Sleep 2s

# Navigate through commands
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms
Up
Sleep 500ms

# Filter commands by typing
Type "theme"
Sleep 1.5s

# Clear and try another filter
Backspace 5
Sleep 1s
Type "session"
Sleep 1.5s

# Clear and try another
Backspace 7
Sleep 1s
Type "mount"
Sleep 1.5s

# Dismiss
Escape
Sleep 1s

# Slash Commands
# Shows the slash command popover appearing when typing "/" in the prompt.

Output docs/assets/slash-commands.gif

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

# Type "/" to trigger slash commands
Type "/"
Sleep 2s

# Filter slash commands
Type "th"
Sleep 1.5s

# Clear and show all again
Backspace 2
Sleep 1s

# Filter to mode commands
Type "inter"
Sleep 1.5s

# Dismiss
Escape
Sleep 1s

# Clear prompt
Backspace 6
Sleep 1s

# Show again with different filter
Type "/"
Sleep 1s
Type "mod"
Sleep 1.5s

Escape
Sleep 1s

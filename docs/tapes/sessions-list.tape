# Sessions List
# Shows the sessions list view with session entries and filter controls.

Output docs/assets/sessions-list.gif

Set Shell bash
Set Width 1200
Set Height 700
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 30
Set TypingSpeed 50ms

# Launch ox TUI
Type "ox"
Enter
Sleep 3s

# Navigate to sessions list
Ctrl+L
Sleep 2s

# Navigate through sessions
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms
Up
Sleep 500ms

# Cycle through filters
Tab
Sleep 1s
Tab
Sleep 1s
Tab
Sleep 1s

# Type to filter
Type "feat"
Sleep 1s
Backspace 4
Sleep 1s

# Open session detail
Enter
Sleep 2s

# Go back
Escape
Sleep 2s

# Theme Picker
# Shows the theme picker with live preview of different themes.

Output docs/images/theme-picker.gif

Set Shell bash
Set Width 1000
Set Height 600
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 30
Set TypingSpeed 50ms

# Launch ox TUI
Type "ox"
Enter
Sleep 3s

# Open theme picker with ctrl+t
Ctrl+T
Sleep 2s

# Browse themes
Down
Sleep 800ms
Down
Sleep 800ms
Down
Sleep 800ms
Down
Sleep 800ms
Down
Sleep 800ms
Up
Sleep 800ms
Up
Sleep 800ms

# Filter themes
Type "tokyo"
Sleep 1.5s

# Select
Enter
Sleep 2s

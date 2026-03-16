# Prompt Screen
# Shows the main TUI prompt screen with agent badge, model, and readiness indicators.

Output docs/assets/prompt-screen.gif

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

# Type a prompt
Type "Add input validation to the signup form with proper error messages"

Sleep 2s

# Show cycling through agents with Tab
Sleep 1s
Tab
Sleep 1s
Tab
Sleep 1s
Tab
Sleep 1s

# Show cycling modes with Shift+Tab
Shift+Tab
Sleep 1s
Shift+Tab
Sleep 1s
Shift+Tab
Sleep 1s

Sleep 2s

# Multi-Agent Interactive Sessions
# Shows three interactive sessions running in parallel and hopping between them.

Output docs/images/multi-agent-sessions.gif

Set Shell bash
Set Width 1200
Set Height 720
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 30
Set TypingSpeed 55ms

Type "alias ox='bash ./docs/tapes/showcase-ox.sh'"
Enter
Sleep 500ms

Type "ox --agent claude -M interactive 'Refactor the auth middleware into smaller composable steps'"
Enter
Sleep 1500ms

Type "ox --agent opencode -M interactive 'Add integration coverage for the dashboard loading states'"
Enter
Sleep 1500ms

Type "ox --agent codex -M interactive 'Tighten signup validation and preserve inline form errors'"
Enter
Sleep 1500ms

Type "ox sessions"
Enter
Sleep 1800ms

Type "ox session attach demo-claude-auth"
Enter
Sleep 2500ms
Ctrl+\
Sleep 1200ms

Type "ox session attach demo-opencode-tests"
Enter
Sleep 2500ms
Ctrl+\
Sleep 1200ms

Type "ox session attach demo-codex-validation"
Enter
Sleep 2500ms
Ctrl+\
Sleep 1200ms


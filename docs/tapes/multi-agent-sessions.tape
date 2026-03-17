# Multi-Agent Interactive Sessions
# Shows real ox session listing and attachment across three interactive sessions.

Output docs/images/multi-agent-sessions.gif

Set Shell bash
Set Width 1200
Set Height 720
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 30
Set TypingSpeed 55ms

Type "./bun index.ts sessions"
Enter
Sleep 2s

Type "./bun index.ts session attach demo-claude-auth"
Enter
Sleep 3s
Ctrl+\
Sleep 1500ms

Type "./bun index.ts session attach demo-opencode-tests"
Enter
Sleep 3s
Ctrl+\
Sleep 1500ms

Type "./bun index.ts session attach demo-codex-validation"
Enter
Sleep 3s
Ctrl+\
Sleep 1500ms

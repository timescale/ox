// ============================================================================
// Completion Command - Generate shell completions for hermes CLI
// ============================================================================

import { Command } from 'commander';

// All hermes commands (for completion)
const COMMANDS = [
  'auth',
  'branch',
  'claude',
  'config',
  'gh',
  'logs',
  'opencode',
  'resume',
  'sessions',
  'shell',
  'completion',
] as const;

// Command aliases
const COMMAND_ALIASES: Record<string, readonly string[]> = {
  sessions: ['list', 'session', 'status', 's'],
};

function generateBashCompletion(): string {
  const allCommands = [
    ...COMMANDS,
    ...Object.values(COMMAND_ALIASES).flat(),
  ].join(' ');

  return `# Bash completion for hermes CLI
# Add this to ~/.bashrc or ~/.bash_completion:
#   eval "$(hermes completion bash)"

_hermes_completions() {
  local cur prev words cword
  _init_completion || return

  local commands="${allCommands}"

  # Handle completion based on position and previous words
  case "\${cword}" in
    1)
      # First argument: complete commands
      COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
      return 0
      ;;
    *)
      # Determine the command context
      local cmd="\${words[1]}"
      local subcmd=""
      
      # Check if second word is a subcommand
      if [[ \${cword} -ge 2 ]]; then
        case "\${cmd}" in
          auth)
            if [[ "\${words[2]}" =~ ^(check|login|status|c|s)$ ]]; then
              subcmd="\${words[2]}"
            fi
            ;;
          sessions|list|session|status|s)
            if [[ "\${words[2]}" == "clean" ]]; then
              subcmd="clean"
            fi
            ;;
        esac
      fi
      
      # Handle options that take values
      case "\${prev}" in
        -a|--agent)
          COMPREPLY=($(compgen -W "claude opencode" -- "\${cur}"))
          return 0
          ;;
        -o|--output)
          COMPREPLY=($(compgen -W "tui table json yaml" -- "\${cur}"))
          return 0
          ;;
        -s|--service-id|-m|--model|--mount)
          # These take user-provided values, no completion
          return 0
          ;;
      esac
      
      # Handle subcommands and arguments
      case "\${cmd}" in
        auth)
          if [[ -z "\${subcmd}" && \${cword} -eq 2 ]]; then
            COMPREPLY=($(compgen -W "check login status c s" -- "\${cur}"))
            return 0
          elif [[ \${cword} -eq 3 && "\${subcmd}" =~ ^(check|login|status|c|s)$ ]]; then
            COMPREPLY=($(compgen -W "claude opencode gh" -- "\${cur}"))
            return 0
          fi
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-h --help" -- "\${cur}"))
          fi
          ;;
        branch)
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-s --service-id --no-db-fork -a --agent -m --model -p --print -i --interactive --mount -h --help" -- "\${cur}"))
          fi
          ;;
        claude|gh|opencode)
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "--mount -h --help" -- "\${cur}"))
          fi
          ;;
        config)
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-h --help" -- "\${cur}"))
          fi
          ;;
        logs)
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-f --follow -h --help" -- "\${cur}"))
          fi
          ;;
        resume)
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-d --detach -s --shell -h --help" -- "\${cur}"))
          elif [[ \${cword} -eq 2 ]]; then
            # Complete session names - get from hermes sessions -o json
            local sessions
            sessions=$(hermes sessions -o json 2>/dev/null | grep -o '"name": *"[^"]*"' | sed 's/"name": *"\\([^"]*\\)"/\\1/' 2>/dev/null)
            if [[ -n "\${sessions}" ]]; then
              COMPREPLY=($(compgen -W "\${sessions}" -- "\${cur}"))
            fi
          fi
          ;;
        sessions|list|session|status|s)
          if [[ -z "\${subcmd}" && \${cword} -eq 2 && "\${cur}" != -* ]]; then
            COMPREPLY=($(compgen -W "clean" -- "\${cur}"))
            return 0
          fi
          if [[ "\${subcmd}" == "clean" ]]; then
            if [[ "\${cur}" == -* ]]; then
              COMPREPLY=($(compgen -W "-a --all -f --force -h --help" -- "\${cur}"))
            fi
          elif [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-o --output -a --all -h --help" -- "\${cur}"))
          fi
          ;;
        shell)
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "--mount -h --help" -- "\${cur}"))
          fi
          ;;
        completion)
          if [[ \${cword} -eq 2 ]]; then
            COMPREPLY=($(compgen -W "bash zsh fish" -- "\${cur}"))
          fi
          ;;
        *)
          # Root command options
          if [[ "\${cur}" == -* ]]; then
            COMPREPLY=($(compgen -W "-s --service-id --no-db-fork -a --agent -m --model -p --print -i --interactive --mount -v --version -h --help" -- "\${cur}"))
          fi
          ;;
      esac
      ;;
  esac
  
  return 0
}

complete -F _hermes_completions hermes
`;
}

function generateZshCompletion(): string {
  return `#compdef hermes

# Zsh completion for hermes CLI
# Add this to a file in your fpath (e.g., ~/.zsh/completions/_hermes)
# Or eval directly: eval "$(hermes completion zsh)"

_hermes() {
  local -a commands
  local -a subcommands
  
  commands=(
    'auth:Manage authentication tokens'
    'branch:Create a feature branch with isolated DB fork and start agent sandbox'
    'claude:Pass-through commands to the Claude CLI'
    'config:Configure hermes for project'
    'gh:Pass-through commands to the GitHub CLI'
    'logs:Display hermes logs with pretty formatting'
    'opencode:Pass-through commands to the OpenCode CLI'
    'resume:Resume a stopped hermes session'
    'sessions:Show all hermes sessions and their status'
    'shell:Start an interactive shell in a new sandbox'
    'completion:Generate shell completion scripts'
    'list:Show all hermes sessions (alias for sessions)'
    'session:Show all hermes sessions (alias for sessions)'
    'status:Show all hermes sessions (alias for sessions)'
    's:Show all hermes sessions (alias for sessions)'
  )

  _arguments -C \\
    '1: :->command' \\
    '*: :->args'

  case $state in
    command)
      _describe -t commands 'hermes commands' commands
      ;;
    args)
      case $words[2] in
        auth)
          if (( CURRENT == 3 )); then
            local -a auth_commands
            auth_commands=(
              'check:Check authentication status'
              'login:Ensure the provider is logged in'
              'status:Check authentication status (alias)'
              'c:Check authentication status (alias)'
              's:Check authentication status (alias)'
            )
            _describe -t auth-commands 'auth commands' auth_commands
          elif (( CURRENT == 4 )); then
            local -a providers
            providers=('claude' 'opencode' 'gh')
            _describe -t providers 'providers' providers
          fi
          ;;
        branch)
          _arguments \\
            '-s[Database service ID to fork]:service id:' \\
            '--service-id[Database service ID to fork]:service id:' \\
            '--no-db-fork[Skip the database fork step]' \\
            '-a[Agent to use]:agent:(claude opencode)' \\
            '--agent[Agent to use]:agent:(claude opencode)' \\
            '-m[Model to use for the agent]:model:' \\
            '--model[Model to use for the agent]:model:' \\
            '-p[Attach container output to console]' \\
            '--print[Attach container output to console]' \\
            '-i[Run agent in full TUI mode]' \\
            '--interactive[Run agent in full TUI mode]' \\
            '--mount[Mount local directory into container]:directory:_files -/' \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '1:prompt:'
          ;;
        claude|gh|opencode)
          _arguments \\
            '--mount[Mount local directory into container]:directory:_files -/' \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '*:arguments:'
          ;;
        config)
          _arguments \\
            '-h[Show help]' \\
            '--help[Show help]'
          ;;
        logs)
          _arguments \\
            '-f[Follow log output]' \\
            '--follow[Follow log output]' \\
            '-h[Show help]' \\
            '--help[Show help]'
          ;;
        resume)
          _arguments \\
            '-d[Resume in detached mode]' \\
            '--detach[Resume in detached mode]' \\
            '-s[Resume with a bash shell]' \\
            '--shell[Resume with a bash shell]' \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '1:session:->sessions' \\
            '2:prompt:'
          
          if [[ $state == sessions ]]; then
            local -a session_names
            session_names=(\${(f)"$(hermes sessions -o json 2>/dev/null | grep -o '"name": *"[^"]*"' | sed 's/"name": *"\\([^"]*\\)"/\\1/')"})
            _describe -t sessions 'sessions' session_names
          fi
          ;;
        sessions|list|session|status|s)
          if (( CURRENT == 3 )) && [[ $words[3] != -* ]]; then
            local -a session_commands
            session_commands=('clean:Remove stopped hermes containers')
            _describe -t session-commands 'sessions commands' session_commands
          elif [[ $words[3] == clean ]]; then
            _arguments \\
              '-a[Remove all containers]' \\
              '--all[Remove all containers]' \\
              '-f[Skip confirmation]' \\
              '--force[Skip confirmation]' \\
              '-h[Show help]' \\
              '--help[Show help]'
          else
            _arguments \\
              '-o[Output format]:format:(tui table json yaml)' \\
              '--output[Output format]:format:(tui table json yaml)' \\
              '-a[Show all sessions]' \\
              '--all[Show all sessions]' \\
              '-h[Show help]' \\
              '--help[Show help]'
          fi
          ;;
        shell)
          _arguments \\
            '--mount[Mount local directory into container]:directory:_files -/' \\
            '-h[Show help]' \\
            '--help[Show help]'
          ;;
        completion)
          if (( CURRENT == 3 )); then
            local -a shells
            shells=('bash' 'zsh' 'fish')
            _describe -t shells 'shells' shells
          fi
          ;;
        *)
          # Root command (same as branch)
          _arguments \\
            '-s[Database service ID to fork]:service id:' \\
            '--service-id[Database service ID to fork]:service id:' \\
            '--no-db-fork[Skip the database fork step]' \\
            '-a[Agent to use]:agent:(claude opencode)' \\
            '--agent[Agent to use]:agent:(claude opencode)' \\
            '-m[Model to use for the agent]:model:' \\
            '--model[Model to use for the agent]:model:' \\
            '-p[Attach container output to console]' \\
            '--print[Attach container output to console]' \\
            '-i[Run agent in full TUI mode]' \\
            '--interactive[Run agent in full TUI mode]' \\
            '--mount[Mount local directory into container]:directory:_files -/' \\
            '-v[Show version]' \\
            '--version[Show version]' \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '1:prompt:'
          ;;
      esac
      ;;
  esac
}

_hermes
`;
}

function generateFishCompletion(): string {
  return `# Fish completion for hermes CLI
# Add this to ~/.config/fish/completions/hermes.fish
# Or eval directly: hermes completion fish | source

# Disable file completion by default
complete -c hermes -f

# Commands
complete -c hermes -n "__fish_use_subcommand" -a "auth" -d "Manage authentication tokens"
complete -c hermes -n "__fish_use_subcommand" -a "branch" -d "Create a feature branch with isolated DB fork and start agent sandbox"
complete -c hermes -n "__fish_use_subcommand" -a "claude" -d "Pass-through commands to the Claude CLI"
complete -c hermes -n "__fish_use_subcommand" -a "config" -d "Configure hermes for project"
complete -c hermes -n "__fish_use_subcommand" -a "gh" -d "Pass-through commands to the GitHub CLI"
complete -c hermes -n "__fish_use_subcommand" -a "logs" -d "Display hermes logs with pretty formatting"
complete -c hermes -n "__fish_use_subcommand" -a "opencode" -d "Pass-through commands to the OpenCode CLI"
complete -c hermes -n "__fish_use_subcommand" -a "resume" -d "Resume a stopped hermes session"
complete -c hermes -n "__fish_use_subcommand" -a "sessions" -d "Show all hermes sessions and their status"
complete -c hermes -n "__fish_use_subcommand" -a "list" -d "Show all hermes sessions (alias)"
complete -c hermes -n "__fish_use_subcommand" -a "session" -d "Show all hermes sessions (alias)"
complete -c hermes -n "__fish_use_subcommand" -a "status" -d "Show all hermes sessions (alias)"
complete -c hermes -n "__fish_use_subcommand" -a "s" -d "Show all hermes sessions (alias)"
complete -c hermes -n "__fish_use_subcommand" -a "shell" -d "Start an interactive shell in a new sandbox"
complete -c hermes -n "__fish_use_subcommand" -a "completion" -d "Generate shell completion scripts"

# Root command options (when no subcommand)
complete -c hermes -n "__fish_use_subcommand" -s s -l service-id -d "Database service ID to fork" -r
complete -c hermes -n "__fish_use_subcommand" -l no-db-fork -d "Skip the database fork step"
complete -c hermes -n "__fish_use_subcommand" -s a -l agent -d "Agent to use" -r -a "claude opencode"
complete -c hermes -n "__fish_use_subcommand" -s m -l model -d "Model to use for the agent" -r
complete -c hermes -n "__fish_use_subcommand" -s p -l print -d "Attach container output to console"
complete -c hermes -n "__fish_use_subcommand" -s i -l interactive -d "Run agent in full TUI mode"
complete -c hermes -n "__fish_use_subcommand" -l mount -d "Mount local directory into container" -r -a "(__fish_complete_directories)"
complete -c hermes -n "__fish_use_subcommand" -s v -l version -d "Show version"
complete -c hermes -n "__fish_use_subcommand" -s h -l help -d "Show help"

# auth subcommands
complete -c hermes -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from check login status c s" -a "check" -d "Check authentication status"
complete -c hermes -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from check login status c s" -a "login" -d "Ensure the provider is logged in"
complete -c hermes -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from check login status c s" -a "status" -d "Check authentication status (alias)"
complete -c hermes -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from check login status c s" -a "c" -d "Check authentication status (alias)"
complete -c hermes -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from check login status c s" -a "s" -d "Check authentication status (alias)"

# auth check/login providers
complete -c hermes -n "__fish_seen_subcommand_from auth; and __fish_seen_subcommand_from check login status c s" -a "claude opencode gh"

# branch options
complete -c hermes -n "__fish_seen_subcommand_from branch" -s s -l service-id -d "Database service ID to fork" -r
complete -c hermes -n "__fish_seen_subcommand_from branch" -l no-db-fork -d "Skip the database fork step"
complete -c hermes -n "__fish_seen_subcommand_from branch" -s a -l agent -d "Agent to use" -r -a "claude opencode"
complete -c hermes -n "__fish_seen_subcommand_from branch" -s m -l model -d "Model to use for the agent" -r
complete -c hermes -n "__fish_seen_subcommand_from branch" -s p -l print -d "Attach container output to console"
complete -c hermes -n "__fish_seen_subcommand_from branch" -s i -l interactive -d "Run agent in full TUI mode"
complete -c hermes -n "__fish_seen_subcommand_from branch" -l mount -d "Mount local directory into container" -r -a "(__fish_complete_directories)"
complete -c hermes -n "__fish_seen_subcommand_from branch" -s h -l help -d "Show help"

# claude options
complete -c hermes -n "__fish_seen_subcommand_from claude" -l mount -d "Mount local directory into container" -r -a "(__fish_complete_directories)"
complete -c hermes -n "__fish_seen_subcommand_from claude" -s h -l help -d "Show help"

# config options
complete -c hermes -n "__fish_seen_subcommand_from config" -s h -l help -d "Show help"

# gh options
complete -c hermes -n "__fish_seen_subcommand_from gh" -l mount -d "Mount local directory into container" -r -a "(__fish_complete_directories)"
complete -c hermes -n "__fish_seen_subcommand_from gh" -s h -l help -d "Show help"

# logs options
complete -c hermes -n "__fish_seen_subcommand_from logs" -s f -l follow -d "Follow log output"
complete -c hermes -n "__fish_seen_subcommand_from logs" -s h -l help -d "Show help"

# opencode options
complete -c hermes -n "__fish_seen_subcommand_from opencode" -l mount -d "Mount local directory into container" -r -a "(__fish_complete_directories)"
complete -c hermes -n "__fish_seen_subcommand_from opencode" -s h -l help -d "Show help"

# resume options
complete -c hermes -n "__fish_seen_subcommand_from resume" -s d -l detach -d "Resume in detached mode"
complete -c hermes -n "__fish_seen_subcommand_from resume" -s s -l shell -d "Resume with a bash shell"
complete -c hermes -n "__fish_seen_subcommand_from resume" -s h -l help -d "Show help"

# resume session names completion
function __fish_hermes_sessions
  hermes sessions -o json 2>/dev/null | string match -r '"name": *"[^"]*"' | string replace -r '"name": *"([^"]*)"' '$1'
end
complete -c hermes -n "__fish_seen_subcommand_from resume; and not __fish_seen_subcommand_from (__fish_hermes_sessions)" -a "(__fish_hermes_sessions)" -d "Session"

# sessions options
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and not __fish_seen_subcommand_from clean" -a "clean" -d "Remove stopped hermes containers"
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and not __fish_seen_subcommand_from clean" -s o -l output -d "Output format" -r -a "tui table json yaml"
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and not __fish_seen_subcommand_from clean" -s a -l all -d "Show all sessions"
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and not __fish_seen_subcommand_from clean" -s h -l help -d "Show help"

# sessions clean options
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and __fish_seen_subcommand_from clean" -s a -l all -d "Remove all containers"
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and __fish_seen_subcommand_from clean" -s f -l force -d "Skip confirmation"
complete -c hermes -n "__fish_seen_subcommand_from sessions list session status s; and __fish_seen_subcommand_from clean" -s h -l help -d "Show help"

# shell options
complete -c hermes -n "__fish_seen_subcommand_from shell" -l mount -d "Mount local directory into container" -r -a "(__fish_complete_directories)"
complete -c hermes -n "__fish_seen_subcommand_from shell" -s h -l help -d "Show help"

# completion shells
complete -c hermes -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"
`;
}

async function completionAction(shell?: string): Promise<void> {
  // If no shell specified, detect from environment
  const targetShell = shell ?? process.env.SHELL?.split('/').pop() ?? 'bash';

  switch (targetShell) {
    case 'bash':
      console.log(generateBashCompletion());
      break;
    case 'zsh':
      console.log(generateZshCompletion());
      break;
    case 'fish':
      console.log(generateFishCompletion());
      break;
    default:
      console.error(
        `Unknown shell: ${targetShell}. Supported shells: bash, zsh, fish`,
      );
      process.exit(1);
  }
}

export const completionCommand = new Command('completion')
  .description('Generate shell completion scripts')
  .argument(
    '[shell]',
    'Shell type: bash, zsh, fish (defaults to current shell)',
  )
  .action(completionAction);

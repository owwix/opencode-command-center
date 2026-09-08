#!/bin/zsh
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HARNESS_DIR"

node_version="$(tr -d '[:space:]' < .nvmrc)"
node_binary="$HOME/.nvm/versions/node/v${node_version#v}/bin/node"
if [[ ! -x "$node_binary" ]]; then
  /usr/bin/osascript -e 'display alert "Node 24 unavailable" message "OpenCode Command Center could not find the Node version pinned in .nvmrc. Run nvm install in the Command Center repository." as warning'
  exit 1
fi
export PATH="${node_binary:h}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

selection=$(/usr/bin/osascript <<'APPLESCRIPT'
set lineBreak to ASCII character 10
set action to button returned of (display dialog "OpenCode Command Center workspaces" with title "OpenCode Command Center" buttons {"Cancel", "Open Existing", "New Project"} default button "Open Existing")

if action is "Open Existing" then
  try
    set selectedFolder to POSIX path of (choose folder with prompt "Choose the project folder to open")
    return "open" & lineBreak & selectedFolder
  on error number -128
    return "cancel"
  end try
else if action is "New Project" then
  try
    set projectName to text returned of (display dialog "Name for the new project" with title "New OpenCode Command Center workspace" default answer "new-project")
    set parentFolder to POSIX path of (choose folder with prompt "Choose where to create the project")
    set initializeGit to button returned of (display dialog "Initialize a Git repository?" with title "New OpenCode Command Center workspace" buttons {"No", "Yes"} default button "Yes")
    return "new" & lineBreak & parentFolder & lineBreak & projectName & lineBreak & initializeGit
  on error number -128
    return "cancel"
  end try
end if

return "cancel"
APPLESCRIPT
)

lines=("${(@f)selection}")
action="${lines[1]:-cancel}"

if [[ "$action" == "cancel" ]]; then
  echo "No workspace selected. OpenCode was not started."
  exit 0
fi

if [[ "$action" == "open" ]]; then
  workspace="${lines[2]:-}"
else
  parent="${lines[2]:-}"
  project_name="${lines[3]:-}"
  initialize_git="${lines[4]:-No}"

  if [[ -z "$parent" || -z "$project_name" || "$project_name" == "." || "$project_name" == ".." || "$project_name" == */* ]]; then
    /usr/bin/osascript -e 'display alert "Invalid project name" message "Use a folder name without slash characters." as warning'
    exit 1
  fi

  workspace="${parent%/}/$project_name"
  if [[ -e "$workspace" ]]; then
    /usr/bin/osascript -e 'display alert "Project already exists" message "Choose a different name or open the existing folder." as warning'
    exit 1
  fi

  mkdir -p "$workspace"
  if [[ "$initialize_git" == "Yes" ]]; then
    git -C "$workspace" init >/dev/null
  fi
  echo "Created workspace: $workspace"
fi

if [[ -z "${workspace:-}" || ! -d "$workspace" ]]; then
  /usr/bin/osascript -e 'display alert "Workspace unavailable" message "The selected folder could not be opened." as warning'
  exit 1
fi

exec "$node_binary" scripts/opencode-entry.mjs open "$workspace"

# Execution adapters

OpenCode Command Center resolves one versioned execution adapter from the project contract
and repository shape. Node, Python, and JavaScript monorepos are supported. The
adapter owns the pinned verification image, supported executables, install plan,
and verification plan.

`occtl verify [path]` runs that plan locally. Managed runs load the same project
contract and adapter before Dagger verification, so local and isolated results do
not silently select different commands. Explicit `--verify` commands remain an
operator override for a single managed run.

The monorepo adapter is selected by package workspaces, `pnpm-workspace.yaml`,
`turbo.json`, or `nx.json`. Python projects are detected from `pyproject.toml`,
`requirements.txt`, or `setup.py`. Unsupported executables fail project
preflight instead of falling through to a different runtime.

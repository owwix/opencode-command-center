# External workflow packs

OpenCode Command Center core is product-neutral. Private or public packs can add agents,
commands, skills, themes, managed-run kinds, and quality contracts without
editing the harness.

## Enable packs

Set `OPENCODE_LAB_PACKS` in ignored `opencode.env` to one or more absolute pack
directories separated by the host path delimiter (`:` on macOS/Linux):

```text
OPENCODE_LAB_PACKS=/absolute/path/to/company-pack
```

The launcher reads this value on the host. It validates every manifest and
declared source, then copies only declared files into a fresh, project-scoped,
host-owned config directory. The OpenCode container receives the materialized
files and a non-sensitive UI summary—not host pack paths.

## Manifest v2

Every pack root contains `opencode-lab.pack.json`:

```json
{
  "schemaVersion": 2,
  "id": "example-pack",
  "namespace": "example-pack",
  "label": "Example",
  "version": "0.1.0",
  "minimumLabVersion": "1.0.0",
  "resources": [
    { "source": "opencode/agents/slides.md", "target": "agents/slides.md" },
    {
      "source": "opencode/commands/slides.md",
      "target": "commands/slides.md"
    }
  ],
  "managedRuns": {
    "slides": {
      "agent": "slides",
      "aliases": ["presentation"],
      "capabilities": [],
      "model": "cloudflare-ai/@cf/openai/gpt-oss-120b",
      "qualityContract": "coding",
      "taskPatterns": ["slide|presentation"],
      "taskPrefix": "Create slides for: ",
      "tooling": ["research", "design"]
    }
  },
  "contracts": {},
  "services": {
    "public-web": { "profile": "research", "required": false }
  },
  "permissions": ["research"],
  "models": {
    "builder": {
      "model": "cloudflare-ai/@cf/openai/gpt-oss-120b",
      "family": "openai-oss",
      "purpose": "Routine implementation"
    }
  },
  "verification": {
    "adapters": ["node", "python", "monorepo"],
    "contracts": ["coding"]
  },
  "artifacts": [
    {
      "id": "deliverable",
      "root": "artifacts/deliverable",
      "kinds": ["patch", "verification"]
    }
  ]
}
```

Resource targets must remain under `agents/`, `commands/`, `skills/`, `themes/`,
or `resources/`. Sources must be regular files inside the pack—symlinks,
traversal, unsupported fields, duplicate IDs, namespace collisions, and
incompatible versions fail closed.

Schema v2 declares the complete workflow surface: agent and command resources,
fixed service profiles, bounded permissions, model roles, contracts,
verification adapters, and artifact namespaces. Services cannot supply URLs or
credentials, permissions cannot add publishing or shell authority, and every
model declaration is descriptive rather than an automatic route promotion.
Duplicate pack IDs, namespaces, resource targets, run kinds, contracts, service
keys, model aliases, and artifact IDs fail closed.

Every managed run must declare its matching `agents/<agent>.md` resource. Its
quality contract must be the built-in `coding` / `research` contract or a
contract declared by the same pack.

`minimumLabVersion` is checked against the core's `labPackApiVersion`, which is
versioned separately from an unreleased package build string. This lets a v1
pack target the stable v1 extension surface without representing a development
checkout as a final 1.0 product release.

Managed-run capabilities are allowlisted. Schemas v1 and v2 accept only the `image`
capability and the optional `research` / `design` tooling profiles. Packs do not
receive gateway signing authority, credentials, arbitrary service execution, or
permission-policy write access.

Quality contracts declared by a pack are available to host-managed runs and are
also materialized under
`/opencode-config/.opencode/resources/contracts/<id>.json` for explicit in-agent
verification.

Schema v1 remains a compatibility adapter for existing private packs and is
normalized to the same internal surface with an empty service/model/artifact
declaration. New packs should use v2. See `examples/packs/coding` and
`examples/packs/research` for generic, credential-free examples.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

test("OpenCode defaults to approval and cannot share sessions", () => {
  const config = JSON.parse(read("opencode.json"));
  assert.equal(config.share, "disabled");
  assert.equal(config.permission["*"], "ask");
  assert.equal(config.permission["quality_*"], "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.read["**/*.env"], "deny");
  assert.equal(config.mcp.notion.enabled, false);
  assert.equal(
    config.provider["cloudflare-ai"].options.baseURL,
    "http://agent-gateway:8787/v1"
  );
  assert.equal(
    config.provider["google-vertex"].options.baseURL,
    "http://agent-gateway:8787/vertex/v1"
  );
  assert.equal(
    config.provider["google-vertex"].models["gemini-3.1-pro-preview"].name,
    "Gemini 3.1 Pro"
  );
  assert.equal(
    JSON.stringify(config).includes("{env:CLOUDFLARE_API_TOKEN}"),
    false
  );
  assert.equal(config.permission.bash["git diff*"], "deny");
  assert.equal(config.permission.bash["git status*"], "deny");
  assert.equal(config.permission.bash["git show*"], "deny");
  assert.equal(config.permission.bash["rg *"], "deny");
  assert.equal(
    config.permission.bash[
      "node /opencode-config/scripts/security/safe-git.mjs *"
    ],
    "allow"
  );
  assert.equal(
    config.permission.bash[
      "node /opencode-config/scripts/security/safe-remove.mjs plan *"
    ],
    "allow"
  );
  assert.equal(
    config.permission.bash[
      "node /opencode-config/scripts/security/safe-remove.mjs execute *"
    ],
    "ask"
  );
  for (const pattern of ["rm *", "rmdir *", "unlink *", "find * -delete*"]) {
    assert.equal(config.permission.bash[pattern], "deny", pattern);
  }
});

test("agent policy requires bounded recoverable deletion and safe temporary state", () => {
  const config = JSON.parse(read("opencode.json"));
  assert.ok(config.instructions.includes("docs/agent-safety.md"));
  const policy = read("docs/agent-safety.md");
  assert.match(policy, /resolve and inspect every exact deletion target/iu);
  assert.match(policy, /target or scope is ambiguous/u);
  assert.match(policy, /safe-remove\.mjs plan/u);
  assert.match(policy, /safe-remove\.mjs execute/u);
  assert.match(policy, /fresh `\.agent-trash` recovery directory/u);
  assert.match(
    policy,
    /Never assign to or repurpose system environment variables/u
  );
  assert.match(policy, /already mounted at `\/workspace`/u);
  assert.match(policy, /skills\/local-preview\/SKILL\.md/u);
  assert.match(policy, /127\.0\.0\.1:3100/u);
  assert.match(policy, /Never mention Codespaces/u);
});

test("only the dispatcher can start nested managed runs", () => {
  for (const agent of ["lab", "plan", "research", "reviewer"]) {
    assert.match(
      read(`.opencode/agents/${agent}.md`),
      /["']?quality_\*["']?: deny/u,
      agent
    );
  }
  assert.match(read(".opencode/agents/plan.md"), /edit: deny/u);
  assert.match(
    read(".opencode/commands/checkpoint.md"),
    /checkpoint\.mjs create/u
  );
  assert.match(read(".opencode/commands/rewind.md"), /checkpoint\.mjs rewind/u);
  assert.match(read(".opencode/commands/plan.md"), /agent: plan/u);
  assert.match(read(".opencode/commands/browser.md"), /browser-verify\.mjs/u);
  assert.match(
    read("opencode.json"),
    /scripts\/lab\/checkpoint\.mjs \*": "allow"/u
  );
  assert.match(read("opencode.json"), /"lab-browser"/u);
  assert.match(
    read(".opencode/plugins/tool-lifecycle.mjs"),
    /tool\.execute\.before/u
  );
  assert.match(read("docker-compose.opencode.yml"), /scripts\/lab:/u);
  assert.match(
    read(".opencode/agents/dispatcher.md"),
    /quality_start_managed_run: allow/u
  );
  assert.match(
    read(".opencode/agents/dispatcher.md"),
    /quality_start_parallel_runs: allow/u
  );
  assert.match(
    read(".opencode/agents/lab.md"),
    /skills\/local-preview\/SKILL\.md/u
  );
  assert.match(read(".opencode/agents/lab.md"), /AGENTS\.md/u);
  assert.match(read(".opencode/agents/lab.md"), /project-skills/u);
  assert.match(read(".opencode/commands/preview.md"), /local-preview/u);
  assert.match(read(".opencode/commands/run-local.md"), /project-skills/u);
  assert.match(read(".opencode/commands/compact.md"), /compaction/u);
  assert.match(
    read(".opencode/skills/local-preview/SKILL.md"),
    /Never use Codespaces/u
  );
  assert.match(
    read(".opencode/skills/author-project-skill/SKILL.md"),
    /workspace\/\.opencode\/skills/u
  );
  assert.match(read("docs/lab/when-to-use-agents.md"), /project.*pack/iu);
  assert.match(read("docs/lab/workspace-agents.md"), /OPENCODE_CONFIG_DIR/u);
  const config = JSON.parse(read("opencode.json"));
  assert.equal(config.compaction?.auto, true);
  assert.equal(config.compaction?.prune, true);
  assert.match(read(".opencode/commands/parallel.md"), /agent: dispatcher/u);
  for (const command of ["research", "ship"]) {
    assert.match(
      read(`.opencode/commands/${command}.md`),
      /agent: dispatcher/u,
      command
    );
  }
});

test("OpenCode containers are hardened and receive no real gateway secret", () => {
  const compose = read("docker-compose.opencode.yml");
  assert.doesNotMatch(compose, /- \.\/:\/opencode-config:ro/u);
  assert.match(compose, /opencode-internal:\n\s+internal: true/u);
  const opencodeService = compose
    .split("\n  opencode:")[1]
    .split("\n  opencode-preview:")[0];
  assert.doesNotMatch(opencodeService, /agent-gateway-egress:/u);
  assert.match(opencodeService, /preview-internal:/u);
  assert.match(opencodeService, /opencode-app/u);
  assert.match(compose, /preview-internal:\n\s+internal: true/u);
  assert.doesNotMatch(
    read("scripts/lab/browser-mcp.mjs"),
    /host\.docker\.internal|127\.0\.0\.1:3112/u
  );
  assert.match(
    read("scripts/opencode-state-init.sh"),
    /rm -rf \/state\/state\/opencode\/locks/u
  );
  assert.match(compose, /opencode-preview:/u);
  assert.match(compose, /127\.0\.0\.1:\$\{OPENCODE_PREVIEW_PORT:-3100\}:3000/u);
  assert.doesNotMatch(compose, /openchamber/u);
  assert.doesNotMatch(compose, /opencode-server:/u);
  assert.doesNotMatch(compose, /127\.0\.0\.1:3000:3000/u);
  assert.doesNotMatch(
    opencodeService,
    /127\.0\.0\.1:\$\{OPENCODE_PREVIEW_PORT:-3100\}:3000/u
  );
  assert.doesNotMatch(compose, /opencode-egress/u);
  assert.match(compose, /agent-gateway:/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /cap_drop:\n\s+- ALL/u);
  assert.match(
    compose,
    /application_default_credentials\.json:\/run\/google\/adc\.json:ro/u
  );
  assert.doesNotMatch(
    compose.split("\n  opencode:")[1].split("\n  opencode-preview:")[0],
    /GOOGLE_APPLICATION_CREDENTIALS/u
  );

  const config = JSON.parse(read("opencode.json"));
  assert.doesNotMatch(
    JSON.stringify(config),
    /CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)/u
  );
  const launcher = [
    read("scripts/opencode.mjs"),
    read("scripts/lab/launcher/docker-runtime.mjs"),
    read("scripts/lab/launcher/helper-supervisor.mjs")
  ].join("\n");
  assert.match(launcher, /const qualityEnvironment = safeHostEnvironment/u);
  assert.match(launcher, /initializeOpenCodeVolumes\(childEnvironment\)/u);
  assert.match(launcher, /"--use-aliases"/u);
  assert.match(launcher, /ensureOpencodePreview\(/u);
  assert.match(launcher, /opencode-preview/u);
});

test("OpenCode sessions and personal TUI preferences use persistent volumes", () => {
  const compose = read("docker-compose.opencode.yml");
  assert.match(
    compose,
    /opencode-state:\/home\/opencode\/\.local\/share\/opencode/u
  );
  assert.match(
    compose,
    /opencode-user-config:\/home\/opencode\/\.config\/opencode/u
  );
  assert.match(
    compose,
    /OPENCODE_TUI_CONFIG: \/home\/opencode\/\.config\/opencode\/tui\.json/u
  );
  assert.match(compose, /^\s+entrypoint: \["\/bin\/sh"\]$/mu);
  assert.match(
    compose,
    /^\s+command: \["\/init\/opencode-state-init\.sh"\]$/mu
  );
  assert.match(
    compose,
    /\.\/scripts\/opencode-state-init\.sh:\/init\/opencode-state-init\.sh:ro/u
  );
  assert.match(
    read("scripts/opencode-state-init.sh"),
    /Sync kv → tui so theme choices survive/u
  );
  assert.match(
    compose,
    /OPENCODE_USER_CONFIG_HOST[^\n]*\/home\/opencode\/\.config\/opencode\/lab-user:ro/u
  );
});

test("persistent state and runtime config are namespaced by project ID", () => {
  const compose = read("docker-compose.opencode.yml");
  for (const suffix of [
    "open-design-state",
    "hound-state",
    "opencode-state",
    "opencode-user-config",
    "opencode-package-cache",
    "opencode-tmp",
    "notion-publisher-state"
  ]) {
    assert.match(
      compose,
      new RegExp(
        `name: \\$\\{OPENCODE_VOLUME_${suffix.replaceAll("-", "_").toUpperCase()}:-opencode-lab-\\$\\{OPENCODE_STATE_NAMESPACE:-\\$\\{OPENCODE_PROJECT_ID:-unscoped\\}\\}-${suffix}\\}`,
        "u"
      )
    );
  }
  assert.match(
    read("scripts/opencode.mjs"),
    /projectStateDirectory = projectHostState\(projectId\)/u
  );
});

test("OpenCode receives a lease but never gateway signing authority", () => {
  const compose = read("docker-compose.opencode.yml");
  const opencodeService = compose.slice(
    compose.indexOf("\n  opencode:\n"),
    compose.indexOf("\n  opencode-preview:\n")
  );
  assert.match(
    opencodeService,
    /AGENT_GATEWAY_TOKEN: \$\{AGENT_TRANSPORT_TOKEN:/u
  );
  assert.doesNotMatch(opencodeService, /AGENT_GATEWAY_SIGNING_KEY/u);
  assert.match(
    compose,
    /AGENT_GATEWAY_SIGNING_KEY: \$\{AGENT_GATEWAY_SIGNING_KEY:/u
  );
});

test("companion services are confined and OpenChamber is removed", () => {
  assert.match(
    read("Dockerfile.opencode"),
    /^FROM node:24\.18\.0-alpine@sha256:[a-f0-9]{64} AS node-runtime$/mu
  );
  assert.match(read("Dockerfile.opencode"), /npm install -g pnpm@/u);
  assert.doesNotMatch(read("docker-compose.opencode.yml"), /openchamber/u);
  assert.match(
    read("docker-compose.opencode.yml"),
    /OPENCODE_PROJECT_SKILLS:-\.\/docker\/empty-skills/u
  );
  const dagger = read("scripts/dagger-quality.mjs");
  const adapters = read("scripts/lab/execution-adapters.mjs");
  assert.match(adapters, /node:24\.18\.0-bookworm@sha256:[a-f0-9]{64}/u);
  assert.match(adapters, /python:3\.12\.11-slim-bookworm@sha256:[a-f0-9]{64}/u);
  assert.match(dagger, /\.from\(evidence\.image\)/u);
  assert.match(
    dagger,
    /adapter\.runtime === "node" \? dependencySource : source/u
  );
  assert.match(dagger, /withDirectory\("\/workspace", installSource\)/u);
  assert.match(dagger, /for \(const install of adapter\.install\)/u);
  assert.match(dagger, /withExec\(\["sh", "-lc", install\.shell\]\)/u);
  assert.match(dagger, /dependencies\.withDirectory\("\/workspace", source\)/u);

  const compose = read("docker-compose.opencode.yml");
  const openDesign = compose.slice(
    compose.indexOf("  open-design:"),
    compose.indexOf("  agent-gateway:")
  );
  assert.match(openDesign, /user: "1001:1001"/u);
  assert.match(openDesign, /read_only: true/u);
  assert.match(openDesign, /no-new-privileges:true/u);
  assert.match(openDesign, /cap_drop:\n\s+- ALL/u);
  assert.match(openDesign, /pids_limit: 128/u);
});

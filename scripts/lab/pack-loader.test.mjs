import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inferPackAgent,
  loadPackSet,
  materializePackConfig,
  packAgentAlias,
  packUiSummary,
  qualityContractPath,
  selectPackSet
} from "./pack-loader.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lab-pack-"));
  const core = join(root, "core");
  const pack = join(root, "pack");
  mkdirSync(join(core, "agents"), { recursive: true });
  mkdirSync(join(pack, "opencode", "agents"), { recursive: true });
  mkdirSync(join(pack, "opencode", "commands"), { recursive: true });
  mkdirSync(join(pack, "quality"), { recursive: true });
  writeFileSync(join(core, "agents", "lab.md"), "generic\n");
  writeFileSync(
    join(pack, "opencode", "agents", "slides.md"),
    "private agent\n"
  );
  writeFileSync(
    join(pack, "opencode", "commands", "slides.md"),
    "private command\n"
  );
  writeFileSync(join(pack, "quality", "slides.json"), "{}\n");
  writeFileSync(
    join(pack, "opencode-lab.pack.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "example-pack",
        label: "Example",
        version: "0.1.0",
        minimumLabVersion: "1.0.0",
        resources: [
          { source: "opencode/agents/slides.md", target: "agents/slides.md" },
          {
            source: "opencode/commands/slides.md",
            target: "commands/slides.md"
          }
        ],
        managedRuns: {
          slides: {
            agent: "slides",
            aliases: ["presentation"],
            model: "cloudflare-ai/example",
            taskPatterns: ["slide|presentation"],
            taskPrefix: "Create slides for: ",
            tooling: ["research", "design"]
          }
        },
        qualityContracts: { slides: "quality/slides.json" }
      },
      null,
      2
    )}\n`
  );
  return { root, core, pack };
}

test("loads a versioned pack and resolves managed contributions", () => {
  const state = fixture();
  try {
    const set = loadPackSet({ roots: [state.pack], labVersion: "1.0.0" });
    assert.equal(set.packs[0].id, "example-pack");
    assert.equal(packAgentAlias(set, "presentation"), "slides");
    assert.equal(inferPackAgent(set, "update the presentation"), "slides");
    assert.match(qualityContractPath(set, "slides", "/core"), /slides\.json$/u);
    assert.deepEqual(JSON.parse(packUiSummary(set))[0].commands, ["slides"]);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("an empty pack set preserves the generic default profile", () => {
  const set = loadPackSet({ roots: [] });
  assert.deepEqual(set.packs, []);
  assert.deepEqual(set.managedRuns, {});
  assert.deepEqual(JSON.parse(packUiSummary(set)), []);
});

test("project contracts select only configured pack IDs", () => {
  const state = fixture();
  try {
    const configured = loadPackSet({ roots: [state.pack] });
    assert.deepEqual(selectPackSet(configured, []).packs, []);
    assert.deepEqual(
      selectPackSet(configured, ["example-pack"]).packs.map(({ id }) => id),
      ["example-pack"]
    );
    assert.throws(
      () => selectPackSet(configured, ["missing-pack"]),
      /unavailable packs/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("materializes only declared pack resources without replacing core files", () => {
  const state = fixture();
  try {
    const set = loadPackSet({ roots: [state.pack] });
    const output = join(state.root, "generated");
    materializePackConfig({
      coreConfigRoot: state.core,
      destination: output,
      packSet: set
    });
    assert.equal(
      readFileSync(join(output, "agents", "lab.md"), "utf8"),
      "generic\n"
    );
    assert.equal(
      readFileSync(join(output, "agents", "slides.md"), "utf8"),
      "private agent\n"
    );
    assert.equal(
      readFileSync(
        join(output, "resources", "contracts", "slides.json"),
        "utf8"
      ),
      "{}\n"
    );
    assert.throws(
      () =>
        materializePackConfig({
          coreConfigRoot: state.core,
          destination: output,
          packSet: set
        }),
      /already exists/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("fails closed on unsupported versions, traversal, and namespace conflicts", () => {
  const state = fixture();
  try {
    assert.throws(
      () => loadPackSet({ roots: [state.pack], labVersion: "0.9.0" }),
      /needs OpenCode Command Center/u
    );
    const manifestPath = join(state.pack, "opencode-lab.pack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.resources[0].target = "../agents/escape.md";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => loadPackSet({ roots: [state.pack] }),
      /approved pack resource root/u
    );

    manifest.resources[0].target = "agents/slides.md";
    manifest.managedRuns.slides.agent = "missing-agent";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => loadPackSet({ roots: [state.pack] }),
      /must declare its agent resource/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("loads workflow-pack v2 and exposes the complete bounded surface", () => {
  const coding = loadPackSet({
    roots: ["examples/packs/coding"],
    labVersion: "1.0.0"
  });
  const pack = coding.packs[0];
  assert.equal(pack.schemaVersion, 2);
  assert.equal(pack.namespace, "generic-coding");
  assert.deepEqual(pack.verification.adapters, ["node", "python", "monorepo"]);
  assert.equal(coding.models["generic-coding:builder"].family, "openai-oss");
  assert.equal(
    coding.artifacts["generic-coding:implementation"].root,
    "artifacts/implementation"
  );

  const research = loadPackSet({
    roots: ["examples/packs/research"],
    labVersion: "1.0.0"
  });
  assert.equal(
    research.services["generic-research:public-web"].profile,
    "research"
  );
  assert.deepEqual(research.packs[0].permissions, ["research"]);
});

test("workflow packs fail closed on schema, permissions, artifacts, and namespaces", () => {
  const state = fixture();
  try {
    const manifestPath = join(state.pack, "opencode-lab.pack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => loadPackSet({ roots: [state.pack] }),
      /unsupported pack schema version/iu
    );

    manifest.schemaVersion = 2;
    manifest.namespace = "example-pack";
    manifest.permissions = ["publish"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => loadPackSet({ roots: [state.pack] }),
      /unsupported value/u
    );

    manifest.permissions = [];
    manifest.artifacts = [{ id: "result", root: "../escape", kinds: [] }];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadPackSet({ roots: [state.pack] }), /stay within/u);

    manifest.artifacts = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const duplicate = join(state.root, "duplicate");
    mkdirSync(duplicate);
    writeFileSync(
      join(duplicate, "opencode-lab.pack.json"),
      JSON.stringify({
        ...manifest,
        id: "second-pack",
        resources: [],
        managedRuns: {},
        qualityContracts: {}
      })
    );
    assert.throws(
      () => loadPackSet({ roots: [state.pack, duplicate] }),
      /namespace conflict/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

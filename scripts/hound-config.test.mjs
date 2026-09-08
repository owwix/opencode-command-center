import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const compose = readFileSync("docker-compose.opencode.yml", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");
const gitignore = readFileSync(".gitignore", "utf8");
const firewallDockerfile = readFileSync(
  "docker/hound-firewall/Dockerfile",
  "utf8"
);
const firewallScript = readFileSync(
  "docker/hound-firewall/firewall.sh",
  "utf8"
);
const houndDockerfile = readFileSync("docker/hound/Dockerfile", "utf8");
const houndEntrypoint = readFileSync("docker/hound/entrypoint.sh", "utf8");
const houndBuildLock = readFileSync(
  "docker/hound/build-requirements.lock",
  "utf8"
);
const houndLock = readFileSync("docker/hound/requirements.lock", "utf8");
const relayDockerfile = readFileSync("docker/hound-relay/Dockerfile", "utf8");
const config = JSON.parse(readFileSync("opencode.json", "utf8"));
const launcher = [
  readFileSync("scripts/opencode.mjs", "utf8"),
  readFileSync("scripts/lab/launcher/docker-runtime.mjs", "utf8")
].join("\n");
const researchAgent = readFileSync(".opencode/agents/research.md", "utf8");
const reviewerAgent = readFileSync(".opencode/agents/reviewer.md", "utf8");

function serviceBlock(name) {
  const startMarker = `  ${name}:`;
  const start = compose.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${name} Compose service.`);
  const remainder = compose.slice(start + startMarker.length);
  const nextService = remainder.search(/^  [a-zA-Z0-9_-]+:/m);
  return nextService === -1 ? remainder : remainder.slice(0, nextService);
}

test("OpenCode connects to Hound only through the fixed relay", () => {
  assert.deepEqual(config.mcp.hound, {
    type: "remote",
    url: "http://hound-relay:8765/mcp",
    enabled: true,
    codemode: false,
    timeout: 180000
  });
  assert.equal(config.permission["hound_*"], "deny");
});

test("only evidence-producing agents can use Hound's passive web tools", () => {
  assert.match(researchAgent, /"hound_\*": ask/);
  assert.match(researchAgent, /"hound_mcp_smart_crawl": allow/);
  assert.match(researchAgent, /"hound_mcp_smart_fetch": allow/);
  assert.match(researchAgent, /"hound_mcp_smart_search": allow/);
  assert.match(researchAgent, /"hound_mcp_screenshot": allow/);
  assert.match(researchAgent, /"hound_version": allow/);
  assert.match(researchAgent, /private-network/);
  assert.match(researchAgent, /untrusted evidence/);
  assert.match(reviewerAgent, /"hound_\*": deny/);
});

test("Docker build contexts exclude local secrets", () => {
  assert.match(dockerignore, /^docker\.env$/m);
  assert.match(dockerignore, /^opencode\.env$/m);
  assert.doesNotMatch(gitignore, /^\.dockerignore$/m);
});

test("Hound has bounded resources and receives no trusted mounts or env file", () => {
  const hound = serviceBlock("hound");
  assert.match(
    hound,
    /image: \$\{OPENCODE_LAB_HOUND_IMAGE:-opencode-lab-hound:13\.1\.2\}/u
  );
  assert.match(hound, /read_only: true/);
  assert.match(hound, /shm_size: 1gb/);
  assert.match(hound, /mem_limit: 2g/);
  assert.match(hound, /pids_limit: 256/);
  assert.match(hound, /hound-firewall:\s+condition: service_healthy/);
  assert.match(
    hound,
    /hound-firewall:\s+condition: service_healthy\s+restart: true/
  );
  assert.match(hound, /- hound-state:\/home\/hound\/\.hound/);
  assert.match(
    hound,
    /- \/home\/hound\/\.master_fetch_cache:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001/
  );
  assert.match(hound, /network_mode: service:hound-firewall/);
  assert.doesNotMatch(hound, /opencode-internal/);
  assert.doesNotMatch(hound, /networks:/);
  assert.doesNotMatch(hound, /env_file:/);
  assert.doesNotMatch(hound, /ports:/);
  assert.doesNotMatch(hound, /OPENCODE_WORKSPACE|opencode-config|docker\.sock/);
});

test("Hound egress is filtered after DNS resolution and on redirects", () => {
  const firewall = serviceBlock("hound-firewall");
  assert.match(firewall, /read_only: true/);
  assert.match(firewall, /cap_drop:\s+- ALL/);
  assert.match(firewall, /cap_add:\s+- NET_ADMIN/);
  assert.match(firewall, /- hound-egress/);
  assert.doesNotMatch(
    firewall,
    /env_file:|ports:|OPENCODE_WORKSPACE|opencode-config|docker\.sock/
  );
  assert.match(
    firewallDockerfile,
    /alpine:3\.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b/
  );
  for (const subnet of [
    "10.0.0.0/8",
    "100.64.0.0/10",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ]) {
    assert.match(firewallScript, new RegExp(subnet.replaceAll(".", "\\.")));
  }
  const ipv4Drop = firewallScript.indexOf("iptables -P OUTPUT DROP");
  const ipv4Flush = firewallScript.indexOf("iptables -F OUTPUT");
  const privateReject = firewallScript.indexOf(
    'iptables -A OUTPUT -d "$subnet" -j REJECT'
  );
  const ipv4Accept = firewallScript.indexOf("iptables -P OUTPUT ACCEPT");
  const ipv6Drop = firewallScript.indexOf("ip6tables -P OUTPUT DROP");
  const ipv6Flush = firewallScript.indexOf("ip6tables -F OUTPUT");
  const readyMarker = firewallScript.lastIndexOf("touch /tmp/firewall-ready");
  assert.ok(ipv4Drop < ipv4Flush, "IPv4 must fail closed before rules flush.");
  assert.ok(ipv6Drop < ipv6Flush, "IPv6 must fail closed before rules flush.");
  assert.ok(
    privateReject < ipv4Accept,
    "IPv4 may open only after private-network rejects are installed."
  );
  assert.ok(
    ipv4Accept < readyMarker,
    "The firewall may report ready only after its final policy is active."
  );
  assert.match(firewallScript, /ip6tables -P OUTPUT DROP/);
});

test("the fixed-purpose relay starts only for the research profile", () => {
  const firewall = serviceBlock("hound-firewall");
  const hound = serviceBlock("hound");
  const relay = serviceBlock("hound-relay");
  for (const service of [firewall, hound, relay]) {
    assert.match(service, /profiles: \["research"\]/);
  }
  assert.match(relay, /context: docker\/hound-relay/);
  assert.match(relay, /dockerfile: Dockerfile/);
  assert.match(relay, /HOUND_UPSTREAM_HOST: hound-firewall/);
  assert.match(relay, /condition: service_healthy/);
  assert.match(relay, /- opencode-internal/);
  assert.match(relay, /- hound-egress/);
  assert.doesNotMatch(
    relay,
    /env_file:|ports:|OPENCODE_WORKSPACE|docker\.sock/
  );

  for (const name of ["opencode"]) {
    const client = serviceBlock(name);
    assert.doesNotMatch(client, /hound-relay:/);
    assert.match(client, /opencode-internal:/);
    assert.match(client, /preview-internal:/);
    assert.doesNotMatch(client, /agent-gateway-egress|hound-egress/);
  }
  assert.match(launcher, /"--profile",\s+"research",[\s\S]*"hound-relay"/);
});

test("the full Hound package is pinned instead of self-updating", () => {
  assert.match(
    houndDockerfile,
    /python:3\.12\.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7/
  );
  assert.match(
    houndDockerfile,
    /pip install --no-build-isolation --require-hashes/
  );
  assert.match(houndLock, /hound_mcp-13\.1\.2-py3-none-any\.whl/);
  assert.match(
    houndLock,
    /sha256:c5c73e5a425f1bd0aa7c87346acf8d189fe65c7b20c4d3726b1714969aee9f76/
  );
  assert.match(houndLock, /^patchright==1\.62\.1/m);
  assert.match(houndLock, /^playwright==1\.62\.0/m);
  assert.match(houndBuildLock, /^setuptools==80\.9\.0/m);
  assert.match(houndBuildLock, /^wheel==0\.45\.1/m);
  assert.doesNotMatch(houndDockerfile, /hound -u|hound --update|:latest/);
  assert.match(houndDockerfile, /^USER hound$/m);
  assert.match(houndDockerfile, /ENTRYPOINT \["hound-entrypoint"\]/);
  assert.match(houndDockerfile, /getaddrinfo\('hound-firewall', 8765/);
  assert.match(houndEntrypoint, /failures="?\$\(\(failures \+ 1\)\)"?/);
  assert.match(houndEntrypoint, /\[ "\$failures" -ge 3 \]/);
  assert.match(houndEntrypoint, /kill -TERM "\$child_pid"/);
  assert.match(
    relayDockerfile,
    /node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43/
  );
  assert.match(relayDockerfile, /^USER node$/m);
});

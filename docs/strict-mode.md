# Strict microVM mode

Strict mode uses Docker Sandboxes (`sbx`) as a separate, opt-in execution
backend. It never silently replaces normal Docker-isolated Command Center sessions.

Run `occtl strict doctor` first. The initial supported host is macOS 14 or newer
on Apple silicon with reachable Docker Desktop and the standalone `sbx` CLI.
The doctor is read-only and fails closed when any prerequisite is missing.

Install and sign in using Docker's current instructions:

- <https://docs.docker.com/ai/sandboxes/install/>
- <https://docs.docker.com/ai/sandboxes/>

Start a session with `occtl strict run /path/to/repository`, `occtl open
/path/to/repository --strict`, or the v0.x-compatible `lab --strict
--workspace /path/to/repository` form.

The launcher requires a clean main checkout, then uses `sbx create --clone
--no-share-skills`. Docker Sandboxes clones the repository inside the VM while
the original host checkout remains read-only. Command Center supplies a generated minimal
OpenCode configuration and a one-hour, chat-only gateway capability. It does
not share host skills, normal Command Center sessions, project configuration, production
credentials, or general network authority. The signing key remains on the
host; only the signed short-lived lease enters the sandbox.

Configure an HTTPS fixed-purpose gateway as `STRICT_GATEWAY_URL` in the
host-owned `opencode.env`. The sandbox is retained after the interactive
session so a later explicit export can inspect and package its results. Strict
mode atomically generates the mode-0600 host capability signer when it is
missing; that signing authority never enters the sandbox.

## Reviewed export and adoption

The strict sandbox cannot write back to the host repository. Commit the desired
implementation inside the sandbox, then run:

```text
occtl strict export strict_<run-id>
occtl strict adopt strict_<run-id> --approve
```

Export refuses dirty sandbox worktrees and packages only the binary Git patch,
the `artifacts/` tree when present, and `.quality/verification.json` when
present. The host writes a size-bounded bundle outside the repository and signs
its manifest and every included file hash. `STRICT_EXPORT_SIGNING_KEY` may be
used as a separate host-only signer; otherwise Command Center uses the existing capability
signing key.

Adoption verifies the signature and every hash, requires the original clean
host checkout at the exact recorded base SHA, checks the patch before applying
it, and creates a controller-owned commit containing exactly the signed changed
files. Repeating export or adoption returns the existing verified receipt. No
artifact, credential, or runtime state is copied into the repository, and
adoption never publishes or pushes automatically.

# Gateway and capability protocol

The agent gateway is the only component that receives model-provider
credentials. It exposes a fixed local HTTP surface, validates a signed
launch/run capability on every non-health request, checks route/model/action
policy, injects the corresponding upstream credential, and forwards only to a
compiled fixed-purpose destination.

This is an internal protocol between Command Center-owned components. Projects and packs
cannot register gateway URLs, credentials, or arbitrary routes.

## Capability lease format

The normal Docker launcher issues a 30-minute lease and renews five minutes
before expiry while its host process lives. The client holds a per-launch opaque
transport token; a fixed loopback transport reads the current host-owned lease
per request. Project processes cannot read the lease directory or signing key.
Missing or expired leases return 503, not unrestricted fallback authority.
Existing streams may finish during rotation. The legacy direct signed-lease
protocol remains available to strict-backend callers; it is not automatically
renewed by the Docker launcher's transport.

Leases use three base64url segments with an HMAC-SHA256 signature:

```text
base64url(header).base64url(payload).base64url(hmac_sha256(signing_input))
```

Header:

```json
{
  "alg": "HS256",
  "typ": "OCL-CAP",
  "v": 1
}
```

Payload:

```json
{
  "v": 1,
  "jti": "unique-lease-id",
  "workspaceHash": "workspace_<stable-hash>",
  "projectId": "project_<stable-id>",
  "sessionId": "launch-or-session-id",
  "runId": "managed-run-id-or-null",
  "routes": ["chat", "quality"],
  "actions": ["chat:invoke", "quality:read"],
  "iat": 1787600000,
  "exp": 1787601800
}
```

The launcher creates the claims from canonical host state. OpenCode receives
the serialized lease as its gateway bearer token. It never receives
`AGENT_GATEWAY_SIGNING_KEY`.

## Claim validation

The verifier fails closed unless all of the following are true:

- three nonempty token segments;
- header algorithm, type, and version exactly match `HS256`, `OCL-CAP`, and
  version 1;
- the signing key is at least 32 bytes;
- the signature matches in constant time;
- `iat` and `exp` are integers, ordered, and no more than four hours apart;
- the token is active and unexpired (30-second clock-skew allowance);
- workspace hash, project ID, session ID, and—when required—run ID exactly
  match the gateway's launch configuration;
- routes and actions are unique, sorted, nonempty, bounded identifiers;
- the requested route appears in `routes` and `<route>:<action>` appears in
  `actions`.

Lease lifetime may be 30 seconds to four hours; the default is 30 minutes.
Cross-workspace, cross-session, cross-run, altered, expired, and over-scoped
leases are rejected with HTTP 401/403-style policy responses before an
upstream call.

## Authentication

Every non-health request uses:

```http
Authorization: Bearer <capability-lease>
```

`GET /health` is an unauthenticated container health probe and returns only
service status. It exposes no configuration or credentials.

## Route matrix

The gateway must be started with the corresponding configured capability, and
the request lease must contain the route/action pair.

| Local route                                                            | Method                       | Lease scope                                | Fixed destination/policy                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/v1/chat/completions`                                                 | POST                         | `chat:invoke`                              | Cloudflare Workers AI OpenAI-compatible endpoint; model must be in the Workers AI chat allowlist.             |
| `/openai/v1/chat/completions`                                          | POST                         | `openai-chat:invoke`                       | `api.openai.com/v1/chat/completions`; model must be in the OpenAI allowlist.                                  |
| `/vertex/v1/chat/completions`                                          | POST                         | `vertex-chat:invoke`                       | Vertex global OpenAI-compatible endpoint for the configured project; model must be in the Vertex allowlist.   |
| `/run/<encoded-model>`                                                 | POST                         | `image:generate`                           | Cloudflare Workers AI image endpoint; model must be in the image allowlist.                                   |
| `/quality/mcp`                                                         | POST, DELETE                 | `quality:mcp`                              | Loopback quality MCP relay with gateway-held quality and registration tokens.                                 |
| `/quality/runs`, `/quality/notifications`, `/quality/runs/*`           | GET, POST                    | `quality:read` or `quality:operate`        | Project-scoped run-control relay. Action endpoints require `operate`; reads cannot mutate runs.               |
| `/open-design/api*`, `/open-design/artifacts*`, `/open-design/frames*` | GET, HEAD, POST, PUT, DELETE | `open-design:mcp`                          | Fixed OpenDesign container and allowlisted path prefixes only.                                                |
| `/notion/publish`                                                      | POST                         | `notion-publish:publish`                   | Restricted Notion sidecar and its preconfigured target map.                                                   |
| `/github/status`, `/github/push`, `/github/pr`                         | POST                         | `github-publish:status`, `:push`, or `:pr` | Loopback GitHub publishing relay; no arbitrary GitHub API path.                                               |
| `/openpets/react`                                                      | POST                         | `openpets:react`                           | Loopback OpenPets relay; reaction must be `thinking`, `editing`, `testing`, `waiting`, `success`, or `error`. |
| `/browser/verify`                                                      | POST                         | `browser-verify:verify`                    | Loopback browser verification relay.                                                                          |
| `/browser/session`                                                     | POST                         | `browser-session:control`                  | Loopback interactive browser action relay.                                                                    |
| `/artifact/download`                                                   | POST                         | `artifact:download`                        | Direct bounded HTTPS fetch for exact configured hostnames.                                                    |

Unknown paths, methods, model IDs, GitHub operations, OpenDesign paths, browser
operations, and OpenPets reactions are denied. A configured capability does not
replace the lease check; both must permit the operation.

## Credential ownership

| Credential                              | Receiving process                   | Never exposed to            |
| --------------------------------------- | ----------------------------------- | --------------------------- |
| Cloudflare account/token                | agent gateway                       | OpenCode, project, packs    |
| OpenAI key                              | agent gateway when configured       | OpenCode, project, packs    |
| Google ADC/project                      | agent gateway when configured       | OpenCode, project, packs    |
| Gateway signing key                     | launcher/gateway                    | OpenCode and strict sandbox |
| Quality registration/token              | gateway and quality relay           | project code                |
| GitHub relay token and host GitHub auth | gateway/host relay                  | OpenCode container          |
| Notion API token                        | restricted Notion sidecar           | gateway, OpenCode, project  |
| Browser relay tokens                    | gateway and matching loopback relay | project code                |

The gateway replaces client authorization with the real upstream credential.
It does not forward the capability lease to model providers. Fixed-purpose
relays receive the lease in a dedicated header when they must independently
validate project/run scope.

## Artifact download contract

`POST /artifact/download` accepts JSON containing:

```json
{
  "url": "https://approved.example/file.pdf",
  "filename": "optional-name.pdf",
  "checksum": "optional-expected-checksum",
  "maxSize": 10485760,
  "allowedContentTypes": ["application/pdf"]
}
```

The implementation enforces:

- HTTPS only and no URL username/password;
- exact hostname membership in `ARTIFACT_DOWNLOAD_ALLOWLIST`;
- standard HTTPS port only;
- DNS resolution before connection and after every redirect;
- rejection of loopback, private, link-local, multicast, reserved, and metadata
  targets for IPv4/IPv6;
- at most five redirects and no redirect to a disallowed/private target;
- 30-second default timeout;
- 10 MiB gateway maximum, optionally lowered by the request;
- bounded content-type allowlist;
- filename traversal rejection;
- optional checksum equality;
- no installation or execution as part of download.

Downloaded data is a staging artifact. Installation remains a separate
approval-gated action.

## Model routing behavior

The gateway does not choose a task lane. The host/task router selects one model
at the task boundary, and the gateway verifies that model against its provider
allowlist. Models do not switch automatically mid-turn.

The gateway may perform only explicit compatibility fallbacks encoded in its
policy, such as retrying a known GPT-OSS payload/schema/context failure on a
configured fallback model. The response records fallback metadata for
observability. A fallback cannot cross to an unconfigured provider or model.

## Concurrency, bounds, and errors

Routes use per-model/service concurrency limiters. Requests have bounded body,
output, timeout, and retry behavior. Policy errors use bounded JSON and avoid
echoing credentials. Provider failures are normalized without logging request
authorization.

HTTP status classes:

- `400`: malformed payload, unsupported model/input, or unsafe artifact target;
- `401`: missing, invalid, expired, or launch-mismatched lease;
- `403`: valid lease lacks the required route/action;
- `404`: route/capability is not enabled or allowlisted;
- `405`: method is not allowlisted;
- `429`: concurrency limit;
- `5xx`: bounded upstream/authentication/infrastructure failure.

## Adding or changing a route

A gateway route is a security-boundary change. A pull request must:

1. define one fixed purpose, destination, method set, route, and action;
2. keep credentials in the owning gateway/relay process;
3. add configuration validation and fail closed when absent;
4. add positive tests and malicious cross-route, cross-workspace, expired,
   altered, method, path, and credential tests;
5. update this matrix, the [architecture](architecture.md), and the
   [threat model](threat-model.md);
6. update the pack/project contracts only if the public extension surface
   changes;
7. preserve direct-egress denial for OpenCode.

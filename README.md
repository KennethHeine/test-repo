# test-repo

## Azure Infrastructure

This repository has been automatically onboarded with the following Azure resources:

### Resource Group

| Property | Value |
|----------|-------|
| Name | `rg-test-repo` |
| Location | `norwayeast` |

### Identity (Service Principal)

| Property | Value |
|----------|-------|
| Name | `sp-test-repo-github` |
| App ID | `a4202edd-43b2-495c-ae3c-e2741509fd1d` |
| Role | Owner on `rg-test-repo` |

The service principal uses **federated credentials (OIDC)** for passwordless authentication from GitHub Actions.

### GitHub Actions Secrets

The following secrets are already configured in this repository:

| Secret | Description |
|--------|-------------|
| `AZURE_CLIENT_ID` | Service principal application ID |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |

## Article-to-Speech MVP

This repo now contains a minimal full-stack MVP that runs in **one Azure Container App**:

- Frontend UI: `GET /`
- Backend health: `GET /health`
- Backend TTS API: `POST /api/read`
- Optional auth debug endpoint: `GET /api/me` (selected Easy Auth headers only)

The same Node.js/TypeScript container serves static frontend files and API routes.

## Azure architecture implemented

- One **Azure Container Apps managed environment** (Consumption)
- One **Azure Container App** with:
  - external HTTPS ingress
  - target port `8080`
  - `minReplicas: 0` and `maxReplicas: 1`
  - HTTP scale rule for low traffic
  - system-assigned managed identity
- One **Azure AI Speech** resource (`SpeechServices`, F0)
  - deployed to **Sweden Central** by default (`speechLocation`) for HD (DragonHD) / MAI voice region support
  - custom subdomain endpoint
  - local key auth disabled (`disableLocalAuth: true`)
- RBAC assignment (declarative in Bicep):
  - Container App managed identity gets `Cognitive Services Speech User` on Speech resource
- Built-in Container Apps authentication (Easy Auth) with Microsoft Entra ID:
  - Entra app registration + service principal created via the Microsoft Graph Bicep extension
  - secret-less: Container App managed identity federated to the app registration
  - unauthenticated requests redirected to login
  - single tenant (`signInAudience: AzureADMyOrg`)

## App behavior

`POST /api/read` body:

```json
{
  "url": "https://example.com/article",
  "voice": "en-US-JennyNeural",
  "language": "en"
}
```

Flow implemented:

1. URL validation (`http/https` only)
2. Host/IP safety checks (blocks localhost/private/link-local/metadata endpoints)
3. Fetch article HTML
4. Extract readable text with `@mozilla/readability` + `jsdom`
5. Normalize and limit text length
6. Call Azure AI Speech TTS using managed identity (Microsoft Entra token)
7. Return `audio/mpeg`

### Live progress (Server-Sent Events)

`POST /api/read` supports a streaming progress mode for a better loading
experience. When the request includes `Accept: text/event-stream`, the endpoint
streams progress events as each phase runs instead of blocking until the audio
is ready:

- `progress` events report the current `stage`
  (`validating` → `fetching` → `extracting` → `synthesizing` → `done`), an
  overall `progress` fraction (0–1), and a human-readable `message`. The
  `synthesizing` stage reports sub-progress derived from Azure Speech word
  boundary events.
- A final `audio` event carries the base64-encoded `audio/mpeg` payload.
- An `error` event carries the `statusCode` and error `message` if a phase fails.

The frontend uses this stream to render a staged progress bar so users can see
whether the app is fetching the article or converting it to speech, and how far
along it is.

Without the `Accept: text/event-stream` header, the endpoint keeps its original
behavior and returns the audio directly as `audio/mpeg`.

## Local development

```bash
npm install
npm run dev
```

App runs on `http://localhost:8080` by default.

Required environment variables for TTS:

- `SPEECH_ENDPOINT` (custom subdomain endpoint, e.g. `https://<name>.cognitiveservices.azure.com`)
- `SPEECH_RESOURCE_ID` (full Azure resource ID of Speech resource)
- `SPEECH_REGION` (Azure region of Speech resource, e.g. `swedencentral`)

Optional:

- `MAX_ARTICLE_CHARS` (default `5000` — keeps synthesis under the 10-minute service limit)
- `DEFAULT_VOICE` (default `en-US-JennyNeural`)
- `FETCH_TIMEOUT_MS` (default `20000`) — how long to wait when downloading the
  article before returning a `504` timeout. Increase it for slow sites.

## Deployment

### Infrastructure (Bicep)

Files:

- `infra/main.bicep`
- `infra/main.parameters.json`

The infra workflow deploys:

- Container Apps environment
- Container App (single container, ingress, scaling, managed identity)
- Speech resource (F0 + custom subdomain, Sweden Central for HD/MAI voice region support)
- Speech RBAC role assignment (`Cognitive Services Speech User` on the Speech
  resource for the Container App managed identity)
- Entra ID application + service principal for built-in auth, created declaratively
  via the Microsoft Graph Bicep extension
- Easy Auth (built-in authentication) configured declaratively in Bicep

### Built-in auth (no secrets required)

The Entra ID **app registration and service principal are created automatically** by
`infra/main.bicep` using the Microsoft Graph Bicep extension (`infra/bicepconfig.json`).
You do **not** need to create an app registration by hand or add any
`ENTRA_AUTH_CLIENT_ID` / `ENTRA_AUTH_CLIENT_SECRET` repository secrets.

Instead of a client secret, the Container App's **system-assigned managed identity** is
registered as a **federated identity credential** on the app registration, so Easy Auth
authenticates secret-free. The redirect URI
(`https://<container-app-fqdn>/.auth/login/aad/callback`) is set automatically from the
Container App FQDN.

> **Prerequisite:** the deployment service principal (`AZURE_CLIENT_ID`) must have
> permission to create Entra applications/service principals (e.g. the Graph
> `Application.ReadWrite.OwnedBy` app role, or an equivalent directory role). This
> repository's service principal already has these rights.

### GitHub Actions workflows

- `deploy-infra.yml`
  - Deploys Bicep infra
  - Creates the Container App from a **public bootstrap image**
    (`mcr.microsoft.com/k8se/quickstart:latest`) on first run so it does not depend
    on the private app image existing yet
  - Re-runs are **idempotent on the image**: if the Container App already exists, the
    workflow preserves its current image instead of resetting it to the placeholder
  - Speech RBAC role assignment is provisioned declaratively by the Bicep template
  - Built-in auth (Entra app + service principal + Easy Auth) is provisioned
    declaratively by the Bicep template — no CLI auth step, no auth secrets
- `deploy-app.yml`
  - Builds and pushes container image to `ghcr.io`
  - Updates the Container App image to the freshly built tag

### First-time deployment order

1. Run **Deploy Infrastructure** first (push to `infra/**` or trigger manually). This
   creates the Container App with the public bootstrap image.
2. **Deploy App** then runs automatically when Deploy Infrastructure completes
   successfully (via `workflow_run`), or can be triggered manually. It builds/pushes
   the real image and swaps the placeholder for the real image.

### GHCR package visibility

The image is published to `ghcr.io` and the package is **public**, so the Container App
pulls it directly with no registry credentials required. If you later make the package
private, you must configure pull credentials on the Container App
(e.g. `az containerapp registry set --server ghcr.io ...` with a PAT that has
`read:packages`).

## Usage

To authenticate with Azure in a GitHub Actions workflow:

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: azure/login@v2
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

## Voices: MAI-Voice-1 vs MAI-Voice-2

The app offers Microsoft AI **MAI** voices alongside standard/HD neural voices.
The two MAI generations reach the service through **different protocols**, so the
app routes them accordingly:

| Generation | Example voice id | Protocol | How the app calls it |
|---|---|---|---|
| **MAI-Voice-2** (newest, default) | `en-US-Harper:MAI-Voice-2` | **REST only** | `synthesizeSpeechRest()` → `POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1` |
| **MAI-Voice-1** | `en-us-Iris:MAI-Voice-1` | Speech SDK | `synthesizeSpeechSdk()` (`speakSsmlAsync`) |

MAI-Voice-2 is **not available over the Speech SDK WebSocket** — it fails with
error `1007` / HTTP 422. `synthesizeSpeech()` therefore dispatches any
`*:MAI-Voice-2` voice to the REST path and everything else to the SDK path. The
REST call authenticates with a Microsoft Entra token in the Speech-specific
`Authorization: Bearer aad#<resourceId>#<token>` form (a plain bearer token is
rejected with 401) and retries transient `400`/`429`/`5xx` responses, which the
F0 (free) tier can emit under burst load.

The default voice is **`en-US-Harper:MAI-Voice-2`**. The frontend also exposes
MAI-Voice-2 voices for Spanish, French, German, Portuguese, Italian, Chinese and
Hindi.

## Testing the live deployment

The live app is protected by **Easy Auth (Microsoft Entra ID)**, so anonymous
requests to protected routes are redirected to login. To test it as **yourself**
(no client secret, no service principal), the auth app **pre-authorizes the
Azure CLI** so you can mint a Microsoft Entra access token for the app with the
Azure CLI and call the API with it.

This is wired up across `infra/main.bicep` and `.github/workflows/deploy-infra.yml`: the auth app
exposes a `user_impersonation` delegated scope and sets `requestedAccessTokenVersion: 2` (so the
token's issuer/audience match what Easy Auth validates), and the deploy workflow then **pre-authorizes
the Azure CLI** first-party client (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) for that scope via an
idempotent Microsoft Graph `PATCH` after the Bicep deploy. (The pre-authorization is applied in the
workflow rather than directly in Bicep because the Microsoft Graph Bicep extension validates
`preAuthorizedApplications` against scopes that don't exist yet when the scope is first created.) With
the CLI pre-authorized, no consent prompt is required.

### Run the smoke test

```bash
az login
npm run test:live
```

`npm run test:live` runs `scripts/smoke-test-live.mjs`, which:

1. `GET /health` — unauthenticated, must return `{ ok: true }`.
2. `GET /` **without** a token — must be redirected (`302`/`401`), proving Easy
   Auth is still enforced.
3. Discovers the auth app client id (`az containerapp auth show`) and mints a
   user token: `az account get-access-token --scope "<clientId>/.default"`.
4. `GET /api/me` with the token — must return your identity from the Easy Auth
   `x-ms-client-principal-*` headers.
5. `POST /api/preview` with the token — must extract the article (no TTS, no cost).
6. *(opt-in)* `POST /api/read` end-to-end TTS — only runs when `SMOKE_TEST_READ=1`
   (it is billable).

The script exits non-zero if any check fails.

### Manual token (one-off)

```bash
# Discover the auth app client id
CLIENT_ID=$(az containerapp auth show -g rg-test-repo -n ca-articletts \
  --query identityProviders.azureActiveDirectory.registration.clientId -o tsv)

# Mint a user access token for the app
TOKEN=$(az account get-access-token --scope "$CLIENT_ID/.default" --query accessToken -o tsv)

# Call the protected API
curl -s -H "Authorization: Bearer $TOKEN" \
  https://<container-app-fqdn>/api/me
```

> If `az account get-access-token` reports `consent_required` (AADSTS65001), the
> pre-authorization in `infra/main.bicep` has not been deployed yet — run
> **Deploy Infrastructure** first.

### Configuration overrides

| Env var | Default | Purpose |
|---|---|---|
| `APP_BASE_URL` | live Container App FQDN | Target a different deployment |
| `AUTH_APP_CLIENT_ID` | auto-discovered via `az` | Skip discovery |
| `RESOURCE_GROUP` / `CONTAINER_APP` | `rg-test-repo` / `ca-articletts` | Discovery source |
| `SMOKE_TEST_READ` | unset | Set to `1` to run the billable `/api/read` test |
| `SMOKE_TEST_VOICE` | `en-US-Harper:MAI-Voice-2` | Voice for the read test |
| `SMOKE_TEST_URL` | `https://example.com` | Article URL for preview/read |

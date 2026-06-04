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

## Local development

```bash
npm install
npm run dev
```

App runs on `http://localhost:8080` by default.

Required environment variables for TTS:

- `SPEECH_ENDPOINT` (custom subdomain endpoint, e.g. `https://<name>.cognitiveservices.azure.com`)
- `SPEECH_RESOURCE_ID` (full Azure resource ID of Speech resource)

Optional:

- `MAX_ARTICLE_CHARS` (default `12000`)
- `DEFAULT_VOICE` (default `en-US-JennyNeural`)

## Deployment

### Infrastructure (Bicep)

Files:

- `infra/main.bicep`
- `infra/main.parameters.json`

The infra workflow deploys:

- Container Apps environment
- Container App (single container, ingress, scaling, managed identity)
- Speech resource (F0 + custom subdomain)
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

# AGENTS.md

Agent instructions for the **Article-to-Speech** app — a Node.js/TypeScript Express server
deployed as an Azure Container App that converts web articles to MP3 audio via Azure AI Speech.

---

## Build, lint & test

```bash
npm install          # install deps
npm run lint         # tsc --noEmit (type-check only, no test runner needed)
npm run build        # tsc + copy src/public → dist/public
npm run dev          # tsx watch src/server.ts (hot-reload, port 8080)
npm test             # node --test (currently no tests written)
```

Always run `npm run lint` before committing. There is no ESLint — TypeScript strict mode is the linter.

---

## Local dev setup

The app uses `DefaultAzureCredential`. Locally this resolves to `az login`. You **must** also
have the `Cognitive Services Speech User` RBAC role on the Speech resource for your user account.

1. `az login`
2. Load env vars from the deployed Container App:

```bash
# PowerShell
$env:SPEECH_ENDPOINT = az containerapp show -g rg-test-repo -n ca-articletts --query "properties.template.containers[0].env[?name=='SPEECH_ENDPOINT'].value" -o tsv
$env:SPEECH_RESOURCE_ID = az containerapp show -g rg-test-repo -n ca-articletts --query "properties.template.containers[0].env[?name=='SPEECH_RESOURCE_ID'].value" -o tsv
$env:SPEECH_REGION = az containerapp show -g rg-test-repo -n ca-articletts --query "properties.template.containers[0].env[?name=='SPEECH_REGION'].value" -o tsv
$env:AZURE_STORAGE_ACCOUNT_URL = az containerapp show -g rg-test-repo -n ca-articletts --query "properties.template.containers[0].env[?name=='AZURE_STORAGE_ACCOUNT_URL'].value" -o tsv
$env:AZURE_STORAGE_BLOB_URL = az containerapp show -g rg-test-repo -n ca-articletts --query "properties.template.containers[0].env[?name=='AZURE_STORAGE_BLOB_URL'].value" -o tsv
```

3. `npm run dev` → `http://localhost:8080`

Easy Auth (Entra login) is **not** active locally. The app runs without authentication in dev.

---

## Architecture

Single file: `src/server.ts`. Single container. No microservices.

```
src/
  server.ts          # everything: Express routes, TTS, storage, chunking, logging
  public/
    index.html       # single-page frontend (all JS inline, no build step)
infra/
  main.bicep         # all Azure resources declaratively
  bicepconfig.json   # enables Microsoft Graph Bicep extension for Entra auth
.github/workflows/
  deploy-infra.yml   # triggers on infra/** changes
  deploy-app.yml     # triggers on src/**, package.json, Dockerfile changes
```

Key server responsibilities:

| Function | What it does |
|---|---|
| `splitIntoChunks()` | Splits text at sentence boundaries into ≤4,500-char chunks |
| `synthesizeSpeech()` | One TTS call per chunk; returns `Buffer` of MP3 audio |
| `generateArticleAudio()` | Orchestrates chunking → sequential synthesis → concat → blob upload |
| `recordUsage()` | Writes character count to Azure Table Storage monthly row |
| `getUsageStats()` | Reads usage row; falls back to in-memory if no storage configured |

---

## Critical constraints — do not change without understanding why

### Speech auth token format
**Must** use `SpeechConfig.fromAuthorizationToken(aad#<resourceId>#<token>, region)`.
Using `fromEndpoint` breaks synthesizers (works only for recognizers). The `aad#` prefix is a
Speech SDK WebSocket protocol convention that tells the regional TTS endpoint which Speech resource
to authenticate against.

### Chunk size limit (4,500 chars)
Azure TTS WebSocket sessions have a hard **600-second** time limit. At ~750 chars/min, 4,500 chars
≈ 6 minutes, giving headroom. Do **not** raise `CHUNK_SIZE` above 4,500.

### Voice availability (swedencentral F0)
The Speech resource is in **swedencentral** on the F0 (free) tier. Not all voices are available
there. HD/DragonHD voices (`*:DragonHDLatestNeural`) are **not** available on F0. When adding
voices, verify availability first. SDK error 1007 = voice unavailable → already returns HTTP 422.

### MAI voices: MAI-Voice-1 (SDK) vs MAI-Voice-2 (REST only)
swedencentral supports MAI voices. The app uses a **hybrid synthesis dispatcher** in
`synthesizeSpeech()`:
- **MAI-Voice-1** (e.g. `en-us-Iris:MAI-Voice-1`, lowercase `en-us`) works on F0 through the Speech
  **SDK** (`speakSsmlAsync`) → handled by `synthesizeSpeechSdk()`.
- **MAI-Voice-2** (e.g. `en-US-Harper:MAI-Voice-2`) is **REST-API only**. Over the SDK WebSocket it
  intermittently returns error **1007** (→ HTTP 422), so `isRestOnlyVoice()` (matches `:MAI-Voice-2`)
  routes it to `synthesizeSpeechRest()` instead. **`en-US-Harper:MAI-Voice-2` is the app default.**

`synthesizeSpeechRest()` POSTs SSML to `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`
with `Authorization: Bearer aad#<resourceId>#<token>` (plain bearer → 401), derives `xml:lang` from the
voice locale via `voiceLocale()`, and **retries** transient `400`/`429`/`5xx` (the F0 tier throttles
bursts; a persistent `400` is surfaced as HTTP 422 = unavailable voice). Verified-reliable MAI-Voice-2
IDs: Harper/Olivia/Ethan (en-US) plus es-MX-Valeria, fr-FR-Soleil, de-DE-Mia, pt-BR-Luana, it-IT-Rosa,
zh-CN-Mei, hi-IN-Priya. `ko-KR-Hana:MAI-Voice-2` is **not** available on this resource.

### `disableLocalAuth: true` on Speech resource
Subscription key auth is disabled. Only AAD tokens work. Never switch to key-based auth.

---

## Azure resources (rg-test-repo, norwayeast)

| Resource | Name | Notes |
|---|---|---|
| Container App | `ca-articletts` | `minReplicas: 0` — scales to zero when idle |
| Container App Env | `cae-articletts` | Logs → Log Analytics `log-articletts` |
| Speech | `sp<hash>` | swedencentral, F0, custom subdomain |
| Storage Account | `st<hash>` | Table: usage tracking · Blob: recordings |
| Log Analytics | `log-articletts` | 30-day retention, all container stdout/stderr |

### RBAC on Container App managed identity
- `Cognitive Services Speech User` on the Speech resource
- `Storage Table Data Contributor` on Storage Account
- `Storage Blob Data Contributor` on Storage Account

---

## Deployment

**App changes** (`src/**`, `Dockerfile`, `package.json`) → push to `main` → `deploy-app.yml`
builds Docker image → GHCR → updates Container App image (~75s).

**Infra changes** (`infra/**`) → push to `main` → `deploy-infra.yml` runs Bicep deployment.
Infra redeploys are idempotent: the workflow preserves the current container image.

> After an infra redeploy that creates a **new Speech resource**, the local user's RBAC is reset.
> Re-run the RBAC assignment: `az role assignment create --role "f2dc8367-1007-4938-bd23-fe263f013447" --assignee <your-upn> --scope <speech-resource-id>`

---

## Testing the live deployment (Easy Auth)

The live app is behind Easy Auth (Entra). To test it as the current user without a secret:

```bash
az login
npm run test:live   # scripts/smoke-test-live.mjs
```

How auth works for tests: the auth app exposes a `user_impersonation` scope (stable id
`authAppUserImpersonationScopeId`) and sets `requestedAccessTokenVersion: 2` in `infra/main.bicep`, and
`deploy-infra.yml` then **pre-authorizes the Azure CLI** public client
(`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) for that scope via an idempotent Microsoft Graph `PATCH` after
the Bicep deploy (the Graph Bicep extension can't set `preAuthorizedApplications` in the same operation
that first creates the scope). v2 tokens make the `iss`/`aud` match the v2 issuer + `allowedAudiences`
(the app's `appId`) that Easy Auth validates. The script then runs
`az account get-access-token --scope "<authAppClientId>/.default"` and calls the API with
`Authorization: Bearer <token>`.

The smoke test checks `/health` (200), unauthenticated `GET /` (must still be 302/401 → auth intact),
`/api/me` (200 + identity), and `/api/preview` (200). `SMOKE_TEST_READ=1` also runs a billable
`/api/read`. **If `az account get-access-token` returns `consent_required` (AADSTS65001), the Bicep
pre-auth has not been deployed yet — deploy infra first.** This change is additive and does not alter
Easy Auth validation; after deploying, confirm unauthenticated `GET /` is still redirected.

---

## Logging

All container stdout/stderr goes to **Log Analytics workspace `log-articletts`**.
Logs survive container scale-to-zero.

Useful KQL (Azure Portal → Log Analytics workspaces → log-articletts → Logs):

```kusto
// All app logs (our Node.js container only)
ContainerAppConsoleLogs_CL
| where ContainerName_s == 'web'
| project TimeGenerated, Log_s
| order by TimeGenerated desc

// Errors only
ContainerAppConsoleLogs_CL
| where ContainerName_s == 'web' and Log_s has '[ERROR]'
| order by TimeGenerated desc

// Scaling / restart events
ContainerAppSystemLogs_CL
| project TimeGenerated, Reason_s, Log_s
| order by TimeGenerated desc
```

The `http-auth` container in the same logs is the Easy Auth sidecar — filter it out with
`ContainerName_s == 'web'` to see only app logs.

---

## API surface

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Frontend SPA |
| `GET` | `/health` | `{ ok: true }` |
| `GET` | `/api/me` | Easy Auth identity headers |
| `GET` | `/api/usage` | Monthly character usage vs 500K free tier |
| `POST` | `/api/preview` | `{ url }` → `{ chars, truncated, title }` (no TTS) |
| `POST` | `/api/read` | `{ url, voice, language }` → `audio/mpeg` |
| `GET` | `/api/recordings` | List saved recordings from Blob Storage |
| `GET` | `/api/recordings/:name/audio` | Stream a saved MP3 |
| `DELETE` | `/api/recordings/:name` | Delete a saved recording |

Rate limits: `/api/read` = 6 req/min · `/api/preview` = 10 req/min · `/api/recordings` = 60 req/min.

---

## Env vars

| Variable | Required | Description |
|---|---|---|
| `SPEECH_ENDPOINT` | Yes | Custom subdomain endpoint (`https://<name>.cognitiveservices.azure.com`) |
| `SPEECH_RESOURCE_ID` | Yes | Full Azure resource ID of the Speech resource |
| `SPEECH_REGION` | Yes | Azure region, e.g. `swedencentral` |
| `AZURE_STORAGE_ACCOUNT_URL` | No | Table endpoint; falls back to in-memory usage tracking |
| `AZURE_STORAGE_BLOB_URL` | No | Blob endpoint; recordings disabled if unset |
| `PORT` | No | Default `8080` |
| `MAX_ARTICLE_CHARS` | No | Default `50000`; truncates article before TTS |
| `DEFAULT_VOICE` | No | Default `en-US-JennyNeural` |
| `FETCH_TIMEOUT_MS` | No | Default `20000` ms for article fetch |

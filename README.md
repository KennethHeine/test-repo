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

### Usage

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
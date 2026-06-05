extension microsoftGraphV1

param location string = resourceGroup().location
@description('Region for the Azure AI Speech resource. Defaults to Sweden Central for HD (DragonHD) voices.')
param speechLocation string = 'swedencentral'
param containerAppEnvName string = 'cae-articletts'
param containerAppName string = 'ca-articletts'
@description('Container image to deploy. Defaults to a public bootstrap placeholder so the Container App can be created before the real private GHCR image exists. The deploy-app workflow swaps in the real image.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'
param speechAccountName string = 'sp${take(uniqueString(subscription().id, resourceGroup().id, speechLocation), 20)}'
param speechCustomSubdomain string = 'sp${take(uniqueString(resourceGroup().id, 'speech-subdomain', speechLocation), 20)}'
param storageAccountName string = 'st${take(uniqueString(subscription().id, resourceGroup().id), 20)}'
param maxReplicas int = 1
param minReplicas int = 0

@description('Display name for the Entra ID application used by Container Apps built-in auth (Easy Auth).')
param authAppDisplayName string = 'ca-articletts-auth'

@description('Unique name (tenant-wide) for the auth Entra application. Used for idempotent redeployments.')
param authAppUniqueName string = 'ca-articletts-auth-${uniqueString(subscription().id, resourceGroup().id)}'

// OpenID Connect issuer for this tenant. Also used as the issuer that the federated
// identity credential trusts so the Container App managed identity can act as the
// auth application without any client secret.
var entraIssuer = '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvName
  location: location
  properties: {
    zoneRedundant: false
  }
}

resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: speechAccountName
  location: speechLocation
  sku: {
    name: 'F0'
  }
  kind: 'SpeechServices'
  properties: {
    customSubDomainName: speechCustomSubdomain
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      activeRevisionsMode: 'Single'
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'SPEECH_ENDPOINT'
              value: 'https://${speechCustomSubdomain}.cognitiveservices.azure.com'
            }
            {
              name: 'SPEECH_RESOURCE_ID'
              value: speech.id
            }
            {
              name: 'SPEECH_REGION'
              value: speech.location
            }
            {
              name: 'MAX_ARTICLE_CHARS'
              value: '50000'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: 'https://${storageAccount.name}.table.core.windows.net'
            }
            {
              name: 'AZURE_STORAGE_BLOB_URL'
              value: 'https://${storageAccount.name}.blob.core.windows.net'
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RBAC: allow the Container App's system-assigned managed identity to call the
// Speech resource using Microsoft Entra tokens (local key auth is disabled).
//
// Declared here so the role assignment is part of the infrastructure-as-code
// instead of an imperative `az role assignment` step in the deploy workflow.
// The deterministic guid name makes redeployments idempotent.
// ---------------------------------------------------------------------------

@description('Built-in "Cognitive Services Speech User" role definition ID.')
var speechUserRoleDefinitionId = 'f2dc8367-1007-4938-bd23-fe263f013447'

resource speechRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: speech
  name: guid(speech.id, containerApp.id, speechUserRoleDefinitionId)
  properties: {
    principalId: containerApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', speechUserRoleDefinitionId)
    principalType: 'ServicePrincipal'
  }
}

@description('Built-in "Storage Table Data Contributor" role definition ID.')
var storageTableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource storageTableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, containerApp.id, storageTableContributorRoleId)
  properties: {
    principalId: containerApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableContributorRoleId)
    principalType: 'ServicePrincipal'
  }
}

@description('Built-in "Storage Blob Data Contributor" role definition ID.')
var storageBlobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource storageBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, containerApp.id, storageBlobContributorRoleId)
  properties: {
    principalId: containerApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobContributorRoleId)
    principalType: 'ServicePrincipal'
  }
}

output containerAppName string = containerApp.name
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output containerAppPrincipalId string = containerApp.identity.principalId
output speechResourceId string = speech.id
output speechEndpoint string = 'https://${speechCustomSubdomain}.cognitiveservices.azure.com'
output storageAccountUrl string = 'https://${storageAccount.name}.table.core.windows.net'
output storageBlobUrl string = 'https://${storageAccount.name}.blob.core.windows.net'

// ---------------------------------------------------------------------------
// Entra ID application for Container Apps built-in auth (Easy Auth).
//
// Created declaratively via the Microsoft Graph Bicep extension so no app
// registration has to be created by hand and no client id/secret has to be
// stored as a GitHub secret. The Container App's system-assigned managed
// identity is registered as a federated identity credential on the app, so
// Easy Auth authenticates using the managed identity instead of a client
// secret (secret-less).
// ---------------------------------------------------------------------------

resource authApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: authAppUniqueName
  displayName: authAppDisplayName
  signInAudience: 'AzureADMyOrg'
  web: {
    redirectUris: [
      'https://${containerApp.properties.configuration.ingress.fqdn}/.auth/login/aad/callback'
    ]
    implicitGrantSettings: {
      enableIdTokenIssuance: true
    }
  }
  requiredResourceAccess: [
    {
      // Microsoft Graph
      resourceAppId: '00000003-0000-0000-c000-000000000000'
      resourceAccess: [
        {
          // User.Read (delegated)
          id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
          type: 'Scope'
        }
      ]
    }
  ]
}

// Trust the Container App's managed identity so Easy Auth needs no client secret.
resource authFederatedCredential 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {
  name: '${authApp.uniqueName}/containerAppMI'
  audiences: [
    'api://AzureADTokenExchange'
  ]
  issuer: entraIssuer
  subject: containerApp.identity.principalId
}

resource authServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: authApp.appId
}

// Container Apps built-in auth configuration (Easy Auth) wired to the app above.
resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: containerApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      redirectToProvider: 'azureactivedirectory'
      unauthenticatedClientAction: 'RedirectToLoginPage'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authApp.appId
          // No clientSecretSettingName: the Container App managed identity
          // federates to the app registration (federatedIdentityCredentials above).
          openIdIssuer: entraIssuer
        }
        validation: {
          allowedAudiences: [
            authApp.appId
          ]
        }
      }
    }
  }
  dependsOn: [
    authServicePrincipal
  ]
}

output authAppClientId string = authApp.appId
output authAppServicePrincipalId string = authServicePrincipal.id

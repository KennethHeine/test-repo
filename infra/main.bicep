param location string = resourceGroup().location
param containerAppEnvName string = 'cae-articletts'
param containerAppName string = 'ca-articletts'
param image string
param speechAccountName string = 'sp${take(uniqueString(subscription().id, resourceGroup().id), 20)}'
param speechCustomSubdomain string = 'sp${take(uniqueString(resourceGroup().id, 'speech-subdomain'), 20)}'
param maxReplicas int = 1
param minReplicas int = 0

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvName
  location: location
  properties: {
    zoneRedundant: false
  }
}

resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: speechAccountName
  location: location
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
              name: 'MAX_ARTICLE_CHARS'
              value: '12000'
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

output containerAppName string = containerApp.name
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output containerAppPrincipalId string = containerApp.identity.principalId
output speechResourceId string = speech.id
output speechEndpoint string = 'https://${speechCustomSubdomain}.cognitiveservices.azure.com'

// Azure MCP: the remote hosting footprint, as code. One resource group.
//
// What it creates: a user-assigned identity, a container registry (no admin user; the identity pulls),
// a Log Analytics workspace, a Container Apps environment and the app itself.
//
// What it deliberately does NOT do:
//   - create or change the Entra app registration (identity is a separate, human-approved change:
//     scripts/entra-setup.sh);
//   - grant the app's identity any Azure RBAC. In on_behalf_of mode it needs none: every call runs as
//     the signed-in caller. In managed_identity mode, granting it Reader (or more) on a subscription is
//     a deliberate decision made with `az role assignment create`, not a side effect of a deploy;
//   - open the write gate. azureMode defaults to read.
//
//   az deployment group what-if -g <rg> -f infra/main.bicep -p infra/main.bicepparam
//   az deployment group create  -g <rg> -f infra/main.bicep -p infra/main.bicepparam

targetScope = 'resourceGroup'

@description('Short name stem for every resource. Keep it stable: renaming re-creates.')
param appName string = 'azure-mcp'

param location string = resourceGroup().location

@description('Container image tag, as <version>-<short sha>. The deploy script derives it from package.json and git.')
param imageTag string = 'bootstrap'

@description('Deploy the container app. The deploy script runs once with false to create the registry, pushes the image, then runs with true.')
param deployApp bool = true

@description('Entra tenant that issues caller tokens.')
param entraTenantId string

@description('Application (client) ID of the "Azure MCP" app registration. Not a secret.')
param entraClientId string

@description('on_behalf_of: every Azure call runs as the signed-in caller (recommended). managed_identity: every call runs as this app\'s identity, and the Azure CLI tools work.')
@allowed([ 'on_behalf_of', 'managed_identity' ])
param remoteIdentity string = 'on_behalf_of'

@description('read refuses every change. write enables the write tier for callers holding Azure.Write.')
@allowed([ 'read', 'write' ])
param azureMode string = 'read'

@description('Second gate for deletes, stops and restarts. Has no effect unless azureMode is write.')
param allowDestructive bool = false

@description('Default subscription for tools called without subscription_id. Empty: the only subscription the identity can reach.')
param defaultSubscriptionId string = ''

param mcpPath string = '/mcp'

@minValue(0)
@maxValue(1)
param minReplicas int = 0

@minValue(1)
@maxValue(5)
param maxReplicas int = 2

@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

var registryName = take(replace('acr${appName}${uniqueString(resourceGroup().id)}', '-', ''), 50)
var tags = { app: appName, managedBy: 'infra/main.bicep' }

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${appName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
  }
}

var appHost = 'ca-${appName}.${environment.properties.defaultDomain}'

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: 'ca-${appName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'Auto'
        allowInsecure: false
        traffic: [ { weight: 100, latestRevision: true } ]
      }
      registries: [ { server: registry.properties.loginServer, identity: identity.id } ]
      maxInactiveRevisions: 5
    }
    template: {
      containers: [
        {
          name: 'azure-mcp'
          image: '${registry.properties.loginServer}/${appName}:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'PUBLIC_URL', value: 'https://${appHost}' }
            { name: 'MCP_PATH', value: mcpPath }
            { name: 'AZURE_REMOTE_IDENTITY', value: remoteIdentity }
            { name: 'AZURE_AUTH', value: 'managed_identity' }
            { name: 'MANAGED_IDENTITY_CLIENT_ID', value: identity.properties.clientId }
            { name: 'AZURE_TENANT_ID', value: entraTenantId }
            { name: 'AZURE_SUBSCRIPTION_ID', value: defaultSubscriptionId }
            { name: 'AZURE_MODE', value: azureMode }
            { name: 'AZURE_ALLOW_DESTRUCTIVE', value: string(allowDestructive) }
          ]
          probes: [
            { type: 'Startup', httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 12 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }, periodSeconds: 15, timeoutSeconds: 3, failureThreshold: 3 }
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 15, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3 }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [ { name: 'http-concurrency', http: { metadata: { concurrentRequests: '20' } } } ]
      }
    }
  }
  dependsOn: [ acrPull ]
}

@description('The HTTPS origin. Add <this>/mcp as the custom connector URL in Claude.')
output publicUrl string = 'https://${appHost}'

@description('The OAuth resource identifier the Entra app must list as an Application ID URI.')
output oauthResource string = 'https://${appHost}${mcpPath}'

output loginServer string = registry.properties.loginServer
output registryName string = registry.name

@description('Object id of the app identity: the subject of the Entra app\'s federated credential for on-behalf-of.')
output identityPrincipalId string = identity.properties.principalId
output identityClientId string = identity.properties.clientId

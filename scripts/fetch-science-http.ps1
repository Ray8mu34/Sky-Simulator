param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -Uri $Url -OutFile $Destination -TimeoutSec 45

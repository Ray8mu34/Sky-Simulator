[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{16}$')][string]$ExpectedBuildId,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedPortableSHA256,
    [Parameter(Mandatory)][string]$CPUReport,
    [Parameter(Mandatory)][string]$EvidenceIndex,
    [Parameter(Mandatory)][string]$AcceptanceDocument,
    [Parameter(Mandatory)][string]$LimitationsDocument,
    [string]$LedgerDocument = 'docs/FINAL-ACCEPTANCE-LEDGER.md',
    [string[]]$AdditionalDocuments = @('README.md', 'docs/REQUIREMENTS-TRACEABILITY.md',
        'docs/FINAL-SCIENCE-CLOSURE.md', 'docs/FINAL-ACCEPTANCE-MATRIX.md'),
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
    [switch]$PreflightOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).ProviderPath
$targetPath = [IO.Path]::GetFullPath((Join-Path $workspacePath 'releases/final-local'))
$ExpectedBuildId = $ExpectedBuildId.ToLowerInvariant()
$ExpectedPortableSHA256 = $ExpectedPortableSHA256.ToLowerInvariant()

function Get-WorkspacePath([string]$Path) {
    $absolute = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) }
        else { [IO.Path]::GetFullPath((Join-Path $workspacePath $Path)) }
    $prefix = $workspacePath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path must stay inside this workspace: $Path"
    }
    return $absolute
}
function Get-SHA256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label mismatch: expected [$Expected], actual [$Actual]" }
}
function Read-JSON([string]$Path) {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}
function Assert-NoReparsePoints([string]$Path, [switch]$OnlyItem) {
    $items = @((Get-Item -LiteralPath $Path -Force))
    if (-not $OnlyItem -and (Test-Path -LiteralPath $Path -PathType Container)) { $items += Get-ChildItem -LiteralPath $Path -Force -Recurse }
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Archive source/parent may not be a junction or symlink: $($item.FullName)"
        }
    }
}
function Get-SourceHashes {
    $hashes = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $workspacePath 'src') -File -Recurse -Force | Sort-Object FullName) {
        $relative = [IO.Path]::GetRelativePath($workspacePath, $file.FullName).Replace('\', '/')
        $hashes[$relative] = Get-SHA256 $file.FullName
    }
    return $hashes
}
function Assert-SourceHashes($Actual, $Expected) {
    Assert-Equal $Actual.Count 87 'src file count'
    Assert-Equal @($Expected.PSObject.Properties).Count 87 'CPU source hash count'
    foreach ($key in $Actual.Keys) {
        $property = $Expected.PSObject.Properties[$key]
        if ($null -eq $property) { throw "CPU source manifest is missing $key" }
        Assert-Equal $Actual[$key] ([string]$property.Value).ToLowerInvariant() "Source $key"
    }
}
function Get-CoreChecks([string]$WebRoot, $Core) {
    $checks = @()
    foreach ($file in $Core) {
        $url = [string]$file.url
        if (-not $url.StartsWith('./') -or $url -match '[?#%]' -or $url.Split('/') -contains '..') {
            throw "Invalid offline core path: $url"
        }
        $relative = $url.Substring(2)
        $path = [IO.Path]::GetFullPath((Join-Path $WebRoot $relative))
        $prefix = $WebRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Core path escapes Web root: $url" }
        $hash = Get-SHA256 $path
        Assert-Equal $hash ([string]$file.sha256).ToLowerInvariant() "Web offlineCore $url"
        $checks += [pscustomobject]@{ path = $url; sha256 = $hash; bytes = (Get-Item -LiteralPath $path).Length }
    }
    if ($checks.Count -eq 0) { throw 'Web offlineCore must not be empty.' }
    return $checks
}

if (Test-Path -LiteralPath $targetPath) { throw "Archive target already exists; no overwrite, move or deletion is permitted: $targetPath" }
$releaseParent = Get-WorkspacePath 'releases'
Assert-NoReparsePoints $releaseParent -OnlyItem
$webPath = Get-WorkspacePath 'dist'
$portablePath = Get-WorkspacePath 'dist-portable/三维全景夜空.html'
$webReportPath = Get-WorkspacePath 'dist/build-report.json'
$portableReportPath = Get-WorkspacePath 'dist-portable/build-report.json'
$cpuPath = Get-WorkspacePath $CPUReport
$evidencePath = Get-WorkspacePath $EvidenceIndex
Assert-NoReparsePoints $webPath
Assert-NoReparsePoints (Get-WorkspacePath 'src')
Assert-NoReparsePoints (Get-WorkspacePath 'dist-portable')
$cpu = Read-JSON $cpuPath
Assert-Equal $cpu.status 'passed-final-source-cpu' 'CPU report status'
Assert-Equal $cpu.sourceChanged $false 'CPU sourceChanged'
Assert-Equal $cpu.tests.exitCode 0 'CPU tests exit code'
Assert-Equal $cpu.typecheck.exitCode 0 'typecheck exit code'
$sourceHashes = Get-SourceHashes
Assert-SourceHashes $sourceHashes $cpu.sourceBefore
Assert-SourceHashes $sourceHashes $cpu.sourceAfter

$webReport = Read-JSON $webReportPath
$portableReport = Read-JSON $portableReportPath
Assert-Equal $webReport.buildId $ExpectedBuildId 'Web buildId'
Assert-Equal $webReport.attributionComplete $true 'Web attribution'
Assert-Equal $webReport.initialCompressedWithinBudget $true 'Web compressed budget'
Assert-Equal $webReport.coreRawWithinBudget $true 'Web raw budget'
$coreChecks = @(Get-CoreChecks $webPath $webReport.offlineCore)
$htmlPath = Join-Path $webPath 'index.html'
$html = Get-Content -LiteralPath $htmlPath -Raw
$htmlBuildId = [regex]::Match($html, '<meta name="sky-build-id" content="([0-9a-f]+)"').Groups[1].Value
Assert-Equal $htmlBuildId $ExpectedBuildId 'HTML buildId'
$portableSHA = Get-SHA256 $portablePath
$portableBytes = (Get-Item -LiteralPath $portablePath).Length
Assert-Equal $portableSHA $ExpectedPortableSHA256 'Portable SHA256'
Assert-Equal $portableReport.sha256 $ExpectedPortableSHA256 'Portable report SHA256'
Assert-Equal $portableReport.bytes $portableBytes 'Portable report HTML bytes'
Assert-Equal $portableReport.withinBudget $true 'Portable byte budget'
Assert-Equal $portableReport.attributionComplete $true 'Portable attribution'

$documents = @($AcceptanceDocument, $LimitationsDocument, $LedgerDocument) + $AdditionalDocuments | Select-Object -Unique
$filesToCopy = @($CPUReport, $EvidenceIndex) + $documents + @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsconfig.json', 'vite.config.ts', 'index.html', '.gitignore') | Select-Object -Unique
$supportFiles = @()
foreach ($relative in $filesToCopy) {
    $absolute = Get-WorkspacePath $relative
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw "Missing required archive support file: $relative" }
    Assert-NoReparsePoints $absolute
    $supportFiles += [pscustomobject]@{ path = [IO.Path]::GetRelativePath($workspacePath, $absolute).Replace('\', '/');
        absolute = $absolute; sha256 = Get-SHA256 $absolute }
}
$preflight = [ordered]@{ status = 'verified-preflight-only'; target = $targetPath; buildId = $ExpectedBuildId;
    portableSha256 = $portableSHA; portableHtmlBytes = $portableBytes; webHtmlBytes = (Get-Item -LiteralPath $htmlPath).Length;
    sourceCount = $sourceHashes.Count; offlineCoreCount = $coreChecks.Count; supportFileCount = $supportFiles.Count;
    sourceHashes = $sourceHashes; offlineCore = $coreChecks; supportFiles = @($supportFiles | Select-Object path, sha256) }
if ($PreflightOnly) { $preflight | ConvertTo-Json -Depth 8; return }
if (-not $PSCmdlet.ShouldProcess($targetPath, 'Create a new verified local release archive by copying files')) { return }

# Nothing is created until all source, artifact and documentary preflight checks succeed.
New-Item -ItemType Directory -Path $targetPath -ErrorAction Stop | Out-Null
try {
    Copy-Item -LiteralPath $webPath -Destination (Join-Path $targetPath 'web') -Recurse
    Copy-Item -LiteralPath (Get-WorkspacePath 'src') -Destination (Join-Path $targetPath 'src') -Recurse
    Copy-Item -LiteralPath $portablePath -Destination (Join-Path $targetPath '三维全景夜空.html')
    Copy-Item -LiteralPath $portableReportPath -Destination (Join-Path $targetPath 'build-report.json')
    Copy-Item -LiteralPath $webReportPath -Destination (Join-Path $targetPath 'web-build-report.json')
    foreach ($file in $supportFiles) {
        $destination = Join-Path $targetPath $file.path
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $file.absolute -Destination $destination
        Assert-Equal (Get-SHA256 $destination) $file.sha256 "Copied support file $($file.path)"
    }
    $copiedCore = @(Get-CoreChecks (Join-Path $targetPath 'web') $webReport.offlineCore)
    Assert-Equal (Get-SHA256 (Join-Path $targetPath '三维全景夜空.html')) $portableSHA 'Archived portable'
    Assert-Equal (Get-SHA256 (Join-Path $targetPath 'web/index.html')) (Get-SHA256 $htmlPath) 'Archived Web HTML'
    foreach ($key in $sourceHashes.Keys) {
        Assert-Equal (Get-SHA256 (Join-Path $targetPath $key)) $sourceHashes[$key] "Archived source $key"
    }
    Assert-SourceHashes (Get-SourceHashes) $cpu.sourceAfter
    $sourceHashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $targetPath 'source-hashes.json') -Encoding utf8
    @"
这是经过校验的本地交付归档：便携单HTML、可部署Web目录、冻结src快照、配置及接受/限制/证据索引。
它不是自足的sourcezip；完整开发工程、构建脚本、运行资产、永久测试和完整历史QA仍在原项目根。
未复制129MB原始上游素材、node_modules、浏览器运行时或全部历史QA。证据索引链接应在原工程中读取。
web目录可按既有部署说明发布；本归档行为本身不表示已部署HTTPS、已验macOS Safari或实体移动PWA。
30分钟持续测试按用户要求暂缓。以随包接受文档、限制文档和逐条账本为准确验收范围。
"@ | Set-Content -LiteralPath (Join-Path $targetPath 'ARCHIVE-NOTES.txt') -Encoding utf8
    $preflight.status = 'verified-local-archive'
    $preflight.createdUtc = [DateTime]::UtcNow.ToString('o')
    $preflight | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $targetPath 'archive-verification.json') -Encoding utf8
    $manifest = foreach ($file in Get-ChildItem -LiteralPath $targetPath -File -Force -Recurse | Sort-Object FullName) {
        $relative = [IO.Path]::GetRelativePath($targetPath, $file.FullName).Replace('\', '/')
        '{0}  {1}' -f (Get-SHA256 $file.FullName), $relative
    }
    # The checksum file cannot hash itself; every other archive file is listed.
    $manifest | Set-Content -LiteralPath (Join-Path $targetPath 'SHA256SUMS.txt') -Encoding utf8
    Write-Output "Verified local archive created: $targetPath"
} catch {
    # Preserve incomplete output for diagnosis. Never delete/move it or overwrite a prior release.
    'Incomplete archive; inspect the original error. This directory must not be treated as a verified release.' |
        Set-Content -LiteralPath (Join-Path $targetPath 'ARCHIVE-INCOMPLETE.txt') -Encoding utf8
    throw
}

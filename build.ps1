param(
  [ValidateSet('debug','release')][string]$Mode = 'debug',
  [string]$DevEcoHome = '',
  [string]$SdkHome = '',
  [string]$ServiceUrl = ''
)
$ErrorActionPreference = 'Stop'
$workspace = $PSScriptRoot
$profilePath = Join-Path $workspace 'entry\build-profile.json5'
$originalProfile = [System.IO.File]::ReadAllText($profilePath)
$serviceField = [regex]::Match($originalProfile, '("SERVICE_URL"\s*:\s*)"([^"\r\n]*)"')
if (!$serviceField.Success) { throw '未找到 SERVICE_URL 构建字段。' }
$configuredUrl = if ($ServiceUrl) { $ServiceUrl } else { $serviceField.Groups[2].Value }

if ($Mode -eq 'release' -or $ServiceUrl) {
  $serviceUri = $null
  if (![Uri]::TryCreate($configuredUrl, [UriKind]::Absolute, [ref]$serviceUri) -or
      $serviceUri.Scheme -ne 'https' -or $serviceUri.UserInfo -or
      $serviceUri.AbsolutePath -ne '/' -or $serviceUri.Query -or $serviceUri.Fragment -or
      $serviceUri.IsLoopback -or $serviceUri.Host -eq 'example.com' -or $serviceUri.Host.EndsWith('.example.com')) {
    throw '正式构建需要真实的 HTTPS 服务地址；使用 -ServiceUrl https://你的域名，或填写 entry/build-profile.json5 的 SERVICE_URL。'
  }
  $configuredUrl = $serviceUri.GetLeftPart([UriPartial]::Authority)
}

if (!$DevEcoHome) {
  if ($env:DEVECO_STUDIO_HOME) { $DevEcoHome = $env:DEVECO_STUDIO_HOME }
  else { $DevEcoHome = Join-Path $env:ProgramFiles 'Huawei\DevEco Studio' }
}
$DevEcoHome = [System.IO.Path]::GetFullPath($DevEcoHome)
if (!$SdkHome) { $SdkHome = Join-Path $DevEcoHome 'sdk' }
$nodePath = Join-Path $DevEcoHome 'tools\node\node.exe'
$hvigorPath = Join-Path $DevEcoHome 'tools\hvigor\bin\hvigorw.js'
$javaHome = Join-Path $DevEcoHome 'jbr'
foreach ($required in @($nodePath,$hvigorPath,(Join-Path $javaHome 'bin\java.exe'),$SdkHome)) {
  if (!(Test-Path -LiteralPath $required)) { throw "未找到 $required；请使用 -DevEcoHome 或 -SdkHome 指定安装目录。" }
}

$previousSdk = $env:DEVECO_SDK_HOME
$previousJava = $env:JAVA_HOME
$previousPath = $env:Path
$profileChanged = $false
Push-Location $workspace
try {
  if ($ServiceUrl -or ($Mode -eq 'release' -and $configuredUrl -ne $serviceField.Groups[2].Value)) {
    $replacement = $serviceField.Groups[1].Value + '"' + $configuredUrl + '"'
    $temporaryProfile = $originalProfile.Remove($serviceField.Index,$serviceField.Length).Insert($serviceField.Index,$replacement)
    [System.IO.File]::WriteAllText($profilePath,$temporaryProfile,[System.Text.UTF8Encoding]::new($false))
    $profileChanged = $true
  }
  $env:DEVECO_SDK_HOME = [System.IO.Path]::GetFullPath($SdkHome)
  $env:JAVA_HOME = $javaHome
  $env:Path = (Join-Path $javaHome 'bin') + ';' + $env:Path
  $buildArguments = @($hvigorPath,'--mode','module','-p','product=default','-p','module=entry@default','-p',"buildMode=$Mode",'assembleHap','--no-daemon')
  & $nodePath @buildArguments
  if ($LASTEXITCODE -ne 0) { throw '鸿蒙编译失败，请查看上方构建错误。' }

  $outputDirectory = Join-Path $workspace 'entry\build\default\outputs\default'
  $hap = Get-ChildItem -LiteralPath $outputDirectory -File |
    Where-Object { $_.Name -match '^entry-default-(signed|unsigned)\.hap$' } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (!$hap) { throw '构建完成，但未找到 HAP 产物。' }
  $signature = if ($hap.Name -match '-unsigned\.hap$') { 'unsigned' } else { 'signed' }
  $appProfile = [System.IO.File]::ReadAllText((Join-Path $workspace 'AppScope\app.json5'))
  $versionName = [regex]::Match($appProfile,'"versionName"\s*:\s*"([^"\r\n]+)"').Groups[1].Value
  $versionCode = [long][regex]::Match($appProfile,'"versionCode"\s*:\s*(\d+)').Groups[1].Value
  if (!$versionName -or $versionCode -lt 1) { throw '应用版本信息无效。' }
  $artifactDirectory = Join-Path $workspace 'artifacts'
  New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
  $artifactName = "human-ai-$versionName-$Mode-$signature.hap"
  $artifactPath = Join-Path $artifactDirectory $artifactName
  Copy-Item -LiteralPath $hap.FullName -Destination $artifactPath -Force
  $manifest = [ordered]@{
    file = $artifactName
    versionName = $versionName
    versionCode = $versionCode
    mode = $Mode
    signature = $signature
    serviceUrl = if ($Mode -eq 'release') { $configuredUrl } else { '可在开发版登录页设置' }
    sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    bytes = (Get-Item -LiteralPath $artifactPath).Length
    builtAt = [DateTime]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText($artifactPath + '.json',($manifest | ConvertTo-Json) + [Environment]::NewLine,[System.Text.UTF8Encoding]::new($false))
  Write-Host "产物：$artifactPath"
  Write-Host "校验清单：$artifactPath.json"
  if ($signature -eq 'unsigned') { Write-Host '当前 HAP 未签名；请在 DevEco Studio 配置签名后重新构建，才能安装到真机。' }
}
finally {
  if ($profileChanged) { [System.IO.File]::WriteAllText($profilePath,$originalProfile,[System.Text.UTF8Encoding]::new($false)) }
  $env:DEVECO_SDK_HOME = $previousSdk
  $env:JAVA_HOME = $previousJava
  $env:Path = $previousPath
  Pop-Location
}

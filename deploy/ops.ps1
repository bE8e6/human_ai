param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('validate','start','stop','status','logs','stats','build','backup','list-backups','restore','upgrade','rollback')]
  [string]$Action,
  [ValidateSet('test','production')][string]$Environment = 'test',
  [string]$EnvFile = '',
  [string]$Backup = '',
  [string]$Image = ''
)
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'server\scripts\operate.mjs'
$taskArguments = @($scriptPath,$Action,'--environment',$Environment)
if ($EnvFile) { $taskArguments += @('--env-file',$EnvFile) }
if ($Backup) { $taskArguments += @('--backup',$Backup) }
if ($Image) { $taskArguments += @('--image',$Image) }
& node @taskArguments
if ($LASTEXITCODE -ne 0) { throw '操作未完成，请查看上方错误和部署说明。' }

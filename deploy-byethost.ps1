#Requires -Version 5
<#
.SYNOPSIS
  Envia o frontend estatico (public/) para o ByetHost via FTP.
  O backend Express continua no Vercel (o shim public/js/api-base.js cuida das /api).

.DESCRIPTION
  - Upload recursivo de public/ -> /htdocs (cria pastas automaticamente).
  - Sincronizacao incremental: pula arquivos com o mesmo tamanho do remoto.
  - Credenciais lidas (nesta ordem): parametros > .ftp.env > .env > variaveis de ambiente.
  - Se nao achar, pergunta no terminal.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy-byethost.ps1
  powershell -ExecutionPolicy Bypass -File .\deploy-byethost.ps1 -Force     # reenvia tudo
  powershell -ExecutionPolicy Bypass -File .\deploy-byethost.ps1 -DryRun    # apenas lista
#>
[CmdletBinding()]
param(
  [string]$LocalRoot  = "public",
  [string]$RemoteBase = "",
  [string]$FtpHost    = "",
  [string]$FtpUser    = "",
  [string]$FtpPass    = "",
  [string]$SiteUrl    = "https://nexora.byethost9.com",
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir -or -not (Test-Path -LiteralPath $scriptDir)) { $scriptDir = (Get-Location).Path }

function Read-EnvFile([string]$path) {
  $h = @{}
  if (-not (Test-Path -LiteralPath $path)) { return $h }
  foreach ($raw in (Get-Content -LiteralPath $path)) {
    $line = $raw.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { continue }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($v.Length -ge 2 -and $v[0] -eq '"' -and $v[$v.Length - 1] -eq '"') {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $h[$k] = $v
  }
  return $h
}

$envFtp = Read-EnvFile (Join-Path $scriptDir ".ftp.env")
$envApp = Read-EnvFile (Join-Path $scriptDir ".env")

function FromEnv([string]$key) {
  if ($envFtp.ContainsKey($key)) { return $envFtp[$key] }
  if ($envApp.ContainsKey($key)) { return $envApp[$key] }
  return [Environment]::GetEnvironmentVariable($key)
}

if (-not $FtpHost)    { $FtpHost = FromEnv "FTP_HOST" }
if (-not $FtpUser)    { $FtpUser = FromEnv "FTP_USER" }
if (-not $FtpPass)    { $FtpPass = FromEnv "FTP_PASS" }
if (-not $RemoteBase) { $RemoteBase = FromEnv "FTP_REMOTE" }
if (-not $FtpHost)    { $FtpHost = "ftp.byethost9.com" }
if (-not $RemoteBase) { $RemoteBase = "/htdocs" }
if ($RemoteBase -notmatch "^/") { $RemoteBase = "/$RemoteBase" }
$RemoteBase = $RemoteBase.TrimEnd("/")

if (-not $FtpUser) { $FtpUser = Read-Host "FTP usuario" }
if (-not $FtpPass) {
  $sec = Read-Host "FTP senha" -AsSecureString
  $FtpPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

$baseUrl = "ftp://$FtpHost"
$cred = New-Object System.Net.NetworkCredential($FtpUser, $FtpPass)
$excludePatterns = @('*.fixed', '*.map', '*.log')

function New-FtpRequest([string]$url, [string]$method, [bool]$binary = $false) {
  $req = [System.Net.FtpWebRequest]::Create($url)
  $req.Method = $method
  $req.Credentials = $cred
  $req.UsePassive = $true
  $req.UseBinary = $binary
  $req.KeepAlive = $false
  $req.Timeout = 60000
  return $req
}

function Ensure-RemoteDir([string]$remoteDir, [hashtable]$made) {
  if ($made.ContainsKey($remoteDir)) { return }
  $cur = ""
  foreach ($p in ($remoteDir.Trim("/").Split("/"))) {
    if ($p -eq "") { continue }
    $cur = "$cur/$p"
    if ($made.ContainsKey($cur)) { continue }
    try {
      $req = New-FtpRequest "$baseUrl$cur" ([System.Net.WebRequestMethods+Ftp]::MakeDirectory)
      $req.GetResponse().Close()
    } catch { }
    $made[$cur] = $true
  }
}

function Get-RemoteSizes([string]$remoteDir, [hashtable]$cache) {
  if ($cache.ContainsKey($remoteDir)) { return $cache[$remoteDir] }
  $map = @{}
  try {
    $req = New-FtpRequest "$baseUrl$remoteDir/" ([System.Net.WebRequestMethods+Ftp]::ListDirectoryDetails)
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $sr.ReadToEnd()
    $sr.Close(); $resp.Close()
    foreach ($line in ($text -split "`r?`n")) {
      $t = $line.Trim()
      if ($t -eq "") { continue }
      $m = [regex]::Match($t, '^[d-][rwxst-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+(?:\d{1,2}:\d{2}|\d{4})\s+(.+)$')
      if ($m.Success) {
        $s = [int64]$m.Groups[1].Value
        $nm = $m.Groups[2].Value.Trim()
        if ($nm -ne "." -and $nm -ne "..") { $map[$nm] = $s }
        continue
      }
      $m2 = [regex]::Match($t, '^\d{2}-\d{2}-\d{2,4}\s+\d{1,2}:\d{2}[AP]M\s+(<DIR>|[\d,]+)\s+(.+)$')
      if ($m2.Success -and $m2.Groups[2].Value -ne "<DIR>") {
        $map[$m2.Groups[3].Value.Trim()] = [int64]($m2.Groups[2].Value -replace ',', '')
      }
    }
  } catch { }
  $cache[$remoteDir] = $map
  return $map
}

function Upload-File([string]$local, [string]$remote) {
  $req = New-FtpRequest "$baseUrl$remote" ([System.Net.WebRequestMethods+Ftp]::UploadFile) $true
  $bytes = [System.IO.File]::ReadAllBytes($local)
  $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream()
  $s.Write($bytes, 0, $bytes.Length)
  $s.Close()
  $req.GetResponse().Close()
}

$rootFull = (Resolve-Path -LiteralPath $LocalRoot).Path
if (-not (Test-Path -LiteralPath $rootFull)) { throw "Pasta local nao encontrada: $LocalRoot" }

Write-Host "Deploy -> $baseUrl$RemoteBase  ($FtpUser)" -ForegroundColor Cyan
Write-Host ("Local:  {0}" -f $rootFull)
Write-Host ""

$made = @{}
$cache = @{}
$sent = 0; $skipped = 0; $failed = 0

foreach ($f in (Get-ChildItem -LiteralPath $rootFull -Recurse -File)) {
  $excluded = $false
  foreach ($pat in $excludePatterns) { if ($f.Name -like $pat) { $excluded = $true; break } }
  if ($excluded) { continue }

  $rel = $f.FullName.Substring($rootFull.Length).Replace("\", "/")
  $remote = "$RemoteBase$rel"
  $remoteDir = ($remote -replace "/[^/]+$", "")
  if (-not $remoteDir) { $remoteDir = $RemoteBase }

  if ($DryRun) { Write-Host ("  {0}" -f $rel); continue }

  Ensure-RemoteDir $remoteDir $made
  $sizes = Get-RemoteSizes $remoteDir $cache

  if (-not $Force -and $sizes.ContainsKey($f.Name) -and $sizes[$f.Name] -eq $f.Length) {
    Write-Host ("  = {0}" -f $rel) -ForegroundColor DarkGray
    $skipped++
    continue
  }

  try {
    Upload-File $f.FullName $remote
    $sizes[$f.Name] = $f.Length
    Write-Host ("  + {0}" -f $rel) -ForegroundColor Green
    $sent++
  } catch {
    Write-Host ("  ! {0} : {1}" -f $rel, $_.Exception.Message) -ForegroundColor Red
    $failed++
  }
}

Write-Host ""
Write-Host ("Pronto. Enviados: {0} | Ignorados: {1} | Falhas: {2}" -f $sent, $skipped, $failed) -ForegroundColor Cyan
Write-Host ("Site: {0}" -f $SiteUrl)
Write-Host "Obs: o ByetHost mostra um desafio anti-bot (cookie) na 1a visita; e normal no navegador."

if ($failed -gt 0) { exit 1 }

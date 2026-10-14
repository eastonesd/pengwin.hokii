$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if ($nodeCommand) { $nodeBinary = $nodeCommand.Source }
elseif (Test-Path -LiteralPath $bundledNode) { $nodeBinary = $bundledNode }
else { Write-Host 'Please install Node.js 22 or newer, then run this file again.'; Read-Host 'Press Enter'; exit 1 }
Write-Host 'Hokii Moneykeeper MVP - Pengwin'
Write-Host 'Demo cases work without an API key.'
if (-not $env:OPENAI_API_KEY) {
  $enableAi = Read-Host 'Enable real OpenAI document extraction? y / Enter for demo'
  if ($enableAi -eq 'y') {
    $secureKey = Read-Host 'OpenAI API key (hidden, kept only in this process)' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try { $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  }
}
if (-not $env:PORT) { $env:PORT = '8787' }
Write-Host "Open http://127.0.0.1:$env:PORT in your browser. Keep this window open."
try { & $nodeBinary 'server.mjs' }
finally { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue }

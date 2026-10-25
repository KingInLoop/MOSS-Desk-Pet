$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
try {
  $inputObject = $raw | ConvertFrom-Json
  $directory = Join-Path $env:USERPROFILE '.claude'
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $safe = [ordered]@{
    rate_limits = $inputObject.rate_limits
    captured_at = [DateTime]::UtcNow.ToString('o')
  }
  $safe | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $directory 'moss-usage.json')
  $parts = @($inputObject.model.display_name)
  if ($null -ne $inputObject.rate_limits.five_hour.used_percentage) { $parts += "5h $([Math]::Round($inputObject.rate_limits.five_hour.used_percentage))%" }
  if ($null -ne $inputObject.rate_limits.seven_day.used_percentage) { $parts += "7d $([Math]::Round($inputObject.rate_limits.seven_day.used_percentage))%" }
  Write-Output ($parts -join ' · ')
} catch {
  Write-Output 'Claude'
}

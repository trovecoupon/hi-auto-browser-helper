<#
.SYNOPSIS
    Chạy MỘT LẦN DUY NHẤT trong đời. Tạo khoá ký extension và nối vào CI.

.DESCRIPTION
    Khoá này quyết định ID của extension. Mọi máy nhận cập nhật vì Chrome thấy
    bản mới ký bằng đúng khoá cũ. Mất khoá = đổi ID = mọi máy phải cài lại từ
    đầu, nên script cất khoá NGOÀI repo và không bao giờ ghi đè.

    Sau khi chạy xong:
      - có file .pem trong %USERPROFILE%\.hi-auto (không nằm trong git)
      - manifest.json có thêm "key" và "update_url"
      - GitHub có secret CRX_PRIVATE_KEY để CI ký bản phát hành

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\1-TAO-KHOA.ps1"
#>
[CmdletBinding()]
param(
    [string]$UpdateUrl = 'https://hi-auto.vercel.app/ext/updates.xml'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)       { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t)     { Write-Host "    !   $t" -ForegroundColor Yellow }

$khoDir = Join-Path $env:USERPROFILE '.hi-auto'
$khoa   = Join-Path $khoDir 'hi-auto-browser-helper.pem'

# ── 1. Khoá ───────────────────────────────────────────────────────────────────
Step 1 'Tạo khoá ký'
if (Test-Path -LiteralPath $khoa) {
    Ok "đã có sẵn: $khoa"
    Warn 'Không tạo lại. Tạo khoá mới là đổi ID, mọi máy phải cài lại.'
} else {
    if (-not (Test-Path -LiteralPath $khoDir)) {
        New-Item -ItemType Directory -Path $khoDir -Force | Out-Null
    }
    & node (Join-Path $repo 'tools\crx.mjs') tao-khoa $khoa
    if ($LASTEXITCODE -ne 0) { throw 'Không tạo được khoá.' }
    Ok "đã tạo: $khoa"
}

$thongTin = & node (Join-Path $repo 'tools\crx.mjs') id $khoa
if ($LASTEXITCODE -ne 0) { throw 'Không đọc được khoá.' }
$extId  = $thongTin[0].Trim()
$pubKey = $thongTin[1].Trim()
Write-Host "    ID extension: $extId" -ForegroundColor White

# ── 2. manifest.json ──────────────────────────────────────────────────────────
Step 2 'Ghi khoá công khai vào manifest.json'
$mfPath = Join-Path $repo 'manifest.json'
$mf = Get-Content -LiteralPath $mfPath -Raw | ConvertFrom-Json

# "key" làm cho bản Load unpacked mang đúng ID của bản .crx. Không có nó thì
# Chrome sinh ID từ đường dẫn thư mục, và máy dev sẽ thành một extension khác.
$doi = $false
if ($mf.key -ne $pubKey) {
    $mf | Add-Member -NotePropertyName key -NotePropertyValue $pubKey -Force
    $doi = $true
}
if ($mf.update_url -ne $UpdateUrl) {
    $mf | Add-Member -NotePropertyName update_url -NotePropertyValue $UpdateUrl -Force
    $doi = $true
}
if ($doi) {
    $json = $mf | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($mfPath, $json, [System.Text.UTF8Encoding]::new($false))
    Ok 'đã thêm "key" và "update_url"'
} else {
    Ok 'manifest đã đúng, không sửa gì'
}

# ── 3. Secret cho CI ──────────────────────────────────────────────────────────
Step 3 'Đưa khoá vào GitHub để CI tự ký'
$coGh = $null -ne (Get-Command gh.exe -ErrorAction SilentlyContinue)
if ($coGh) {
    # PowerShell khong ho tro '<' de chuyen huong dau vao. Doc thang noi dung
    # roi truyen qua --body, vua tranh loi cu phap vua khong dinh BOM.
    $pem = [System.IO.File]::ReadAllText($khoa)
    & gh secret set CRX_PRIVATE_KEY --repo trovecoupon/hi-auto-browser-helper --body $pem
    if ($LASTEXITCODE -eq 0) { Ok 'đã đặt secret CRX_PRIVATE_KEY' }
    else { Warn 'Đặt secret thất bại, làm tay theo hướng dẫn bên dưới.' ; $coGh = $false }
}
if (-not $coGh) {
    Write-Host ''
    Write-Host '    Làm tay:' -ForegroundColor Yellow
    Write-Host '      1. Mở https://github.com/trovecoupon/hi-auto-browser-helper/settings/secrets/actions'
    Write-Host '      2. New repository secret, tên: CRX_PRIVATE_KEY'
    Write-Host "      3. Dán TOÀN BỘ nội dung file: $khoa"
}

# ── 4. Xong ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ' XONG. Từ giờ quy trình phát hành chỉ còn:' -ForegroundColor Green
Write-Host ''
Write-Host '   1. sửa code'
Write-Host '   2. tăng version trong manifest.json'
Write-Host '   3. git push'
Write-Host ''
Write-Host ' CI tự chạy test, tự đóng gói, tự ký, tự phát hành.' -ForegroundColor Green
Write-Host ' Mọi máy đã cài sẽ tự cập nhật trong vòng ~5 giờ.' -ForegroundColor Green
Write-Host ''
Write-Host " ID extension cố định: $extId" -ForegroundColor White
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ''
Write-Host 'GIỮ KỸ file khoá. Sao lưu ra chỗ khác:' -ForegroundColor Yellow
Write-Host "   $khoa"
Write-Host ''

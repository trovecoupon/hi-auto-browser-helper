<#
.SYNOPSIS
    Chạy một lần trên MỖI máy. Sau đó máy đó tự cập nhật extension mãi mãi.

.DESCRIPTION
    Đặt chính sách cho Chrome trỏ tới file cập nhật của Hi Auto. Chrome sẽ tự
    tải, tự cài và tự nâng cấp extension khoảng 5 giờ một lần — không cần tải
    zip, không cần Developer mode, không cần Load unpacked.

    Script tự đọc ID extension từ chính file cập nhật nên không bao giờ lệch.

    PHẢI chạy bằng quyền Administrator (chính sách nằm ở nhánh máy, không phải
    nhánh người dùng).

.EXAMPLE
    Bấm phải PowerShell > Run as administrator, rồi:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\2-CAI-TREN-MAY.ps1"

.PARAMETER Go
    Gỡ chính sách, trả máy về trạng thái cũ.
#>
[CmdletBinding()]
param(
    [string]$UpdateUrl = 'https://hi-auto.vercel.app/ext/updates.xml',
    [string]$ScriptUrl = 'https://hi-auto.vercel.app/cai.ps1',
    [switch]$Go
)

$ErrorActionPreference = 'Stop'

function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !   $t" -ForegroundColor Yellow }

Write-Host ''
Write-Host '=== CAI EXTENSION HI AUTO (tu cap nhat) ===' -ForegroundColor Cyan
Write-Host ''

# ── quyền ─────────────────────────────────────────────────────────────────────
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Tự mở lại bằng quyền quản trị. Khi script được chạy qua 'irm ... | iex' thì
    # không có file trên đĩa để gọi lại, nên cửa sổ mới tải lại từ đúng URL cũ.
    Write-Host 'Cần quyền quản trị. Đang mở cửa sổ mới...' -ForegroundColor Yellow
    Write-Host 'Bấm Yes ở hộp thoại của Windows.' -ForegroundColor Yellow
    $lenh = "irm $ScriptUrl | iex"
    if ($Go) { $lenh = "& ([scriptblock]::Create((irm $ScriptUrl))) -Go" }
    try {
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $lenh
        )
    } catch {
        Write-Host ''
        Write-Host 'Bạn đã từ chối, hoặc Windows chặn.' -ForegroundColor Red
        Write-Host 'Mở PowerShell bằng Run as administrator rồi dán lại dòng lệnh.'
        Read-Host 'Enter de dong'
    }
    exit 0
}

$policyKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'

# ── gỡ ────────────────────────────────────────────────────────────────────────
if ($Go) {
    if (Test-Path -LiteralPath $policyKey) {
        $con = Get-Item -LiteralPath $policyKey
        foreach ($name in $con.GetValueNames()) {
            if ((Get-ItemProperty -LiteralPath $policyKey -Name $name).$name -like "*hi-auto*") {
                Remove-ItemProperty -LiteralPath $policyKey -Name $name
                Ok "đã gỡ mục $name"
            }
        }
    }
    Write-Host ''
    Write-Host 'Đã gỡ chính sách. Khởi động lại Chrome để có hiệu lực.' -ForegroundColor Green
    Read-Host 'Enter de dong'
    exit 0
}

# ── đọc ID từ file cập nhật ───────────────────────────────────────────────────
Write-Host "Đang đọc thông tin bản phát hành từ:"
Write-Host "  $UpdateUrl"
try {
    $res = Invoke-WebRequest -Uri $UpdateUrl -UseBasicParsing -TimeoutSec 60
    $xml = [xml]$res.Content
} catch {
    Write-Host ''
    Write-Host "Không đọc được file cập nhật: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Kiểm tra đã có bản phát hành kèm updates.xml chưa:'
    Write-Host '  https://github.com/trovecoupon/hi-auto-browser-helper/releases/latest'
    Read-Host 'Enter de dong'
    exit 1
}

$extId   = $xml.gupdate.app.appid
$version = $xml.gupdate.app.updatecheck.version
if (-not $extId) {
    Write-Host 'File cập nhật không có appid.' -ForegroundColor Red
    Read-Host 'Enter de dong'; exit 1
}
Ok "ID extension : $extId"
Ok "Bản mới nhất : $version"

# ── ghi chính sách ────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $policyKey)) {
    New-Item -Path $policyKey -Force | Out-Null
}
$giaTri = "$extId;$UpdateUrl"

# Chrome đánh số các mục trong danh sách bằng "1", "2", ... Ghi đè đúng mục của
# Hi Auto nếu đã có, còn không thì lấy số trống tiếp theo — để không đụng vào
# extension khác mà máy này đang bị ép cài.
$con = Get-Item -LiteralPath $policyKey
$slot = $null
foreach ($name in $con.GetValueNames()) {
    if ((Get-ItemProperty -LiteralPath $policyKey -Name $name).$name -like "$extId;*") { $slot = $name; break }
}
if (-not $slot) {
    $i = 1
    while ($con.GetValueNames() -contains "$i") { $i++ }
    $slot = "$i"
}
Set-ItemProperty -LiteralPath $policyKey -Name $slot -Value $giaTri -Type String
Ok "đã ghi chính sách (mục $slot)"

# ── kiểm chứng ────────────────────────────────────────────────────────────────
$doc = (Get-ItemProperty -LiteralPath $policyKey -Name $slot).$slot
if ($doc -ne $giaTri) {
    Write-Host 'Ghi xong nhưng đọc lại không khớp.' -ForegroundColor Red
    Read-Host 'Enter de dong'; exit 1
}

Write-Host ''
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ' XONG. May nay se tu cai va tu cap nhat extension.' -ForegroundColor Green
Write-Host ''
Write-Host ' Con 1 viec: khoi dong lai Chrome (dong het cua so).' -ForegroundColor Yellow
Write-Host ''
Write-Host ' Muon thay ngay, khong doi:' -ForegroundColor White
Write-Host '   1. Mo  chrome://policy   -> bam "Reload policies"'
Write-Host '   2. Mo  chrome://extensions  -> se thay Hi Auto Browser Helper'
Write-Host ''
Write-Host ' Tu gio moi ban moi tu ve trong ~5 gio, khong phai lam gi nua.' -ForegroundColor Green
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ''
Read-Host 'Enter de dong'

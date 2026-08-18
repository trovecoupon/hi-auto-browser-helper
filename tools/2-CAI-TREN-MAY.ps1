# =====================================================================
#  HI AUTO | CAI EXTENSION, MAY TU CAP NHAT MAI VE SAU
#
#  Chay mot lan tren MOI may:
#     irm https://hi-auto.vercel.app/cai.ps1 | iex
#
#  Go ra:
#     & ([scriptblock]::Create((irm https://hi-auto.vercel.app/cai.ps1))) -Go
#
#  KHONG DUNG DAU TIENG VIET VA KHONG DUNG BOM TRONG FILE NAY.
#  Script duoc tai ve bang 'irm' roi dua thang cho 'iex'. GitHub tra file
#  duoi dang octet-stream nen PowerShell 5.1 doan bang ma sai: chu co dau
#  bien thanh rac, va BOM dinh lien vao '<#' lam PowerShell khong nhan ra
#  do la khoi chu thich, roi dem ca phan huong dan ra chay nhu ma lenh.
#  ASCII thuan thi giai ma kieu nao cung ra mot ket qua.
#
#  Script dat mot muc chinh sach cho Chrome, tro toi file cap nhat cua Hi
#  Auto. Chrome tu tai, tu cai va tu nang cap khoang 5 gio mot lan. Day la
#  cach duy nhat Chrome chiu tu cap nhat: ban nap tay kieu Load unpacked
#  thi no khong bao gio dung toi.
#
#  Phai chay bang quyen quan tri (chinh sach nam o nhanh may, khong phai
#  nhanh nguoi dung). Script tu xin quyen neu chua co.
# =====================================================================
[CmdletBinding()]
param(
    [string]$UpdateUrl = 'https://hi-auto.vercel.app/ext/updates.xml',
    [string]$ScriptUrl = 'https://hi-auto.vercel.app/cai.ps1',
    [switch]$Go
)

$ErrorActionPreference = 'Stop'

function Ok($t) { Write-Host "    OK  $t" -ForegroundColor Green }

Write-Host ''
Write-Host '=== HI AUTO HELPER - CAI VA TU CAP NHAT ===' -ForegroundColor Cyan
Write-Host ''

# ---- quyen ----------------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Tu mo lai bang quyen quan tri. Khi script chay qua 'irm | iex' thi khong
    # co file tren dia de goi lai, nen cua so moi tai lai tu dung URL cu.
    Write-Host 'Can quyen quan tri. Dang mo cua so moi...' -ForegroundColor Yellow
    Write-Host 'Bam Yes o hop thoai cua Windows.' -ForegroundColor Yellow
    $lenh = "irm $ScriptUrl | iex"
    if ($Go) { $lenh = "& ([scriptblock]::Create((irm $ScriptUrl))) -Go" }
    try {
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $lenh
        )
    } catch {
        Write-Host ''
        Write-Host 'Ban da tu choi, hoac Windows chan.' -ForegroundColor Red
        Write-Host 'Mo PowerShell bang Run as administrator roi dan lai dong lenh.'
        Read-Host 'Enter de dong'
    }
    exit 0
}

$policyKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'

# ---- go ra ----------------------------------------------------------------
if ($Go) {
    if (Test-Path -LiteralPath $policyKey) {
        $con = Get-Item -LiteralPath $policyKey
        foreach ($name in $con.GetValueNames()) {
            if ((Get-ItemProperty -LiteralPath $policyKey -Name $name).$name -like '*hi-auto*') {
                Remove-ItemProperty -LiteralPath $policyKey -Name $name
                Ok "da go muc $name"
            }
        }
    }
    Write-Host ''
    Write-Host 'Da go chinh sach. Khoi dong lai Chrome de co hieu luc.' -ForegroundColor Green
    Read-Host 'Enter de dong'
    exit 0
}

# ---- doc ID tu file cap nhat ----------------------------------------------
Write-Host 'Dang doc ban phat hanh moi nhat tu:'
Write-Host "  $UpdateUrl"
try {
    $res = Invoke-WebRequest -Uri $UpdateUrl -UseBasicParsing -TimeoutSec 60
    # PowerShell 5.1 tra .Content la Byte[] khi Content-Type khong phai kieu chu.
    # GitHub gan octet-stream cho file release, nen phai tu giai ma UTF-8; ep
    # thang [xml] tren Byte[] se bao loi 'cannot convert System.Byte[]'.
    $noiDung = $res.Content
    if ($noiDung -is [byte[]]) { $noiDung = [System.Text.Encoding]::UTF8.GetString($noiDung) }
    $noiDung = ([string]$noiDung).TrimStart([char]0xFEFF).Trim()
    $xml = [xml]$noiDung
} catch {
    Write-Host ''
    Write-Host "Khong doc duoc file cap nhat: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Kiem tra da co ban phat hanh kem updates.xml chua:'
    Write-Host '  https://github.com/trovecoupon/hi-auto-browser-helper/releases/latest'
    Read-Host 'Enter de dong'
    exit 1
}

$extId   = $xml.gupdate.app.appid
$version = $xml.gupdate.app.updatecheck.version
if (-not $extId) {
    Write-Host 'File cap nhat khong co appid.' -ForegroundColor Red
    Read-Host 'Enter de dong'
    exit 1
}
Ok "ID extension : $extId"
Ok "Ban moi nhat : $version"

# ---- ghi chinh sach -------------------------------------------------------
if (-not (Test-Path -LiteralPath $policyKey)) {
    New-Item -Path $policyKey -Force | Out-Null
}
$giaTri = "$extId;$UpdateUrl"

# Chrome danh so cac muc trong danh sach bang "1", "2", ... Ghi de dung muc cua
# Hi Auto neu da co, con khong thi lay so trong tiep theo - de khong dung vao
# extension khac ma may nay dang bi ep cai.
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
Ok "da ghi chinh sach (muc $slot)"

# ---- kiem chung -----------------------------------------------------------
$doc = (Get-ItemProperty -LiteralPath $policyKey -Name $slot).$slot
if ($doc -ne $giaTri) {
    Write-Host 'Ghi xong nhung doc lai khong khop.' -ForegroundColor Red
    Read-Host 'Enter de dong'
    exit 1
}

Write-Host ''
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ' XONG. May nay se tu cai va tu cap nhat extension.' -ForegroundColor Green
Write-Host ''
Write-Host ' Con 1 viec: khoi dong lai Chrome (dong het cua so).' -ForegroundColor Yellow
Write-Host ''
Write-Host ' Muon thay ngay, khong doi:' -ForegroundColor White
Write-Host '   1. Mo  chrome://policy      -> bam "Reload policies"'
Write-Host '   2. Mo  chrome://extensions  -> se thay Hi Auto Browser Helper'
Write-Host ("      ban do phai ghi ID " + $extId)
Write-Host '      va ghi "Installed by enterprise policy" (khong co nut Remove).'
Write-Host ''
Write-Host ' NEU CON MOT MUC Hi Auto GHI "Loaded unpacked": GO NO DI.' -ForegroundColor Yellow
Write-Host ' Do la ban cu ban tung tai tay, ID khac, va no KHONG BAO GIO tu cap nhat.' -ForegroundColor Yellow
Write-Host ' De lai thi hai ban chay song song va ban se nhin nham so phien ban cu.' -ForegroundColor Yellow
Write-Host ''
Write-Host ' Tu gio moi ban moi tu ve trong ~5 gio, khong phai lam gi nua.' -ForegroundColor Green
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ''
Read-Host 'Enter de dong'

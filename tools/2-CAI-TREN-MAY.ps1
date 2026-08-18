# =====================================================================
#  HI AUTO | CAI VA CAP NHAT BROWSER HELPER
#
#  Chay tren MOI may, va chay lai moi khi muon len ban moi:
#     irm https://hi-auto.vercel.app/cai.ps1 | iex
#
#  Go ra:
#     & ([scriptblock]::Create((irm https://hi-auto.vercel.app/cai.ps1))) -Go
#
#  KHONG DUNG DAU TIENG VIET VA KHONG DUNG BOM TRONG FILE NAY.
#  Script duoc tai ve bang 'irm' roi dua thang cho 'iex'. GitHub tra file
#  duoi dang octet-stream nen PowerShell 5.1 doan bang ma sai: chu co dau
#  bien thanh rac, va BOM dinh lien vao dau khoi chu thich lam PowerShell
#  dem ca phan huong dan ra chay nhu ma lenh.
#
#  VI SAO KHONG DUNG CHINH SACH CHROME NUA:
#  Da thu ExtensionInstallForcelist de Chrome tu cai va tu cap nhat. Chrome
#  tu choi: 'May tinh nay khong duoc coi la may do doanh nghiep quan ly, vi
#  vay chinh sach nay chi co the tu dong cai dat cac tien ich duoc luu tru
#  tren Cua hang Chrome truc tuyen'. Muon di duong do thi may phai gia nhap
#  domain hoac dang ky Chrome Browser Cloud Management. Tren may thuong,
#  tai goi ve roi Load unpacked la duong duy nhat.
#
#  Khong can quyen quan tri. Thu muc dich co dinh, va goi phat hanh co
#  truong 'key' nen ID extension luon la ilgpmcphkonicgfflkbjkeklekooipap
#  du thu muc nam o dau - ghep cap voi Local Agent song sot qua moi lan
#  cap nhat.
# =====================================================================
[CmdletBinding()]
param(
    [string]$TaiVe = 'https://github.com/trovecoupon/hi-auto-browser-helper/releases/latest/download',
    [string]$ThuMuc = (Join-Path $env:LOCALAPPDATA 'HiAuto\BrowserHelper\current'),
    [switch]$Go
)

$ErrorActionPreference = 'Stop'

function Ok($t)   { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !   $t" -ForegroundColor Yellow }

Write-Host ''
Write-Host '=== HI AUTO BROWSER HELPER ===' -ForegroundColor Cyan
Write-Host ''

# ---- go ra ----------------------------------------------------------------
if ($Go) {
    if (Test-Path -LiteralPath $ThuMuc) {
        Remove-Item -LiteralPath $ThuMuc -Recurse -Force
        Ok "da xoa $ThuMuc"
    } else {
        Warn 'khong thay thu muc cai dat'
    }
    Write-Host ''
    Write-Host 'Vao chrome://extensions bam Xoa o Hi Auto Browser Helper de go han.' -ForegroundColor Yellow
    Write-Host ''
    Read-Host 'Enter de dong'
    exit 0
}

# ---- don chinh sach cu neu con --------------------------------------------
# Ban truoc tung ghi ExtensionInstallForcelist. Chrome chan no tren may khong
# duoc quan ly va de lai mot dong loi do o chrome://policy. Vo hai nhung gay roi.
$policyKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
if (Test-Path -LiteralPath $policyKey) {
    $con = Get-Item -LiteralPath $policyKey
    $conSot = @($con.GetValueNames() | Where-Object {
        (Get-ItemProperty -LiteralPath $policyKey -Name $_).$_ -like '*hi-auto*'
    })
    if ($conSot.Count) {
        $admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
                 ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($admin) {
            foreach ($n in $conSot) { Remove-ItemProperty -LiteralPath $policyKey -Name $n }
            Ok 'da don muc chinh sach cu'
        } else {
            Warn 'Con muc chinh sach cu lam chrome://policy bao loi do. Don bang lenh nay'
            Warn 'trong PowerShell mo bang Run as administrator:'
            Write-Host "      Remove-ItemProperty '$policyKey' -Name $($conSot -join ',')" -ForegroundColor DarkGray
        }
    }
}

# ---- tai goi phat hanh moi nhat -------------------------------------------
$banCu = $null
$mfCu = Join-Path $ThuMuc 'manifest.json'
if (Test-Path -LiteralPath $mfCu) {
    try { $banCu = (Get-Content -LiteralPath $mfCu -Raw | ConvertFrom-Json).version } catch { }
}
if ($banCu) { Write-Host "Ban dang co : $banCu" } else { Write-Host 'Ban dang co : chua cai' }

$banSau = $null
$tam = Join-Path ([IO.Path]::GetTempPath()) ('hi-auto-helper-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tam -Force | Out-Null
$zip = Join-Path $tam 'helper.zip'
try {
    Write-Host 'Dang tai...'
    Invoke-WebRequest -Uri "$TaiVe/hi-auto-browser-helper.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 600

    # Doi chieu SHA-256 do chinh ban phat hanh cong bo. .Content co the la
    # Byte[] khi Content-Type khong phai kieu chu, nen giai ma tuong minh.
    $res = Invoke-WebRequest -Uri "$TaiVe/hi-auto-browser-helper.sha256" -UseBasicParsing -TimeoutSec 60
    $vanBan = $res.Content
    if ($vanBan -is [byte[]]) { $vanBan = [System.Text.Encoding]::UTF8.GetString($vanBan) }
    $vanBan = ([string]$vanBan).TrimStart([char]0xFEFF).Trim()
    if ($vanBan -notmatch '^([a-fA-F0-9]{64})') { throw 'File sha256 khong dung dinh dang.' }
    $mongDoi = $Matches[1].ToLowerInvariant()
    $thucTe = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($thucTe -ne $mongDoi) { throw 'Goi tai ve khong khop ma kiem tra. Da huy cai dat.' }
    Ok 'ma kiem tra khop'

    $giai = Join-Path $tam 'giai'
    Expand-Archive -LiteralPath $zip -DestinationPath $giai -Force
    $mfMoi = Join-Path $giai 'manifest.json'
    if (-not (Test-Path -LiteralPath $mfMoi)) { throw 'Goi khong co manifest.json o goc.' }
    $banMoi = (Get-Content -LiteralPath $mfMoi -Raw | ConvertFrom-Json).version
    Write-Host "Ban moi nhat: $banMoi"

    if ($banCu -and $banCu -eq $banMoi) {
        Ok 'dang la ban moi nhat, khong can lam gi'
        Write-Host ''
        Read-Host 'Enter de dong'
        exit 0
    }

    # Xoa sach roi chep, khong chep de: file bi bo o ban moi phai bien mat that
    # su, de lai thi Chrome van nap chung.
    if (Test-Path -LiteralPath $ThuMuc) {
        Get-ChildItem -LiteralPath $ThuMuc -Force | Remove-Item -Recurse -Force
    } else {
        New-Item -ItemType Directory -Path $ThuMuc -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $giai -Force | Copy-Item -Destination $ThuMuc -Recurse -Force
    $banSau = (Get-Content -LiteralPath (Join-Path $ThuMuc 'manifest.json') -Raw | ConvertFrom-Json).version
    Ok "da cai $banSau vao $ThuMuc"
} catch {
    Write-Host ''
    Write-Host "That bai: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Neu Chrome dang mo va dang nap extension nay, dong Chrome roi chay lai.'
    Read-Host 'Enter de dong'
    exit 1
} finally {
    Remove-Item -LiteralPath $tam -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '=========================================================' -ForegroundColor Green
if ($banCu) {
    Write-Host " DA CAP NHAT: $banCu -> $banSau" -ForegroundColor Green
    Write-Host ''
    Write-Host ' Con 1 viec: mo chrome://extensions roi bam Reload (bieu tuong xoay)' -ForegroundColor Yellow
    Write-Host ' o o Hi Auto Browser Helper.' -ForegroundColor Yellow
} else {
    Write-Host " DA CAI: $banSau" -ForegroundColor Green
    Write-Host ''
    Write-Host ' Con 3 buoc, chi lam LAN DAU:' -ForegroundColor Yellow
    Write-Host '   1. Mo  chrome://extensions'
    Write-Host '   2. Bat "Che do danh cho nha phat trien" (goc tren ben phai)'
    Write-Host '   3. Bam "Tai tien ich da giai nen" roi chon dung thu muc nay:'
    Write-Host ''
    Write-Host "      $ThuMuc" -ForegroundColor White
    Write-Host ''
    Write-Host ' Sau do mo https://hi-auto.vercel.app, dang nhap, bam Connect Helper.'
}
Write-Host ''
Write-Host ' Lan sau muon len ban moi: dan lai dung dong lenh cu.' -ForegroundColor White
Write-Host '   irm https://hi-auto.vercel.app/cai.ps1 | iex'
Write-Host '=========================================================' -ForegroundColor Green
Write-Host ''
Read-Host 'Enter de dong'

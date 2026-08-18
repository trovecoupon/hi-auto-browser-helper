#!/usr/bin/env node
// Chan mot lop loi da xay ra that: script cai may duoc tai ve bang 'irm' roi
// dua thang cho 'iex'. GitHub tra file duoi dang octet-stream, nen PowerShell
// 5.1 doan bang ma sai. Hai hau qua, ca hai deu kho lan ra:
//
//   - chu co dau bien thanh rac ('tai' -> 'táº£i');
//   - BOM o dau file dinh lien vao '<#', PowerShell khong nhan ra do la khoi
//     chu thich nua, roi dem ca phan huong dan ra chay nhu ma lenh.
//
// Loi hien ra la 'Missing argument in parameter list' o giua doan van xuoi,
// khong he nhac gi toi bang ma. ASCII thuan va khong BOM thi giai ma kieu nao
// cung ra mot ket qua.

import { readFileSync } from 'node:fs'

const duongDan = 'tools/2-CAI-TREN-MAY.ps1'
const bytes = readFileSync(duongDan)

function hong(thongDiep) {
  console.error(`::error file=${duongDan}::${thongDiep}`)
  console.error(`${duongDan}: ${thongDiep}`)
  process.exit(1)
}

if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
  hong('co BOM o dau file, se lam hong khoi chu thich khi chay qua irm | iex')
}

const viTri = bytes.findIndex((x) => x > 127)
if (viTri >= 0) {
  const dong = bytes.subarray(0, viTri).toString('latin1').split('\n').length
  hong(`co ky tu ngoai ASCII o dong ${dong} (byte ${viTri}), bo dau tieng Viet di`)
}

console.log(`${duongDan}: ASCII thuan, khong BOM, an toan cho irm | iex`)

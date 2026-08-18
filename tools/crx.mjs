#!/usr/bin/env node
// Tạo khoá ký và đóng gói extension thành .crx (định dạng CRX3), không cần
// thư viện ngoài và không cần Chrome.
//
// Vì sao cần: Chrome không bao giờ tự cập nhật extension nạp kiểu "Load
// unpacked". Bản .crx có chữ ký thì Chrome tự kiểm tra và tự cập nhật khoảng
// 5 giờ một lần trên mọi máy. Đổi lại, gói phải được ký bằng một khoá riêng
// cố định — chính khoá đó quyết định ID của extension.
//
//   node tools/crx.mjs tao-khoa  [duong/dan/khoa.pem]
//   node tools/crx.mjs id        <khoa.pem>
//   node tools/crx.mjs dong-goi  <nguon.zip> <khoa.pem> <dich.crx>
//
// Định dạng CRX3 (theo Chromium crx_file/crx3.proto):
//   "Cr24" | uint32 phiên bản = 3 | uint32 độ dài header | header | zip

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ── protobuf tối giản: chỉ cần trường kiểu bytes ──────────────────────────────
function varint(value) {
  const bytes = []
  let n = value
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  bytes.push(n)
  return Buffer.from(bytes)
}

function field(number, payload) {
  return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload])
}

function uint32le(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value, 0)
  return buf
}

// ── khoá và ID ───────────────────────────────────────────────────────────────
function publicDerFrom(privatePem) {
  const key = crypto.createPrivateKey(privatePem)
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })
}

// ID của extension = 16 byte đầu của SHA-256(khoá công khai), mỗi nibble đổi
// sang chữ cái a..p. Chrome sinh ID đúng theo cách này, nên ID cố định theo
// khoá chứ không theo đường dẫn thư mục.
function extensionId(publicDer) {
  const digest = crypto.createHash('sha256').update(publicDer).digest()
  let id = ''
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

function pack(zipBuffer, privatePem) {
  const publicDer = publicDerFrom(privatePem)
  const crxId = crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16)
  const signedHeaderData = field(1, crxId)

  // Chữ ký trùm lên: hằng ngữ cảnh (kèm byte null), độ dài phần header đã ký,
  // chính phần header đó, rồi toàn bộ zip.
  const payload = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'binary'),
    uint32le(signedHeaderData.length),
    signedHeaderData,
    zipBuffer,
  ])
  const signature = crypto.createSign('sha256').update(payload).sign(privatePem)

  const proof = Buffer.concat([field(1, publicDer), field(2, signature)])
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)])

  return Buffer.concat([
    Buffer.from('Cr24', 'binary'),
    uint32le(3),
    uint32le(header.length),
    header,
    zipBuffer,
  ])
}

// Đọc ngược một .crx và kiểm chữ ký. Dùng để tự kiểm sau khi đóng gói: thà
// hỏng ở đây còn hơn để Chrome trên máy người khác từ chối cài.
function verify(crxBuffer) {
  if (crxBuffer.subarray(0, 4).toString('binary') !== 'Cr24') throw new Error('Không phải file CRX.')
  if (crxBuffer.readUInt32LE(4) !== 3) throw new Error('Chỉ hỗ trợ CRX3.')
  const headerLength = crxBuffer.readUInt32LE(8)
  const header = crxBuffer.subarray(12, 12 + headerLength)
  const zip = crxBuffer.subarray(12 + headerLength)

  const parsed = {}
  let at = 0
  while (at < header.length) {
    let tag = 0
    let shift = 1
    while (header[at] & 0x80) { tag += (header[at] & 0x7f) * shift; shift *= 128; at += 1 }
    tag += header[at] * shift; at += 1
    let length = 0
    shift = 1
    while (header[at] & 0x80) { length += (header[at] & 0x7f) * shift; shift *= 128; at += 1 }
    length += header[at] * shift; at += 1
    parsed[Math.floor(tag / 8)] = header.subarray(at, at + length)
    at += length
  }

  const proof = parsed[2]
  const signedHeaderData = parsed[10000]
  if (!proof || !signedHeaderData) throw new Error('Header CRX thiếu chữ ký hoặc phần dữ liệu đã ký.')

  // Bóc AsymmetricKeyProof: trường 1 = khoá công khai, trường 2 = chữ ký.
  const parts = {}
  let p = 0
  while (p < proof.length) {
    const tag = proof[p]; p += 1
    let length = 0
    let shift = 1
    while (proof[p] & 0x80) { length += (proof[p] & 0x7f) * shift; shift *= 128; p += 1 }
    length += proof[p] * shift; p += 1
    parts[tag >> 3] = proof.subarray(p, p + length)
    p += length
  }

  const publicDer = parts[1]
  const signature = parts[2]
  const payload = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'binary'),
    uint32le(signedHeaderData.length),
    signedHeaderData,
    zip,
  ])
  const publicKey = crypto.createPublicKey({ key: publicDer, type: 'spki', format: 'der' })
  const ok = crypto.createVerify('sha256').update(payload).verify(publicKey, signature)
  if (!ok) throw new Error('Chữ ký không hợp lệ.')

  const declaredId = signedHeaderData.subarray(2)
  const realId = crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16)
  if (!declaredId.equals(realId)) throw new Error('crx_id trong header không khớp khoá.')

  return { id: extensionId(publicDer), zipBytes: zip.length }
}

// ── dòng lệnh ────────────────────────────────────────────────────────────────
// Chỉ chạy khi gọi trực tiếp; khi được import để kiểm thử thì im lặng.
const goiTrucTiep = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

const [command, ...args] = process.argv.slice(2)

if (!goiTrucTiep) {
  // không làm gì
} else if (command === 'tao-khoa') {
  const out = args[0] || 'hi-auto-browser-helper.pem'
  if (fs.existsSync(out)) {
    console.error(`Đã có ${out}. KHÔNG ghi đè — mất khoá là đổi ID extension,`)
    console.error('mọi máy sẽ coi đây là extension khác và phải cài lại từ đầu.')
    process.exit(1)
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  fs.writeFileSync(out, pem, { mode: 0o600 })
  const publicDer = publicDerFrom(pem)
  console.log(`Đã tạo khoá : ${path.resolve(out)}`)
  console.log(`ID extension: ${extensionId(publicDer)}`)
  console.log('')
  console.log('Thêm dòng này vào manifest.json để bản Load unpacked cùng ID với bản .crx:')
  console.log(`  "key": "${publicDer.toString('base64')}",`)
  console.log('')
  console.log('GIỮ KỸ file .pem. Mất là mọi máy phải cài lại. Đừng commit lên git.')
} else if (command === 'id') {
  const pem = fs.readFileSync(args[0], 'utf8')
  const publicDer = publicDerFrom(pem)
  console.log(extensionId(publicDer))
  console.log(publicDer.toString('base64'))
} else if (command === 'dong-goi') {
  const [zipPath, keyPath, outPath] = args
  if (!zipPath || !keyPath || !outPath) {
    console.error('Dùng: node tools/crx.mjs dong-goi <nguon.zip> <khoa.pem> <dich.crx>')
    process.exit(1)
  }
  const crx = pack(fs.readFileSync(zipPath), fs.readFileSync(keyPath, 'utf8'))
  fs.writeFileSync(outPath, crx)
  const checked = verify(crx)
  console.log(`Đã đóng gói : ${outPath} (${(crx.length / 1e6).toFixed(2)} MB)`)
  console.log(`ID extension: ${checked.id}`)
  console.log('Chữ ký tự kiểm: hợp lệ')
} else {
  console.error('Lệnh: tao-khoa | id | dong-goi')
  process.exit(1)
}

export { pack, verify, extensionId, publicDerFrom }

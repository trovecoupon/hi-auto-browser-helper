# ⚠️ LUẬT KIẾN TRÚC HI AUTO — ĐỌC TRƯỚC KHI SỬA CODE

**Bắt buộc đọc `C:\Users\123\Claude\Projects\KIEN_TRUC_HI_AUTO.md` trước khi viết bất kỳ dòng code nào.**
Đó là lộ trình đã chốt. Sai lệch khỏi nó là lỗi, không phải cải tiến.

Tóm tắt luật cứng:

- Cloud (Vercel) = não + địa chỉ. PC worker = cơ bắp. Extension = bàn tay trong trình duyệt.
- **CẤM** đưa OCR / Chrome / Playwright / crawl / xử lý file lớn / job >10s / ghi đĩa vào Vercel serverless.
  Vi phạm điều này đã gây **full disk + sập database ngày 17/08/2026**. Không lặp lại.
- Việc nặng → đăng ký thành `job_type` cho worker PC (`engine/cloud_agent`), worker tự PULL job.
  Worker chỉ gọi ra (outbound HTTPS), không mở port.
- Supabase Postgres là nguồn sự thật duy nhất. Không tạo DB thứ hai.
- Bridge Agent↔Extension chỉ bind `127.0.0.1:8771`.
- Mọi job phải có `idempotency_key` + `lease` + `max_attempts`.
- Không commit secret.

**Hạn mức nền tảng: đọc `C:\Users\123\Claude\Projects\GIOI_HAN_NEN_TANG.md`.** Đừng tin trí nhớ về
giới hạn Vercel/Supabase/Chrome — file đó có số liệu kèm link nguồn. Ba cái bẫy im lặng:
Vercel Hobby vượt quota = khoá 30 ngày; Supabase Free vượt 500MB = DB thành read-only;
Supabase Free 7 ngày ít hoạt động = project ngủ.

Không tự mở rộng phạm vi. Việc nào bị sandbox chặn thì báo ngay kèm lệnh để người dùng tự chạy.

---


# CopyDocExt

English: [README.md](README.md)

Một extension Chrome trích xuất nội dung từ Google Docs và Sheets bị khóa
copy/download, để bạn đọc, dán, hoặc lưu lại những tài liệu mà mình vốn
đã có quyền truy cập.

## Cách hoạt động

CopyDocExt fetch thẳng trang `/mobilebasic` của tài liệu (Docs) hoặc file
CSV export (Sheets), dùng chính phiên đăng nhập Google hiện có của bạn —
cùng một request mà trình duyệt vẫn gửi để hiển thị trang, chỉ là không
đi qua menu File > Download đã bị khóa. Không điều hướng tab, không tắt
JavaScript. Chỉ khi mọi lần fetch đều thất bại, extension mới rơi về cơ
chế điều hướng tab kiểu cũ — cơ chế này hiện thất bại trên hầu hết tài liệu, vì Google chuyển một tab đã bị chặn script sang trang hướng dẫn xóa cookie thay vì tài liệu.

## Cài đặt

Không có trình cài đặt — nạp source trực tiếp, ở chế độ developer:

1. Tải hoặc clone repository này.
2. Mở `chrome://extensions` và bật **Developer mode**.
3. Nhấn **Load unpacked**, chọn thư mục chứa `manifest.json`.
4. Nếu chưa thấy icon, mở menu hình mảnh ghép (puzzle-piece) và ghim lại.

## Cách dùng

1. Mở một Google Doc hoặc Sheet bị khóa, nhấn icon CopyDocExt, rồi nhấn **Extract Content**.
2. Xuất kết quả:
   - **Copy** — copy HTML có định dạng vào clipboard, dán được vào Docs,
     Word, hay bất kỳ trình soạn thảo rich text nào.
   - **New Doc** — copy nội dung rồi mở một Google Doc trống; nhấn Ctrl+V.
   - **.docx** — tải file Word có định dạng; ảnh chưa được đưa vào file
     này, dùng Copy hoặc New Doc nếu tài liệu có ảnh.
   - **.txt** — tải file văn bản thuần.

Nếu popup đóng lại giữa chừng lúc extract, cứ nhấn icon lần nữa — kết quả vẫn còn đó. Phần footer cho phép đổi giao diện giữa tiếng Anh và tiếng Việt.

## Giới hạn

Đây là đặc điểm của tài liệu gốc, không phải extension cắt góc:
- Công thức toán và hình vẽ trong Google đã được render sẵn thành ảnh,
  nên khi trích xuất ra chúng vẫn là ảnh, không phải text hay công thức
  chỉnh sửa được — và chữ vẽ bên trong một hình vẽ thì không thể khôi
  phục lại thành text chọn được.
- Chỉ sheet đầu tiên của spreadsheet được đọc.
- Google Slides chưa được hỗ trợ — hiện chưa có cách nào lấy nội dung
  đáng tin cậy từ phía server cho Slides.

## Xử lý sự cố

| Vấn đề | Nguyên nhân |
|---|---|
| "Not a Google Doc" | Tab hiện tại không phải trang document hay sheet trên `docs.google.com`. |
| Extract thất bại sau khi chờ lâu | Mọi lần fetch đều thất bại nên rơi về điều hướng tab, và Google chặn cách này trên hầu hết tài liệu. |
| File .docx không có ảnh | Đúng như hiện tại — dùng Copy hoặc New Doc thay thế. |

## Quyền riêng tư

CopyDocExt không gửi bất kỳ dữ liệu nào đi đâu cả. Nó chỉ fetch từ `docs.google.com` bằng phiên đăng nhập sẵn có của bạn — đúng quyền truy
cập mà trình duyệt của bạn vốn đã có. Parse, định dạng, và tạo file đều diễn ra hoàn toàn cục bộ — không telemetry, không server bên thứ ba.

## Cấu trúc dự án

```
manifest.json
src/
  entry/       background, content script, popup, offscreen — chỉ nối dây (wiring)
  extraction/  fetch pipeline, transport, gắn ảnh (image embedding)
  platform/    lớp duy nhất được gọi chrome.* API
  core/        logic thuần — parse URL, sanitize, hỗ trợ CSV/zip
  ui/          popup view, controller, xử lý export, tạo file docx
  shared/      constants dùng chung giữa các lớp
```

## Giấy phép

MIT — xem [LICENSE](LICENSE).

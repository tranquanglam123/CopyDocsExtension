# CopyDocExt

English: [README.md](README.md)

Một extension Chrome trích xuất nội dung từ Google Docs và Sheets bị khóa
copy/download, và học liệu mà các trang web khác nhúng vào (file PDF, Word
nằm sau một trình xem), để bạn đọc, dán, hoặc lưu lại những tài liệu mà
mình vốn đã có quyền truy cập.

## Cách hoạt động

CopyDocExt fetch thẳng trang `/mobilebasic` của tài liệu (Docs) hoặc file
CSV export (Sheets), dùng chính phiên đăng nhập Google hiện có của bạn —
cùng một request mà trình duyệt vẫn gửi để hiển thị trang, chỉ là không
đi qua menu File > Download đã bị khóa. Không điều hướng tab, không tắt
JavaScript. Chỉ khi mọi lần fetch đều thất bại, extension mới rơi về cơ
chế điều hướng tab kiểu cũ — cơ chế này hiện thất bại trên hầu hết tài liệu, vì Google chuyển một tab đã bị chặn script sang trang hướng dẫn xóa cookie thay vì tài liệu.

Trên mọi trang web khác, extension tìm thứ trang đó nhúng và đọc thẳng file
gốc thay vì trình xem:

| Kiểu nhúng | Ví dụ | Đọc như |
|---|---|---|
| Trình xem pdf.js `viewer.html?file=…` | toanmath.com (WonderPlugin) | PDF |
| Office Online `view.officeapps.live.com/op/embed.aspx?src=…` | thuvienhoclieu.com | .docx |
| Google Docs viewer `docs.google.com/viewer?url=…` | nhiều plugin WordPress | PDF |
| Google Drive `drive.google.com/file/d/…/preview` | nhúng từ Drive | PDF hoặc .docx |
| Google Doc / Sheet / Slides nhúng | `…/document/d/…/preview` | đường Docs / Sheets; Slides qua PDF |
| `<iframe>`/`<embed>`/`<object>` hoặc link `.pdf`/`.docx` trong bài | — | PDF hoặc .docx |

Trang không nhúng gì thì lấy nội dung bài viết. Mở thẳng file PDF trong tab
cũng dùng được.

## Cài đặt

Không có trình cài đặt — nạp source trực tiếp, ở chế độ developer:

1. Tải hoặc clone repository này.
2. Mở `chrome://extensions` và bật **Developer mode**.
3. Nhấn **Load unpacked**, chọn thư mục chứa `manifest.json`.
4. Nếu chưa thấy icon, mở menu hình mảnh ghép (puzzle-piece) và ghim lại.

## Cách dùng

1. Mở một Google Doc hoặc Sheet bị khóa, hoặc một trang web có học liệu
   nhúng, nhấn icon CopyDocExt, rồi nhấn **Extract Content**. Nếu file nằm
   ở trang khác, Chrome sẽ hỏi quyền truy cập trang đó một lần.
2. Xuất kết quả:
   - **Copy** — copy HTML có định dạng vào clipboard, dán được vào Docs,
     Word, hay bất kỳ trình soạn thảo rich text nào.
   - **New Doc** — copy nội dung rồi mở một Google Doc trống; nhấn Ctrl+V.
   - **.docx** — tải file Word có định dạng và hình đã nhúng.
   - **.txt** — tải file văn bản thuần.
   - **File gốc** (trang web) — tải chính file PDF/Word được nhúng, giữ
     nguyên công thức và bố cục.

Nếu popup đóng lại giữa chừng lúc extract, cứ nhấn icon lần nữa — kết quả vẫn còn đó. Phần footer cho phép đổi giao diện giữa tiếng Anh và tiếng Việt.

## Giới hạn

Đây là đặc điểm của tài liệu gốc, không phải extension cắt góc:
- Công thức toán và hình vẽ trong Google đã được render sẵn thành ảnh,
  nên khi trích xuất ra chúng vẫn là ảnh, không phải text hay công thức
  chỉnh sửa được — và chữ vẽ bên trong một hình vẽ thì không thể khôi
  phục lại thành text chọn được.
- Chỉ sheet đầu tiên của spreadsheet được đọc.
- Google Slides chưa được hỗ trợ — hiện chưa có cách nào lấy nội dung
  đáng tin cậy từ phía server cho Slides. Slides nhúng trong trang web
  được đọc qua bản xuất PDF.
- PDF lưu chữ theo vị trí, không lưu đoạn hay bảng: bảng ra thành từng
  dòng, công thức xếp chồng (phân số) bị tách dòng. Trang scan và hình
  được giữ dạng ảnh.
- Công thức MathType trong file .docx nguồn được chuyển thành công thức
  Word trong file **.docx** tải xuống, sửa được mà không cần MathType. Sao
  chép và Tài liệu mới không mang được công thức (clipboard chỉ chứa HTML),
  nên ở đó là chữ một dòng, vd `(x−1)/y`, `x²−2xy+y²`. Công thức có cấu
  trúc bộ chuyển chưa biết thì giữ nguyên object MathType.
- Công thức trong PDF chỉ còn là ký tự rời theo toạ độ; dữ liệu công thức
  đã mất khi xuất ra PDF, nên không khôi phục thành công thức sửa được.
- Font tiếng Việt cũ (VNI, TCVN3) ra chữ lỗi; có cảnh báo khi gặp.
- File Office đời cũ (.doc, .ppt) và .pptx/.xlsx chưa đọc được — **File
  gốc** vẫn tải về được.

## Xử lý sự cố

| Vấn đề | Nguyên nhân |
|---|---|
| "Không có gì để trích xuất" | Tab là trang của trình duyệt hoặc Web Store — extension không đọc được. |
| File nhúng không đọc được | Chưa cấp quyền cho trang chứa file, hoặc chủ file tắt tải xuống. Thử **File gốc**. |
| Extract thất bại sau khi chờ lâu | Mọi lần fetch đều thất bại nên rơi về điều hướng tab, và Google chặn cách này trên hầu hết tài liệu. |
| File .docx không có ảnh | Chỉ hình đã nhúng mới được ghi: bật "Nhúng hình ảnh". |
| Double-click công thức thì Word hỏi chuyển đổi | Công thức đó còn là object MathType mà máy chưa cài MathType. |

## Quyền riêng tư

CopyDocExt không gửi bất kỳ dữ liệu nào đi đâu cả. Nó chỉ fetch từ `docs.google.com`, và từ trang chứa file mà một trang web nhúng, bằng phiên đăng nhập sẵn có của bạn — đúng quyền truy
cập mà trình duyệt của bạn vốn đã có. Trang khác chỉ truy cập được sau khi bạn cho phép trong hộp thoại của Chrome. Parse, định dạng, và tạo file đều diễn ra hoàn toàn cục bộ — không telemetry, không server bên thứ ba.

## Cấu trúc dự án

Mỗi realm của Chrome một thư mục, cộng hai lớp dùng chung. Luật import: [AGENTS.md](AGENTS.md).

```
manifest.json
src/
  popup/       trang popup: view, controller, export, docx
  background/  service worker; extract/ chứa bốn backend
  offscreen/   bộ parse: host sandbox, mỗi pass một file, parser PDF/DOCX
  content/     content script — dò trang sẵn sàng, và quét trang web
  bridge/      contract message, các facade, và mọi lệnh gọi chrome.*
  lib/         logic thuần — URL, embed, bố cục PDF, MathType, CSV, zip, i18n
  vendor/      pdf.js, nguyên bản (Apache-2.0)
```

## Giấy phép

MIT — xem [LICENSE](LICENSE).

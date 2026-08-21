/**
 * vi.js — Vietnamese strings (spec v3 §5). Must carry exactly the same key
 * set as en.js (enforced by test/i18n.test.js) — a new English string here
 * with no counterpart there fails the build, not just at review time.
 *
 * Written for a Vietnamese reader, not translated word-for-word from the
 * English column: product names (Google Doc/Sheet/Slides) and developer
 * terms (URL, HTTP, CSV, gviz, JS, content script, .docx/.txt, Ctrl+V) are
 * left in English, matching how Vietnamese developers actually talk about
 * them.
 *
 * Plain data only — no imports, no chrome.* (src/shared/, spec v3 §8).
 */
export const dict = {
    // ─── Static popup chrome (filled via I18n.apply(), data-i18n*) ────────
    'popup.subtitle': 'Trích xuất Google Docs bị hạn chế quyền truy cập',
    'popup.status.checking': 'Đang kiểm tra…',
    'popup.step.validate': 'Kiểm tra',
    'popup.step.fetch': 'Tải về',
    'popup.step.parse': 'Phân tích',
    'popup.step.blockJs': 'Chặn JS',
    'popup.step.navigate': 'Điều hướng',
    'popup.step.extract': 'Trích xuất',
    'popup.step.done': 'Hoàn tất',
    'popup.options.embedImages': 'Nhúng hình ảnh',
    'popup.action.extract': 'Trích xuất nội dung',
    'popup.action.copy': 'Sao chép',
    'popup.action.copyTitle': 'Sao chép kèm định dạng (dán vào Google Docs / Word)',
    'popup.action.newDoc': 'Tài liệu mới',
    'popup.action.newDocTitle': 'Sao chép & mở Google Doc mới — nhấn Ctrl+V để dán',
    'popup.action.docx': '.docx',
    'popup.action.docxTitle': 'Tải xuống dạng Word (.docx)',
    'popup.action.txt': '.txt',
    'popup.action.txtTitle': 'Tải xuống dạng văn bản thuần (.txt)',
    'popup.docxNote': 'Lưu ý: hình ảnh chưa được đưa vào file .docx tải xuống — hãy dùng Sao chép hoặc Tài liệu mới để giữ lại hình ảnh.',
    'popup.footer.languageLabel': 'Ngôn ngữ',

    // ─── Dynamic status card (I18n.t() from ui/popup-view.js) ─────────────
    'popup.status.docDetected': 'Đã phát hiện {type}',
    'popup.status.notADocTitle': 'Không phải Google Doc',
    'popup.status.notADocDetail': 'Hãy mở một Google Doc, Sheet hoặc Slide.',
    'popup.status.slidesTitle': 'Chưa hỗ trợ Google Slides',
    'popup.status.slidesDetail': 'Trích xuất Slides chưa khả dụng ở phiên bản này — hãy thử với Doc hoặc Sheet.',
    'popup.status.initErrorTitle': 'Lỗi',
    'popup.status.extractionCompleteTitle': 'Trích xuất hoàn tất',
    'popup.status.extractedDetail': 'Đã trích xuất {count} ký tự',
    'popup.status.recoveryTitle': 'Đang trích xuất…',
    'popup.status.recoveryDetail': 'Đang chờ trích xuất nội dung…',
    'popup.status.extractionFailedTitle': 'Trích xuất thất bại',
    'popup.status.extracting': 'Đang trích xuất…',
    'popup.status.validating': 'Đang kiểm tra URL tài liệu',
    'popup.status.fetchingSheet': 'Đang tải dữ liệu bảng tính trực tiếp — không cần điều hướng tab',
    'popup.status.fetchingDoc': 'Đang tải HTML của tài liệu trực tiếp — không cần điều hướng tab',
    'popup.status.parsing': 'Đang phân tích định dạng tài liệu',

    // ─── Document type labels ──────────────────────────────────────────────
    'docType.docs': 'Google Doc',
    'docType.sheets': 'Google Sheet',
    'docType.slides': 'Google Slides',

    // ─── Notification toasts ───────────────────────────────────────────────
    'popup.notify.ready': '"{title}" đã sẵn sàng — sao chép, mở tài liệu mới, hoặc tải xuống!',
    'popup.notify.copyRich': 'Đã sao chép kèm định dạng! Dán vào Google Docs hoặc Word.',
    'popup.notify.copyPlain': 'Đã sao chép dạng văn bản thuần (không hỗ trợ sao chép định dạng ở đây).',
    'popup.notify.copyFallback': 'Đã sao chép dạng văn bản thuần (phương án dự phòng).',
    'popup.notify.newDocOpened': 'Đã mở tài liệu mới! Nhấn Ctrl+V để dán nội dung đã định dạng.',
    'popup.notify.newDocFailed': 'Không thể mở tài liệu mới: {message}',
    'popup.notify.docxDownloading': 'Đang tải xuống "{filename}" — mở được bằng Word & Google Docs!',
    'popup.notify.docxFailed': 'Tải xuống thất bại: {message}',
    'popup.notify.txtDownloading': 'Đang tải xuống "{filename}"',
    'popup.notify.txtFailed': 'Tải xuống thất bại: {message}',

    // ─── Warning codes (shared/constants.js WARNINGS / WARNING_PREFIXES) ──
    'warning.single_sheet_only': 'Chỉ trang tính đầu tiên được đọc (gid=0) — các trang tính khác trong bảng tính này chưa được trích xuất.',
    'warning.tabnav_fallback': 'Tải trực tiếp thất bại nên tiện ích đã chuyển sang phương án cũ — tab của bạn có thể đã điều hướng tạm thời sang giao diện di động.',
    'warning.legacy_parser_fallback': 'Bộ phân tích chính đã thất bại nên đã dùng bộ phân tích dự phòng — một số định dạng có thể bị thiếu.',
    'warning.style_fill_skipped_size': 'Kết quả định dạng quá lớn nên một số kiểu tính toán đã bị bỏ qua — định dạng inline từ nguồn vẫn được áp dụng.',
    'warning.container_fallback_used': 'Không tìm thấy nội dung chính của tài liệu theo cách thông thường, nên hệ thống đã dùng phương án ước đoán tốt nhất.',
    'warning.container_not_found': 'Không xác định được khối nội dung chính của tài liệu — kết quả có thể chưa đầy đủ.',
    'warning.empty_content': 'Đã tìm thấy khối nội dung nhưng không chứa văn bản nào.',
    'warning.image_budget_exceeded': 'Một số hình ảnh quá lớn để nhúng trong giới hạn dung lượng cho phép, nên được giữ dưới dạng liên kết tới Google Docs — các liên kết này chỉ hoạt động khi phiên đăng nhập của bạn còn truy cập được.',
    'warning.image_embed_failed': '{count} hình ảnh không thể tải về và được giữ dưới dạng liên kết tới Google Docs thay vì nhúng trực tiếp.',
    'warning.image_not_bitmap': '{count} hình ảnh không thể nhúng vì nguồn không thực sự là hình ảnh (ví dụ: trang xem trước, không phải bitmap) — đã giữ dưới dạng liên kết.',
    'warning.low_confidence': 'Độ tin cậy trích xuất thấp — kết quả có thể chưa đầy đủ.',
    'warning.multi_tab_partial': 'Tài liệu nhiều tab: chỉ tab đầu tiên được trích xuất.',

    // ─── Error codes (core/app-error.js AppError, spec v3 §5.3) ───────────
    'error.sheetNetworkFailed': 'Yêu cầu mạng thất bại khi tải bảng tính: {message}',
    'error.sheetSignInRequired': 'Bảng tính này yêu cầu đăng nhập — tiện ích không thể truy cập (bị chuyển hướng tới trang đăng nhập Google).',
    'error.sheetFetchFailed': 'Tải dữ liệu bảng tính thất bại (HTTP {status}).',
    'error.sheetAccessWall': 'Bảng tính này yêu cầu quyền truy cập — tiện ích không thể đọc được (phát hiện rào chắn truy cập trong phản hồi).',
    'error.sheetNonCsvResponse': 'Điểm cuối bảng tính trả về phản hồi không phải CSV — trang tính có thể bị hạn chế, trống, hoặc điểm cuối gviz đã thay đổi.',
    'error.extractionInProgress': 'Đang có một lượt trích xuất khác chạy — hãy đợi hoàn tất trước khi bắt đầu lượt mới.',
    'error.notADocPage': 'Tab hiện tại không phải trang Google Docs, Sheets hoặc Slides.',
    'error.slidesUnsupported': 'Google Slides chưa được hỗ trợ.',
    'error.noExtractionTarget': 'Không thể tạo mục tiêu trích xuất cho URL này.',
    'error.emptyPayload': 'Content script gửi về dữ liệu rỗng.',
    'error.missingRawHtml': 'Dữ liệu từ content script thiếu phần HTML.',
    'error.offscreenParseFailed': 'Trích xuất thất bại: không thể phân tích tài liệu ({message}).',
    'error.contentExtractionTimeout': 'Trích xuất nội dung đã hết thời gian chờ (20 giây). Trang có thể chưa tải xong.',
    'error.watchdogRecovered': 'Quá trình trích xuất đã hết thời gian chờ và được tự động khôi phục. Mọi script bị chặn trên tab đã được khôi phục.',
    'error.extractionFailed': 'Trích xuất thất bại.',
    'error.downloadFailed': 'Tải xuống thất bại.',
    'error.checkStatusFallback': 'Xem console của trình duyệt để biết chi tiết.',
};

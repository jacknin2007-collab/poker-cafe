const SHEET_NAME = "Tổng hợp";
const REPORT_PREFIX = "Báo cáo tháng ";
const HEADER = ["Ngày", "SĐT", "Check in", "Check out", "Tổng giờ", "Trạng thái", "Ghi chú"];

function onFormSubmit(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER);
  }

  const row = e.values;
  // Lấy thẳng giá trị Date thật từ ô Timestamp (cột A) của dòng vừa submit,
  // tránh parse chuỗi bằng new Date(row[0]) vì dễ bị đọc nhầm ngày/tháng
  const timestamp = e.range.getSheet().getRange(e.range.getRow(), 1).getValue();
  const phone = row[1];
  const type = row[2];
  const note = row[3];
  const tz = Session.getScriptTimeZone();

  const date = Utilities.formatDate(timestamp, tz, "dd/MM/yyyy");
  const time = Utilities.formatDate(timestamp, tz, "HH:mm");

  const lastRow = sheet.getLastRow();

  // Tìm đúng dòng theo ngày + SĐT (toàn bộ sheet "Tổng hợp")
  for (let i = 2; i <= lastRow; i++) {
    const rowDate = Utilities.formatDate(
      new Date(sheet.getRange(i, 1).getValue()),
      tz,
      "dd/MM/yyyy"
    );
    const rowPhone = sheet.getRange(i, 2).getValue();

    if (rowDate == date && phoneKey(rowPhone) == phoneKey(phone)) {
      if (type == "Check in") {
        sheet.getRange(i, 3).setValue(time);
        sheet.getRange(i, 6).setValue("Đang làm");
      }

      if (type == "Check out") {
        sheet.getRange(i, 4).setValue(time);
        sheet.getRange(i, 6).setValue("Hoàn thành");

        const inTime = sheet.getRange(i, 3).getDisplayValue();
        if (inTime) {
          sheet.getRange(i, 5).setValue(calcHours(inTime, time).toFixed(2));
        }
      }

      if (type == "Nghỉ") {
        sheet.getRange(i, 6).setValue("Nghỉ");
        sheet.getRange(i, 7).setValue(note);
      }

      updateMonthlyReport();
      return;
    }
  }

  // Không tìm thấy thì tạo dòng mới
  let checkin = "";
  let checkout = "";
  let status = "";

  if (type == "Check in") {
    checkin = time;
    status = "Đang làm";
  }

  if (type == "Check out") {
    checkout = time;
    status = "Hoàn thành";
  }

  if (type == "Nghỉ") {
    status = "Nghỉ";
  }

  sheet.appendRow([timestamp, phone, checkin, checkout, "", status, note]);
  updateMonthlyReport();
}

// Lấy số điện thoại thuần (bỏ phần tên phía sau dấu "-") để so khớp/gộp nhóm,
// tránh bị tách dòng khi tên bị gõ lệch (khoảng trắng, hoa/thường...)
function phoneKey(v) {
  const s = String(v).trim();
  const match = s.match(/^\d+/);
  return match ? match[0] : s;
}

// Tính số giờ giữa 2 mốc "HH:mm", tự cộng thêm 24h nếu qua đêm
function calcHours(inTime, outTime) {
  const toMinutes = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  let start = toMinutes(inTime);
  let end = toMinutes(outTime);
  if (end < start) end += 24 * 60;

  return (end - start) / 60;
}

// Đọc toàn bộ sheet "Tổng hợp", mỗi tháng tạo 1 sheet báo cáo riêng (tên có ghi tháng),
// trong đó gộp theo SĐT để tính tổng giờ làm và số ngày nghỉ của riêng tháng đó
function updateMonthlyReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return;

  const tz = Session.getScriptTimeZone();
  const data = sheet.getDataRange().getValues();
  const summaryByMonth = {};

  for (let i = 1; i < data.length; i++) {
    const [rawDate, phone, , , totalHoursCell, status] = data[i];
    if (!rawDate || !phone) continue;

    const month = Utilities.formatDate(new Date(rawDate), tz, "MM-yyyy");
    const key = phoneKey(phone);

    if (!summaryByMonth[month]) summaryByMonth[month] = {};
    if (!summaryByMonth[month][key]) {
      summaryByMonth[month][key] = { phone, totalHours: 0, absentDays: 0 };
    }

    summaryByMonth[month][key].totalHours += parseFloat(totalHoursCell) || 0;
    if (status == "Nghỉ") summaryByMonth[month][key].absentDays++;
  }

  Object.keys(summaryByMonth).forEach((month) => {
    const reportName = REPORT_PREFIX + month;
    let reportSheet = ss.getSheetByName(reportName);
    if (!reportSheet) {
      reportSheet = ss.insertSheet(reportName);
    } else {
      reportSheet.clear();
    }

    reportSheet.appendRow(["SĐT", "Tổng giờ", "Số ngày nghỉ"]);

    const rows = Object.values(summaryByMonth[month]).sort((a, b) =>
      a.phone.localeCompare(b.phone)
    );

    rows.forEach((r) => {
      reportSheet.appendRow([r.phone, r.totalHours.toFixed(2), r.absentDays]);
    });
  });
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Chấm công")
    .addItem("Cập nhật báo cáo tháng", "updateMonthlyReport")
    .addToUi();
}

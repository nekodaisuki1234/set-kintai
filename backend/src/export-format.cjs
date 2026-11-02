"use strict";
const { ApiError } = require("./errors.cjs");
const TYPES = Object.freeze({ xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12" });
function exportFormat(mapping, employee, period) {
  const extension = mapping?.version === 2 && mapping.layout === "set-report" ? "xlsm" : "xlsx";
  const name = String(employee.name || "社員").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim().slice(0, 80) || "社員";
  return { extension, contentType: TYPES[extension], fileName: "作業報告書(" + period.end.slice(0, 7).replace("-", "年") + "月)_" + name + "." + extension };
}
function checkedFormat(format) {
  const value = format || { extension: "xlsx", contentType: TYPES.xlsx, fileName: "attendance.xlsx" };
  if (!Object.hasOwn(TYPES, value.extension) || value.contentType !== TYPES[value.extension] || typeof value.fileName !== "string" || value.fileName.length > 180 || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(value.fileName) || !value.fileName.endsWith("." + value.extension)) throw new ApiError(422, "invalid_export_format", "出力ファイルの名前と形式を確認してください。");
  return { extension: value.extension, contentType: value.contentType, fileName: value.fileName };
}
function disposition(format) {
  const value = checkedFormat(format);
  return 'attachment; filename="attendance.' + value.extension + '"; filename*=UTF-8\'\'' + encodeURIComponent(value.fileName).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
module.exports = { TYPES, exportFormat, checkedFormat, disposition };

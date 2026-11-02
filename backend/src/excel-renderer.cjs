"use strict";

const { C } = require("./core.cjs");
const { ApiError } = require("./errors.cjs");

const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const CELL_FIELDS = new Set([
  "employee.name", "employee.department", "employee.id",
  "period.start", "period.end", "settings.workSummary"
]);
const DAY_FIELDS = new Set([
  "day", "weekday", "holiday", "status", "leave", "sourceDay",
  "start", "end", "endWithOffset", "overnight", "breakMinutes",
  "workedHours", "absenceHours", "locationCode", "locationName", "note", "phases",
  ...C.PROJECTS.map(id => `allocation.${id}`)
]);
const SUMMARY_FIELDS = new Set([
  "minutes", "hours", "leaveDays", "workedDays", "absenceMinutes", "absenceHours",
  ...C.PROJECTS.map(id => `allocation.${id}`)
]);
const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const invalidMapping = message => new ApiError(422, "TEMPLATE_MAPPING_INVALID", message);
const invalidTemplate = message => new ApiError(422, "TEMPLATE_INVALID", message);

function exactKeys(value, allowed, label) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw invalidMapping(`${label}の設定項目を確認してください。`);
  }
}

function columnIndex(text) {
  if (typeof text !== "string" || !/^[A-Z]{1,3}$/.test(text)) return 0;
  const index = [...text].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
  return index <= 16384 ? index : 0;
}

function address(value) {
  const match = typeof value === "string" && /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match || !columnIndex(match[1]) || Number(match[2]) > 1048576) {
    throw invalidMapping("セルの指定はA1形式で入力してください。");
  }
  return value;
}

function fieldMap(value, fields, label, columns = false) {
  if (!plainObject(value) || Object.keys(value).length > fields.size) {
    throw invalidMapping(`${label}を確認してください。`);
  }
  for (const [field, target] of Object.entries(value)) {
    if (!fields.has(field)) throw invalidMapping(`${label}に未対応の項目があります: ${field}`);
    if (columns ? !columnIndex(target) : !address(target)) {
      throw invalidMapping(`${label}の列指定を確認してください。`);
    }
  }
}

function validateMapping(mapping) {
  exactKeys(mapping, ["version", "worksheet", "cells", "days", "summary"], "テンプレート");
  if (mapping.version !== 1 || typeof mapping.worksheet !== "string" || !mapping.worksheet || mapping.worksheet.length > 31) {
    throw invalidMapping("対応するマッピングのバージョンとシート名を指定してください。");
  }
  fieldMap(mapping.cells ?? {}, CELL_FIELDS, "共通セル");
  fieldMap(mapping.summary ?? {}, SUMMARY_FIELDS, "合計セル");
  exactKeys(mapping.days, ["startRow", "capacity", "columns"], "日別行");
  const { startRow, capacity, columns } = mapping.days;
  if (!Number.isInteger(startRow) || startRow < 1 || !Number.isInteger(capacity) || capacity < 1 || capacity > 366 || startRow + capacity - 1 > 1048576) {
    throw invalidMapping("日別行は1〜366日分の有効な行範囲を指定してください。");
  }
  fieldMap(columns, DAY_FIELDS, "日別の列", true);
  if (!Object.keys(columns).length) throw invalidMapping("日別の列を1つ以上指定してください。");
  return mapping;
}

// Check the ZIP directory before expansion. VBA is enabled only for the explicit
// SET .xlsm path; version 1 must never silently convert a macro workbook to .xlsx.
function validateTemplateBytes(bytes, { allowVba = false } = {}) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw invalidTemplate("Excelテンプレートは8MB以内の.xlsxファイルを指定してください。");
  }
  const input = Buffer.from(bytes);
  let end = -1;
  for (let offset = input.length - 22; offset >= Math.max(0, input.length - 65557); offset--) {
    if (input.readUInt32LE(offset) === 0x06054b50 && offset + 22 + input.readUInt16LE(offset + 20) === input.length) {
      end = offset;
      break;
    }
  }
  if (end < 0 || input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6)) throw invalidTemplate("通常の.xlsxテンプレートを指定してください。");
  const count = input.readUInt16LE(end + 10), size = input.readUInt32LE(end + 12), start = input.readUInt32LE(end + 16);
  if (!count || count > MAX_ZIP_ENTRIES || count !== input.readUInt16LE(end + 8) || start + size !== end) throw invalidTemplate("テンプレートのファイル構造を確認してください。");
  let offset = start, expandedBytes = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || input.readUInt32LE(offset) !== 0x02014b50) throw invalidTemplate("テンプレートのファイル構造を確認してください。");
    const flags = input.readUInt16LE(offset + 8), uncompressed = input.readUInt32LE(offset + 24);
    const nameLength = input.readUInt16LE(offset + 28), extraLength = input.readUInt16LE(offset + 30), commentLength = input.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || uncompressed === 0xffffffff) throw invalidTemplate("暗号化・ZIP64形式のテンプレートには対応していません。");
    const name = input.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (names.has(name) || (!allowVba && /(?:^|\/)vbaProject\.bin$/i.test(name)) || /(?:^|\/)macrosheets\//i.test(name) || name.includes("\\") || name.split("/").some(part => part === ".." || part === ".") || name.startsWith("/")) throw invalidTemplate("対応していないテンプレートの構造です。");
    names.add(name);
    expandedBytes += uncompressed;
    if (expandedBytes > MAX_UNCOMPRESSED_BYTES) throw invalidTemplate("展開後のテンプレートが64MBを超えています。");
    offset = next;
  }
  if (offset !== end || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) throw invalidTemplate(".xlsxテンプレートを指定してください。");
  return input;
}

function statusFor(state, day, record, now) {
  if (day < C.firstDay(state)) return "記録開始前";
  if (day > now.day) return "これから";
  if (record?.leave) return C.LEAVES[record.leave];
  if (record?.start) return record.end ? C.workday(day) === false ? "休日出勤" : "勤務" : "退勤未入力";
  return C.holiday(day) || (C.workday(day) === true ? "未入力" : C.workday(day) === false ? "休日" : "祝日未確認");
}

function dayValues(state, day, now) {
  const record = day >= C.firstDay(state) && day <= now.day ? state.records[day] : null;
  if (record && !C.validateRecord(record, day, now, state.settings).ok) {
    throw new ApiError(422, "EXPORT_DATA_INVALID", `${day}の勤務記録を確認してください。`);
  }
  const hasWork = !!record?.start && !C.fullLeave(record), place = state.settings.places.find(item => item.id === record?.locationId);
  const values = {
    day, weekday: C.WEEK[C.weekday(day)], holiday: C.holiday(day), status: statusFor(state, day, record, now),
    leave: record?.leave ? C.LEAVES[record.leave] : "", sourceDay: record?.leave === "comp" ? record.sourceDay : "",
    start: hasWork ? C.timeToMin(record.start) / 1440 : "",
    end: hasWork && record.end ? C.timeToMin(record.end) / 1440 : "",
    endWithOffset: hasWork && record.end ? C.timeToMin(record.end) / 1440 + (record.overnight ? 1 : 0) : "",
    overnight: hasWork && record.end ? record.overnight : "", breakMinutes: hasWork ? record.breakMinutes : "",
    workedHours: hasWork ? C.worked(record, day, now) / 60 : "",
    absenceHours: record ? C.absenceMinutes(record, day, now) / 60 : "",
    locationCode: hasWork ? place?.code ?? "" : "", locationName: hasWork ? place?.name ?? "" : "", note: record?.note ?? "",
    phases: C.phaseText(record)
  };
  for (const id of C.PROJECTS) values[`allocation.${id}`] = record ? record.allocation[id] : "";
  return values;
}

function createExcelRenderer() {
  return {
    async render({ templateBytes, mapping, state, period, now }) {
      if (mapping?.version === 2 && mapping.layout === "set-report") {
        const { renderSetReport } = require("./set-report.cjs");
        return renderSetReport({ templateBytes: validateTemplateBytes(templateBytes, { allowVba: true }), mapping, state, period, now });
      }
      validateMapping(mapping);
      const input = validateTemplateBytes(templateBytes);
      if (!period || !C.validDay(period.start) || !C.validDay(period.end) || period.start > period.end || (+C.date(period.end) - +C.date(period.start)) / 86400000 >= 366) {
        throw new ApiError(422, "EXPORT_PERIOD_INVALID", "対象期間は366日以内で指定してください。");
      }
      if (!now || !C.validDay(now.day) || !Number.isInteger(now.minutes) || now.minutes < 0 || now.minutes > 1439 || !plainObject(state?.records) || C.validateSettings(state?.settings)) {
        throw new ApiError(422, "EXPORT_DATA_INVALID", "勤務記録と設定を確認してください。");
      }
      const days = C.dates(period.start, period.end);
      if (days.length > mapping.days.capacity) throw invalidMapping("対象期間がテンプレートの日別行数を超えています。");
      let sheet;
      try { sheet = await require("./xlsx-template.cjs").openXlsxSheet(input, mapping.worksheet); }
      catch (error) { if (error instanceof ApiError) throw error; throw invalidTemplate("Excelテンプレートを読み込めませんでした。"); }
      const writes = new Map();
      const queue = (target, value) => {
        address(target);
        if (writes.has(target)) throw invalidMapping(`同じセルが複数の項目に指定されています: ${target}`);
        const cell = sheet.getCell(target);
        if (cell.isMerged && cell.master.address !== cell.address) throw invalidMapping(`結合セルの先頭以外には書き込めません: ${target}`);
        if (cell.formula || plainObject(cell.value) && (Object.hasOwn(cell.value, "formula") || Object.hasOwn(cell.value, "sharedFormula"))) {
          throw invalidMapping(`数式のセルには書き込めません: ${target}`);
        }
        if (typeof value === "number" && !Number.isFinite(value)) throw new ApiError(422, "EXPORT_DATA_INVALID", "出力する勤務時間を確認してください。");
        writes.set(target, value);
      };
      const employee = C.employee(state);
      const common = {
        "employee.name": employee.name, "employee.department": employee.department, "employee.id": employee.id,
        "period.start": period.start, "period.end": period.end, "settings.workSummary": state.settings.workSummary
      };
      for (const [field, target] of Object.entries(mapping.cells ?? {})) queue(target, common[field]);
      for (let index = 0; index < mapping.days.capacity; index++) {
        const values = index < days.length ? dayValues(state, days[index], now) : {};
        for (const [field, column] of Object.entries(mapping.days.columns)) queue(`${column}${mapping.days.startRow + index}`, values[field] ?? "");
      }
      const totals = C.summary(state, period, now), summary = {
        minutes: totals.minutes, hours: totals.minutes / 60, leaveDays: totals.leave, workedDays: totals.days,
        absenceMinutes: totals.absenceMinutes, absenceHours: totals.absenceMinutes / 60
      };
      for (const id of C.PROJECTS) summary[`allocation.${id}`] = totals.allocation[id];
      for (const [field, target] of Object.entries(mapping.summary ?? {})) queue(target, summary[field]);
      // Cell values are replaced only after the entire mapping has been checked.
      // Strings, including a leading '=', remain strings rather than formula objects.
      for (const [target, value] of writes) sheet.getCell(target).value = value;
      try { return Buffer.from(await sheet.save()); }
      catch { throw new ApiError(500, "EXCEL_RENDER_FAILED", "Excelファイルを生成できませんでした。"); }
    }
  };
}

module.exports = { createExcelRenderer };

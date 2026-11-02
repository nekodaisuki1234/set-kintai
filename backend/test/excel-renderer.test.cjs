"use strict";
const {unknownDay,unknownNextDay}=require("../../tests/paper-calendar-fixture.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { C } = require("../src/core.cjs");
const { createExcelRenderer } = require("../src/excel-renderer.cjs");

const clone = value => JSON.parse(JSON.stringify(value));
const now = { day: "2026-10-28", minutes: 23 * 60 };
const period = { start: "2026-10-24", end: "2026-10-27" };
const mapping = {
  version: 1, worksheet: "勤務表",
  cells: { "employee.name": "B2", "employee.id": "F2", "period.start": "B4", "settings.workSummary": "B5" },
  days: { startRow: 8, capacity: 5, columns: {
    day: "A", weekday: "B", holiday: "C", status: "D", start: "E", end: "F", endWithOffset: "G",
    breakMinutes: "H", workedHours: "I", absenceHours: "J", note: "K", "allocation.P1": "L",
    "allocation.P2": "M", "allocation.P3": "N", "allocation.P4": "O", "allocation.SET": "P", sourceDay: "Q"
  } },
  summary: { hours: "I15", absenceHours: "J15", leaveDays: "K15", "allocation.SET": "P15" }
};

function state() {
  const result = clone(C.createState(now, { startDay: "2026-04-01", employee: { name: "山田 花子", department: "開発", id: "E123" } }));
  result.settings.workSummary = "=SUM(A1:A2)";
  result.records["2026-10-24"] = { ...clone(C.empty(result)), start: "22:00", end: "03:00", overnight: true, breakMinutes: 60, note: "=HYPERLINK(\"https://example.invalid\",\"text\")", allocation: { P1: 2, P2: 1, P3: 0, P4: 0, SET: 1 } };
  result.records["2026-10-26"] = { ...clone(C.empty(result)), leave: "comp", sourceDay: "2026-10-24" };
  result.records["2026-10-27"] = { ...clone(C.empty(result)), start: "09:00", end: "14:00", leave: "am", note: "テスト", allocation: { P1: 4, P2: 0, P3: 0, P4: 0, SET: 0 } };
  return result;
}

async function template() {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("勤務表"), untouched = workbook.addWorksheet("計算");
  workbook.creator = "Template author";
  sheet.getCell("A1").value = "会社の勤務表";
  sheet.mergeCells("A1:Q1");
  sheet.getCell("A1").font = { name: "游ゴシック", bold: true, size: 16, color: { argb: "FF123456" } };
  sheet.getCell("B2").value = "テンプレート氏名";
  sheet.getCell("B2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF5F1" } };
  sheet.getCell("B2").border = { bottom: { style: "thin", color: { argb: "FF123456" } } };
  for (let row = 8; row <= 12; row++) {
    for (const column of Object.values(mapping.days.columns)) sheet.getCell(`${column}${row}`).value = "サンプル";
    for (const column of ["E", "F", "G"]) sheet.getCell(`${column}${row}`).numFmt = "[h]:mm";
    sheet.getRow(row).height = 24;
  }
  sheet.getCell("R8").value = { formula: "SUM(L8:P8)", result: 0 };
  sheet.getColumn("K").width = 35;
  sheet.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.views = [{ state: "frozen", ySplit: 7 }];
  untouched.getCell("B2").value = { formula: "'勤務表'!I15", result: 0 };
  untouched.getCell("B3").value = "触らない文字";
  // Trusted workbook content, not an API record: writing this comment exercises
  // ExcelJS's VML/comment serialization and its UUID v4 dependency.
  untouched.getCell("B3").note = "このコメントは会社のテンプレートに含まれます。";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function load(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);
const serial = value => value instanceof Date ? (value.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : value;

test("template copy preserves unrelated cells, sheets, formulas, formatting and input bytes", async () => {
  const templateBytes = await template(), originalBytes = Buffer.from(templateBytes), inputState = state(), beforeState = clone(inputState);
  const output = await createExcelRenderer().render({ templateBytes, mapping, state: inputState, period, now });
  assert.ok(Buffer.isBuffer(output));
  assert.deepEqual(templateBytes, originalBytes);
  assert.deepEqual(inputState, beforeState);
  const workbook = await load(output), sheet = workbook.getWorksheet("勤務表"), source = (await load(templateBytes)).getWorksheet("勤務表");
  assert.deepEqual(workbook.worksheets.map(item => item.name), ["勤務表", "計算"]);
  assert.equal(sheet.getCell("A1").value, "会社の勤務表");
  assert.deepEqual(sheet.getCell("A1").font, source.getCell("A1").font);
  assert.deepEqual(sheet.getCell("B2").fill, source.getCell("B2").fill);
  assert.deepEqual(sheet.getCell("B2").border, source.getCell("B2").border);
  assert.equal(sheet.getCell("B2").value, "山田 花子");
  assert.equal(sheet.getCell("F2").value, "E123");
  assert.equal(sheet.getCell("B4").value, period.start);
  assert.equal(sheet.getRow(8).height, 24);
  assert.equal(sheet.getColumn("K").width, 35);
  assert.equal(sheet.getCell("E8").numFmt, "[h]:mm");
  assert.equal(sheet.pageSetup.orientation, "landscape");
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.views[0].ySplit, 7);
  assert.equal(sheet.getCell("R8").formula, "SUM(L8:P8)");
  assert.equal(workbook.getWorksheet("計算").getCell("B2").formula, "'勤務表'!I15");
  assert.equal(workbook.getWorksheet("計算").getCell("B3").value, "触らない文字");
  assert.equal(sheet.getCell("B5").value, "=SUM(A1:A2)");
  assert.equal(sheet.getCell("B5").formula, undefined);
  assert.equal(sheet.getCell("K8").value, inputState.records[period.start].note);
  assert.equal(sheet.getCell("K8").formula, undefined);
  assert.equal(sheet.getCell("D8").value, "休日出勤");
  assert.equal(serial(sheet.getCell("E8").value), 22 / 24);
  assert.equal(serial(sheet.getCell("F8").value), 3 / 24);
  assert.equal(serial(sheet.getCell("G8").value), 1 + 3 / 24);
  assert.equal(sheet.getCell("I8").value, 4);
  assert.equal(sheet.getCell("P8").value, 1);
  assert.equal(sheet.getCell("Q10").value, "2026-10-24");
  assert.equal(sheet.getCell("D10").value, "代休");
  assert.equal(sheet.getCell("J11").value, 0, "four hours of work plus half leave has no absence");
  assert.equal(sheet.getCell("I15").value, 8);
  assert.equal(sheet.getCell("K15").value, 0.5);
  assert.equal(sheet.getCell("P15").value, 1);
  // Readers represent an empty inline string as either null or an empty string.
  for (const column of Object.values(mapping.days.columns)) assert.equal(sheet.getCell(`${column}12`).value ?? "", "", "unused mapped rows are cleared");
});

test("an existing template comment and VML survive the package-preserving writer", async () => {
  const templateBytes = await template(), originalBytes = Buffer.from(templateBytes);
  const sourceCell = (await load(templateBytes)).getWorksheet("計算").getCell("B3");
  const commentText = note => typeof note === "string" ? note : note.texts.map(part => part.text).join("");
  assert.equal(commentText(sourceCell.note), "このコメントは会社のテンプレートに含まれます。");
  const output = await createExcelRenderer().render({ templateBytes, mapping, state: state(), period, now });
  const outputCell = (await load(output)).getWorksheet("計算").getCell("B3");
  assert.equal(outputCell.value, sourceCell.value);
  assert.equal(commentText(outputCell.note), commentText(sourceCell.note));
  assert.deepEqual(templateBytes, originalBytes);
});

test("optional phase columns export canonical Japanese labels separately from the unchanged free note", async () => {
  const input = state(), mapped = clone(mapping);
  mapped.days.columns.phases = "S";
  input.records[period.start].phases = ["meeting", "test", "design"];
  input.records["2026-10-27"].phases = [];
  const note = input.records[period.start].note;
  const bytes = await template();
  const output = await createExcelRenderer({ ExcelJS }).render({ templateBytes: bytes, mapping: mapped, state: input, period, now });
  const sheet = (await load(output)).getWorksheet("勤務表");
  assert.equal(sheet.getCell("S8").value, "設計・テスト・その他");
  assert.equal(sheet.getCell("K8").value, note);
  assert.equal(sheet.getCell("S10").value ?? "", "", "old records with no phase field remain exportable");
  assert.equal(sheet.getCell("S11").value ?? "", "");
  assert.equal(sheet.getCell("S12").value ?? "", "", "unused rows do not inherit phase content");
  const untouched = await createExcelRenderer().render({ templateBytes: bytes, mapping, state: input, period, now });
  assert.equal((await load(untouched)).getWorksheet("勤務表").getCell("S8").value, null, "an omitted phase mapping creates no new output column");
  assert.deepEqual(input.records[period.start].phases, ["meeting", "test", "design"]);
});

test("negative actual hours remain numeric and do not become Excel date serials", async () => {
  const input = state();
  input.records["2026-10-27"] = { ...clone(C.empty(input)), start: "09:00", end: "09:30", breakMinutes: 60, note: "確認" };
  const output = await createExcelRenderer({ ExcelJS }).render({ templateBytes: await template(), mapping, state: input, period, now });
  const sheet = (await load(output)).getWorksheet("勤務表");
  assert.equal(sheet.getCell("I11").value, -0.5);
  assert.equal(sheet.getCell("J11").value, 8);
});

test("holiday name and unknown calendar dates use core calendar rather than invented workdays", async () => {
  const holidayState = state(), single = clone(mapping);
  single.days.capacity = 1;
  const holidayPeriod = { start: "2026-09-21", end: "2026-09-21" };
  const output = await createExcelRenderer().render({ templateBytes: await template(), mapping: single, state: holidayState, period: holidayPeriod, now });
  const sheet = (await load(output)).getWorksheet("勤務表");
  assert.equal(sheet.getCell("C8").value, "敬老の日");
  assert.equal(sheet.getCell("D8").value, "敬老の日");
  const futurePeriod = { start: unknownDay, end: unknownDay }, futureNow = { day: unknownNextDay, minutes: 600 };
  const future = await createExcelRenderer().render({ templateBytes: await template(), mapping: single, state: holidayState, period: futurePeriod, now: futureNow });
  assert.equal((await load(future)).getWorksheet("勤務表").getCell("D8").value, "祝日未確認");
});

test("mapping rejects formula targets, merged subordinate cells, duplicate targets and unsupported fields", async () => {
  const templateBytes = await template();
  const invalid = [
    map => { map.cells["employee.name"] = "R8"; },
    map => { map.cells["employee.name"] = "B1"; },
    map => { map.cells["employee.name"] = "A8"; },
    map => { map.days.columns.note = "A"; },
    map => { map.summary.hours = "A8"; },
    map => { map.cells["employee.email"] = "B3"; },
    map => { map.days.columns["allocation.P5"] = "S"; },
    map => { map.days.columns.day = "XFE"; },
    map => { map.cells["employee.name"] = "B0"; },
    map => { map.cells["employee.name"] = "$B$2"; },
    map => { map.cells["employee.name"] = "B1048577"; },
    map => { map.days.capacity = 367; },
    map => { map.days.startRow = 1048576; },
    map => { map.days.columns = {}; },
    map => { map.version = 2; },
    map => { map.worksheet = "missing"; },
    map => { map.eval = "process.env"; }
  ];
  for (const mutate of invalid) {
    const copy = clone(mapping); mutate(copy);
    await rejectsCode(createExcelRenderer().render({ templateBytes, mapping: copy, state: state(), period, now }), "TEMPLATE_MAPPING_INVALID");
  }
});

test("reserved rows are checked before any write including unused rows", async () => {
  const bytes = await template(), workbook = await load(bytes);
  workbook.getWorksheet("勤務表").getCell("L12").value = { formula: "SUM(L8:L11)" };
  const original = Buffer.from(await workbook.xlsx.writeBuffer());
  await rejectsCode(createExcelRenderer().render({ templateBytes: original, mapping, state: state(), period, now }), "TEMPLATE_MAPPING_INVALID");
  assert.equal((await load(original)).getWorksheet("勤務表").getCell("B2").value, "テンプレート氏名");
});

test("period capacity and record data are validated", async () => {
  const templateBytes = await template(), short = clone(mapping); short.days.capacity = 3;
  await rejectsCode(createExcelRenderer().render({ templateBytes, mapping: short, state: state(), period, now }), "TEMPLATE_MAPPING_INVALID");
  for (const invalid of [{ start: "2026-02-30", end: "2026-03-01" }, { start: "2026-01-01", end: "2027-01-02" }]) {
    await rejectsCode(createExcelRenderer().render({ templateBytes, mapping, state: state(), period: invalid, now }), "EXPORT_PERIOD_INVALID");
  }
  const invalid = state(); invalid.records[period.start].allocation.P1 = NaN;
  await rejectsCode(createExcelRenderer().render({ templateBytes, mapping, state: invalid, period, now }), "EXPORT_DATA_INVALID");
  await rejectsCode(createExcelRenderer().render({ templateBytes, mapping, state: state(), period, now: { ...now, minutes: -1 } }), "EXPORT_DATA_INVALID");
});

test("invalid, oversized, encrypted and macro ZIPs are rejected before rendering", async () => {
  const templateBytes = await template(), renderer = createExcelRenderer();
  const check = bytes => rejectsCode(renderer.render({ templateBytes: bytes, mapping, state: state(), period, now }), "TEMPLATE_INVALID");
  await check(Buffer.from("not a workbook"));
  await check(Buffer.alloc(8 * 1024 * 1024 + 1));
  const encrypted = Buffer.from(templateBytes), firstCentral = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(firstCentral + 8) | 1, firstCentral + 8);
  await check(encrypted);
  // Change a ZIP entry's directory name to a macro file without parsing any content.
  const macro = Buffer.from(templateBytes), marker = Buffer.from("xl/vbaProject.bin");
  let headerOffset = firstCentral;
  while (!macro.subarray(headerOffset + 46, headerOffset + 46 + macro.readUInt16LE(headerOffset + 28)).toString("utf8").endsWith("sheet1.xml")) {
    headerOffset += 46 + macro.readUInt16LE(headerOffset + 28) + macro.readUInt16LE(headerOffset + 30) + macro.readUInt16LE(headerOffset + 32);
    assert.equal(macro.readUInt32LE(headerOffset), 0x02014b50);
  }
  const nameOffset = headerOffset + 46, originalLength = macro.readUInt16LE(headerOffset + 28);
  assert.ok(originalLength >= marker.length);
  macro.fill(0x20, nameOffset, nameOffset + originalLength);
  marker.copy(macro, nameOffset + originalLength - marker.length);
  await check(macro);
});

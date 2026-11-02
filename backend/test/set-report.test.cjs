"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const ExcelJS = require("exceljs"), JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");
const { C } = require("../src/core.cjs");
const { createExcelRenderer } = require("../src/excel-renderer.cjs");
const mapping = { version: 2, layout: "set-report", fiscalYear: 2026, closingDay: 31 };
const period = { start: "2026-10-01", end: "2026-10-31" }, now = { day: "2026-11-02", minutes: 600 };
const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const parse = text => new DOMParser().parseFromString(text, "application/xml");
const all = (doc, name) => Array.from(doc.getElementsByTagNameNS(ns, name));
const clone = value => JSON.parse(JSON.stringify(value));
function state() {
  const s = clone(C.createState(now, { startDay: "2026-04-01", employee: { name: "テスト 利用者", department: "開発", id: "E1" } }));
  s.settings.workSummary = "共通の作業概要";
  s.settings.projects[0].name = "新しい案件";
  s.records["2026-10-17"] = { ...C.empty(s), start: "21:00", end: "07:30", overnight: true, breakMinutes: 60, note: '=HYPERLINK("x") & <文字>', phases: ["test", "meeting"], allocation: { P1: 6.5, P2: 1, P3: 0, P4: 0, SET: 2 } };
  s.records["2026-10-29"] = { ...C.empty(s), leave: "comp", sourceDay: "2026-10-17" };
  s.records["2026-10-30"] = { ...C.empty(s), start: "09:00", end: "14:00", leave: "pm", note: "半休", allocation: { P1: 4, P2: 0, P3: 0, P4: 0, SET: 0 } };
  return s;
}
async function fixture({ note = true, closing = 99 } = {}) {
  const w = new ExcelJS.Workbook();
  const previous = w.addWorksheet("2026年09月"); previous.getCell("C47").value = "旧PJ名"; previous.getCell("I5").value = "以前の実績";
  const s = w.addWorksheet("2026年10月");
  for (let r = 1; r <= 58; r++) for (let c = 1; c <= 36; c++) s.getCell(r, c).value = "";
  s.getCell("C1").value = (Date.UTC(2026, 9, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  for (let r = 5; r <= 35; r++) {
    s.getCell("F" + r).value = { formula: `(D${r}-C${r}-E${r})*24`, result: 8 };
    s.getCell("O" + r).value = { formula: `SUM(J${r}:N${r})-F${r}`, result: 0 };
    for (const col of ["C", "D", "E"]) s.getCell(col + r).numFmt = "[h]:mm";
  }
  s.getCell("J36").value = { formula: "SUM(J5:J35)", result: 100 };
  s.getCell("C47").value = "以前の対象月PJ";
  s.getCell("B42").value = "以前の概要"; s.mergeCells("B42:N44");
  s.getCell("I21").note = "既存の担当者メモ";
  if (note) s.getCell("O2").note = "既存の説明";
  else { s.getCell("I21").note = undefined; }
  s.pageSetup = { paperSize: 9, orientation: "portrait", printArea: "B1:N58" };
  s.getColumn("I").width = 30;
  const master = w.addWorksheet("マスタ"); master.getCell("B2").value = closing; master.getCell("B1").value = { formula: 'CELL("filename",A1)', result: "前回の名前" };
  const annual = w.addWorksheet("★36協定チェックシート★"); annual.getCell("C3").value = { formula: "'2026年10月'!J36", result: 100 };
  const z = await JSZip.loadAsync(await w.xlsx.writeBuffer());
  z.file("[Content_Types].xml", (await z.file("[Content_Types].xml").async("string")).replace("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "application/vnd.ms-excel.sheet.macroEnabled.main+xml").replace("</Types>", '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));
  z.file("xl/vbaProject.bin", Buffer.from([0, 1, 2, 255, 128, 13, 10]));
  z.file("xl/printerSettings/printerSettings1.bin", Buffer.from("printer-preserved"));
  z.file("customXml/item1.xml", "<company>preserve</company>");
  return z.generateAsync({ type: "nodebuffer" });
}
const render = (bytes, s = state(), overrides = {}) => createExcelRenderer().render({ templateBytes: bytes, mapping, period, now, state: s, ...overrides });

test("xlsm preserves VBA, every other month's inputs, styles and print parts; edits only target-period inputs", async () => {
  const input = await fixture(), before = Buffer.from(input), s = state(), beforeState = clone(s);
  const output = await render(input, s), a = await JSZip.loadAsync(input), b = await JSZip.loadAsync(output);
  assert.deepEqual(input, before); assert.deepEqual(clone(s), beforeState);
  for (const name of ["xl/vbaProject.bin", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet3.xml", "xl/printerSettings/printerSettings1.bin", "customXml/item1.xml"]) assert.deepEqual(await b.file(name).async("nodebuffer"), await a.file(name).async("nodebuffer"), name);
  const source = parse(await a.file("xl/worksheets/sheet2.xml").async("string")), result = parse(await b.file("xl/worksheets/sheet2.xml").async("string"));
  assert.deepEqual(all(result, "f").map(n => n.textContent), all(source, "f").map(n => n.textContent));
  assert.deepEqual(all(result, "pageSetup").map(n => n.toString()), all(source, "pageSetup").map(n => n.toString()));
  const w = new ExcelJS.Workbook(); await w.xlsx.load(output); const sheet = w.getWorksheet("2026年10月");
  assert.equal(sheet.getCell("C47").value, "新しい案件"); assert.equal(sheet.getCell("B42").value, s.settings.workSummary);
  assert.equal(w.getWorksheet("2026年09月").getCell("C47").value, "旧PJ名");
  const cell = address => all(result, "c").find(n => n.getAttribute("r") === address);
  assert.equal(Number(all(cell("D21"), "v")[0].textContent), 1 + 7.5 / 24);
  assert.equal(Number(all(cell("E21"), "v")[0].textContent), 1 / 24);
  assert.equal(sheet.getCell("P21").value, "出"); assert.equal(sheet.getCell("P33").value, "代"); assert.equal(sheet.getCell("P34").value, "半");
  assert.equal(sheet.getCell("I21").value, s.records["2026-10-17"].note); assert.equal(sheet.getCell("I21").formula, undefined);
  assert.equal(all(cell("F21"), "v").length, 0, "stale formula cache removed, formula retained");
  const comments = (await Promise.all(Object.keys(b.files).filter(n => /comments.*\.xml$/.test(n)).map(n => b.file(n).async("string")))).join("\n");
  assert.match(comments, /既存の担当者メモ/); assert.match(comments, /フェーズ：テスト・その他/); assert.match(comments, /代休元の休日出勤日：2026-10-17/); assert.match(comments, /休暇：午後半休/);
  assert.match(await b.file("xl/workbook.xml").async("string"), /fullCalcOnLoad="1"/);
});

test("notes are created without existing comment parts and are replaced without duplicates or stale source dates", async () => {
  const input = await fixture({ note: false }), first = await render(input);
  const s = state(); s.records["2026-10-17"].phases = ["design"]; s.records["2026-10-29"] = { ...C.empty(s), leave: "paid" };
  const second = await render(first, s), z = await JSZip.loadAsync(second);
  const notes = (await Promise.all(Object.keys(z.files).filter(n => /comments.*\.xml$/.test(n)).map(n => z.file(n).async("string")))).join("\n");
  assert.match(notes, /フェーズ：設計/); assert.doesNotMatch(notes, /フェーズ：テスト|代休元/);
  assert.equal((notes.match(/ref="I21"/g) || []).length, 1);
  const w = new ExcelJS.Workbook(); await w.xlsx.load(second); assert.ok(w.getWorksheet("2026年10月").getCell("I21").note);
});

test("incompatible period, fiscal year, close day and formula write targets fail before producing an artifact", async () => {
  const input = await fixture();
  for (const overrides of [ { period: { start: "2026-10-02", end: "2026-10-31" } }, { mapping: { ...mapping, fiscalYear: 2025 } }, { mapping: { ...mapping, closingDay: 15 }, period: { start: "2026-09-16", end: "2026-10-15" } } ]) await assert.rejects(render(input, state(), overrides), e => e.status === 422);
  const z = await JSZip.loadAsync(input); z.file("xl/worksheets/sheet2.xml", (await z.file("xl/worksheets/sheet2.xml").async("string")).replace(/<c r="K1"[^>]*>([\s\S]*?)<\/c>/, '<c r="K1"><f>SUM(A1:A2)</f></c>'));
  await assert.rejects(render(await z.generateAsync({ type: "nodebuffer" })), e => e.code === "TEMPLATE_MAPPING_INVALID");
});

test("15th close follows previous-month dates without rewriting the global master or other months", async () => {
  const input = await fixture({ closing: 15 }), s = state(); s.records["2026-09-16"] = { ...C.empty(s), start: "09:00", end: "18:00", note: "前月の作業", allocation: { P1: 8, P2: 0, P3: 0, P4: 0, SET: 0 } };
  const output = await render(input, s, { mapping: { ...mapping, closingDay: 15 }, period: { start: "2026-09-16", end: "2026-10-15" } });
  const w = new ExcelJS.Workbook(); await w.xlsx.load(output);
  assert.equal(w.getWorksheet("2026年10月").getCell("I5").value, "前月の作業"); assert.equal(w.getWorksheet("マスタ").getCell("B2").value, 15);
});

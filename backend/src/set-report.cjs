"use strict";

// Edit only the submitted worksheet's input cells. All other ZIP members (in
// particular VBA, past worksheets, styles and printer settings) are copied.
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const path = require("node:path").posix;
const { C } = require("./core.cjs");
const { ApiError } = require("./errors.cjs");
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const VML = "urn:schemas-microsoft-com:vml", EXCEL = "urn:schemas-microsoft-com:office:excel";
const MACRO_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const fail = (code, message) => { throw new ApiError(422, code, message); };
const bad = message => fail("TEMPLATE_INVALID", message);
const list = (root, ns, name) => Array.from(root.getElementsByTagNameNS(ns, name));
const children = (root, name) => Array.from(root.childNodes).filter(n => n.nodeType === 1 && n.namespaceURI === NS && n.localName === name);
const xml = doc => new XMLSerializer().serializeToString(doc);
function parse(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) bad("XMLの外部定義には対応していません。");
  try { return new DOMParser({ onError: level => { if (level !== "warning") throw new Error("XML"); } }).parseFromString(text, "application/xml"); }
  catch { return bad("ExcelのXML構造を確認してください。"); }
}
function node(doc, name, text, ns = NS) {
  const n = doc.createElementNS(ns, name);
  if (text !== undefined) n.appendChild(doc.createTextNode(String(text)));
  return n;
}
function relationPath(owner, target) {
  if (!target || target.includes("\\") || /^[a-z]+:/i.test(target)) bad("Excelの参照先を確認してください。");
  const resolved = target.startsWith("/") ? path.normalize(target.slice(1)) : path.normalize(path.join(path.dirname(owner), target));
  if (!resolved.startsWith("xl/")) bad("Excelの参照先を確認してください。");
  return resolved;
}

function reportPeriod(mapping, period) {
  if (!mapping || Object.keys(mapping).some(k => !["version", "layout", "fiscalYear", "closingDay"].includes(k)) ||
      mapping.version !== 2 || mapping.layout !== "set-report" || !Number.isInteger(mapping.fiscalYear) || mapping.fiscalYear < 2000 || mapping.fiscalYear > 9998 || ![15, 31].includes(mapping.closingDay)) {
    fail("TEMPLATE_MAPPING_INVALID", "SET帳票の年度と締日（15または31）を指定してください。");
  }
  if (!period || !C.validDay(period.start) || !C.validDay(period.end)) fail("EXPORT_PERIOD_INVALID", "出力期間を確認してください。");
  const month = period.end.slice(0, 7), first = month + "-01", fiscalYear = Number(month.slice(0, 4)) - (Number(month.slice(5)) < 4 ? 1 : 0);
  const start = mapping.closingDay === 31 ? first : C.add(first, -1).slice(0, 7) + "-16";
  const end = mapping.closingDay === 31 ? C.month(month).end : month + "-15";
  if (period.start !== start || period.end !== end || fiscalYear !== mapping.fiscalYear) {
    fail("EXPORT_PERIOD_INVALID", "テンプレートの年度・締日に対応する1か月分を指定してください。");
  }
  return { month, first, name: month.replace("-", "年") + "月", start, end };
}

async function renderSetReport({ templateBytes, mapping, state, period, now }) {
  const target = reportPeriod(mapping, period);
  if (!now || !C.validDay(now.day) || !Number.isInteger(now.minutes) || now.minutes < 0 || now.minutes > 1439 || !state?.records || Array.isArray(state.records) || C.validateSettings(state.settings)) fail("EXPORT_DATA_INVALID", "出力する勤怠データを確認してください。");
  let zip;
  try { zip = await JSZip.loadAsync(templateBytes, { checkCRC32: true }); } catch { bad("Excelテンプレートを読み込めませんでした。"); }
  const read = async name => {
    if (!zip.file(name)) return bad("Excelテンプレートの部品が不足しています。");
    return parse(await zip.file(name).async("string"));
  };
  const types = await read("[Content_Types].xml"), workbook = await read("xl/workbook.xml"), relations = await read("xl/_rels/workbook.xml.rels");
  if (!zip.file("xl/vbaProject.bin") || !list(types, CT, "Override").some(n => n.getAttribute("PartName") === "/xl/workbook.xml" && n.getAttribute("ContentType") === MACRO_TYPE)) bad("SET帳票の.xlsmテンプレートを指定してください。");
  const sheets = list(workbook, NS, "sheet");
  const sheetPath = name => {
    const sheet = sheets.find(n => n.getAttribute("name") === name);
    const rel = sheet && list(relations, PKG, "Relationship").find(n => n.getAttribute("Id") === sheet.getAttributeNS(REL, "id"));
    if (!rel || rel.getAttribute("TargetMode") === "External" || !rel.getAttribute("Type").endsWith("/worksheet")) bad("対象の勤務表シートがありません。");
    return relationPath("xl/workbook.xml", rel.getAttribute("Target"));
  };
  const sourcePath = sheetPath(target.name), doc = await read(sourcePath), master = await read(sheetPath("マスタ"));
  const cells = new Map(list(doc, NS, "c").map(c => [c.getAttribute("r"), c]));
  if (cells.size !== list(doc, NS, "c").length) bad("重複したセルがあります。");
  const scalar = c => children(c, "v")[0]?.textContent;
  const masterClose = list(master, NS, "c").find(n => n.getAttribute("r") === "B2");
  if (!masterClose || children(masterClose, "f").length || ![String(mapping.closingDay), ...(mapping.closingDay === 31 ? ["99"] : [])].includes(scalar(masterClose))) bad("マスタの締日と出力設定が一致しません。締日別のテンプレートを用意してください。");
  const expectedSerial = (+C.date(target.first) - Date.UTC(1899, 11, 30)) / 86400000;
  if (!cells.get("C1") || Number(scalar(cells.get("C1"))) !== expectedSerial || !children(cells.get("F5") || doc, "f").length || !children(cells.get("J36") || doc, "f").length) bad("SET帳票の年月・入力欄を確認してください。");
  const rows = new Map(list(doc, NS, "row").map(r => [Number(r.getAttribute("r")), r]));
  const index = address => [...address.match(/^[A-Z]+/)[0]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const merged = list(doc, NS, "mergeCell").map(m => m.getAttribute("ref").split(":"));
  const writes = new Map();
  function queue(address, value) {
    if (writes.has(address)) fail("TEMPLATE_MAPPING_INVALID", "出力先が重複しています。");
    const c = cells.get(address), row = Number(address.match(/\d+$/)[0]), col = index(address);
    if (!rows.has(row) || children(c || doc, "f").length) fail("TEMPLATE_MAPPING_INVALID", "数式のセルには書き込めません: " + address);
    if (merged.some(([a, b = a]) => a !== address && row >= Number(a.match(/\d+$/)[0]) && row <= Number(b.match(/\d+$/)[0]) && col >= index(a) && col <= index(b))) fail("TEMPLATE_MAPPING_INVALID", "結合セルの先頭以外には書き込めません: " + address);
    if (typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && (value.length > 32767 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value))) fail("EXPORT_DATA_INVALID", "Excelに出力できない文字または数値があります。");
    writes.set(address, value);
  }
  queue("K1", state.settings.minHours); queue("L1", state.settings.maxHours); queue("B42", state.settings.workSummary);
  state.settings.projects.forEach((p, i) => { queue("C" + (47 + i), p.name); queue("E" + (47 + i), p.description); });
  state.settings.places.forEach((p, i) => { queue("B" + (54 + i), p.code); queue("C" + (54 + i), p.name); queue("H" + (54 + i), p.address); });
  const days = C.dates(period.start, period.end), notes = new Map();
  for (let i = 0; i < 31; i++) {
    const day = days[i], row = i + 5;
    let record = day && day >= C.firstDay(state) && day <= now.day ? state.records[day] : null;
    if (record) {
      const check = C.validateRecord(record, day, now, state.settings);
      if (!check.ok) fail("EXPORT_DATA_INVALID", day + "の勤怠を確認してください。");
      record = check.value;
    }
    const hasWork = record?.start && !C.fullLeave(record), place = state.settings.places.find(p => p.id === record?.locationId);
    const fields = { C: hasWork ? C.timeToMin(record.start) / 1440 : null,
      D: hasWork && record.end ? C.timeToMin(record.end) / 1440 + (record.overnight ? 1 : 0) : null,
      E: hasWork ? record.breakMinutes / 1440 : null, H: hasWork ? place?.code || "" : null, I: record?.note || null,
      P: record ? ({ paid: "有", am: "半", pm: "半", holiday: "休", special: "特", comp: "代" }[record.leave] || (hasWork && C.workday(day) === false ? "出" : null)) : null };
    C.PROJECTS.forEach((id, p) => { fields[String.fromCharCode(74 + p)] = record?.allocation[id] || null; });
    for (const [col, value] of Object.entries(fields)) queue(col + row, value);
    const detail = [];
    if (record?.phases?.length) detail.push("フェーズ：" + C.phaseText(record));
    if (["am", "pm"].includes(record?.leave)) detail.push("休暇：" + C.LEAVES[record.leave]);
    if (record?.leave === "comp") detail.push("代休元の休日出勤日：" + record.sourceDay);
    notes.set("I" + row, detail.join("\n"));
  }
  for (const [address, value] of writes) {
    let c = cells.get(address);
    if (!c) {
      c = node(doc, "c"); c.setAttribute("r", address);
      const row = rows.get(Number(address.match(/\d+$/)[0]));
      row.insertBefore(c, children(row, "c").find(n => index(n.getAttribute("r")) > index(address)) || null);
    }
    for (const n of [...children(c, "v"), ...children(c, "is")]) c.removeChild(n);
    c.removeAttribute("t");
    if (value === null || value === "") continue;
    if (typeof value === "number") c.appendChild(node(doc, "v", value));
    else {
      c.setAttribute("t", "inlineStr"); const is = node(doc, "is"), t = node(doc, "t", value);
      t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); is.appendChild(t); c.appendChild(is);
    }
  }
  // A Node renderer does not evaluate Excel formulas. Invalidate only this
  // month's and the annual summary's caches, retaining every formula itself.
  function clearCaches(d) {
    for (const c of list(d, NS, "c")) if (children(c, "f").length) { for (const v of children(c, "v")) c.removeChild(v); c.removeAttribute("t"); }
  }
  clearCaches(doc);
  await writeNotes(zip, sourcePath, doc, types, notes, read);
  zip.file(sourcePath, xml(doc));
  const annualPath = sheetPath("★36協定チェックシート★"), annual = await read(annualPath);
  clearCaches(annual); zip.file(annualPath, xml(annual));
  let calc = list(workbook, NS, "calcPr")[0];
  if (!calc) { calc = node(workbook, "calcPr"); workbook.documentElement.insertBefore(calc, list(workbook, NS, "extLst")[0] || null); }
  for (const [k, v] of Object.entries({ calcMode: "auto", fullCalcOnLoad: "1", forceFullCalc: "1" })) calc.setAttribute(k, v);
  const lastSheet = list(workbook, NS, "definedName").find(n => n.getAttribute("name") === "LastEditedSheet");
  if (lastSheet) lastSheet.textContent = '"' + target.name + '"';
  zip.file("xl/workbook.xml", xml(workbook));
  zip.file("[Content_Types].xml", xml(types));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function writeNotes(zip, owner, sheet, types, notes, read) {
  const relPath = path.join(path.dirname(owner), "_rels", path.basename(owner) + ".rels");
  const rels = zip.file(relPath) ? await read(relPath) : parse('<Relationships xmlns="' + PKG + '"/>');
  const members = list(rels, PKG, "Relationship");
  const related = type => members.find(n => n.getAttribute("Type") === REL + "/" + type);
  const commentRel = related("comments"), vmlRel = related("vmlDrawing");
  if ([commentRel, vmlRel].some(n => n?.getAttribute("TargetMode") === "External")) bad("メモの参照先を確認してください。");
  if (!commentRel && ![...notes.values()].some(Boolean)) return;
  const suffix = path.basename(owner, ".xml"), commentPath = commentRel ? relationPath(owner, commentRel.getAttribute("Target")) : "xl/comments/set-" + suffix + ".xml";
  const vmlPath = vmlRel ? relationPath(owner, vmlRel.getAttribute("Target")) : "xl/drawings/set-" + suffix + ".vml";
  if (!commentRel && zip.file(commentPath) || !vmlRel && zip.file(vmlPath)) bad("メモの保存先が重複しています。");
  const comments = commentRel ? await read(commentPath) : parse('<comments xmlns="' + NS + '"><authors/><commentList/></comments>');
  const vml = vmlRel ? await read(vmlPath) : parse('<xml xmlns:v="' + VML + '" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="' + EXCEL + '"><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>');
  const authors = list(comments, NS, "authors")[0], commentList = list(comments, NS, "commentList")[0];
  if (!authors || !commentList) bad("メモの構造を確認してください。");
  let authorId = list(authors, NS, "author").findIndex(n => n.textContent === "SET 勤怠");
  if (authorId < 0) { authorId = list(authors, NS, "author").length; authors.appendChild(node(comments, "author", "SET 勤怠")); }
  const marker = /(?:\n\n)?\[SET勤怠の補足\][\s\S]*?\[\/SET勤怠の補足\]/g;
  let shapeId = Math.max(1024, ...list(vml, VML, "shape").map(n => Number(n.getAttribute("id").match(/(\d+)$/)?.[1]) || 0));
  for (const [address, detail] of notes) {
    let comment = list(commentList, NS, "comment").find(n => n.getAttribute("ref") === address);
    const previous = comment ? list(comment, NS, "t").map(n => n.textContent).join("") : "";
    const original = previous.replace(marker, "");
    if (!detail && original === previous) continue;
    const text = original + (original && detail ? "\n\n" : "") + (detail ? "[SET勤怠の補足]\n" + detail + "\n[/SET勤怠の補足]" : "");
    const row = Number(address.slice(1)) - 1;
    let shape = list(vml, VML, "shape").find(n => list(n, EXCEL, "Row")[0]?.textContent === String(row) && list(n, EXCEL, "Column")[0]?.textContent === "8");
    if (!text) { if (comment) commentList.removeChild(comment); if (shape) shape.parentNode.removeChild(shape); continue; }
    if (!comment) { comment = node(comments, "comment"); comment.setAttribute("ref", address); comment.setAttribute("authorId", authorId); commentList.appendChild(comment); }
    for (const n of children(comment, "text")) comment.removeChild(n);
    const textNode = node(comments, "text"), t = node(comments, "t", text); t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); textNode.appendChild(t); comment.appendChild(textNode);
    if (!shape) {
      const fragment = parse('<v:shape xmlns:v="' + VML + '" xmlns:x="' + EXCEL + '" id="_x0000_s' + (++shapeId) + '" type="#_x0000_t202" style="position:absolute;width:220pt;height:90pt;z-index:1;visibility:hidden" fillcolor="#ffffe1"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"/></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>9, 10, ' + row + ', 5, 14, 10, ' + (row + 5) + ', 5</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>' + row + '</x:Row><x:Column>8</x:Column></x:ClientData></v:shape>');
      vml.documentElement.appendChild(vml.importNode(fragment.documentElement, true));
    }
  }
  const addRel = (type, target) => {
    const n = node(rels, "Relationship", undefined, PKG); let i = 1;
    while (list(rels, PKG, "Relationship").some(r => r.getAttribute("Id") === "rIdSet" + i)) i++;
    n.setAttribute("Id", "rIdSet" + i); n.setAttribute("Type", REL + "/" + type); n.setAttribute("Target", path.relative(path.dirname(owner), target)); rels.documentElement.appendChild(n); return n;
  };
  if (!commentRel) addRel("comments", commentPath);
  if (!vmlRel) { const r = addRel("vmlDrawing", vmlPath), legacy = node(sheet, "legacyDrawing"); legacy.setAttributeNS(REL, "r:id", r.getAttribute("Id")); sheet.documentElement.insertBefore(legacy, list(sheet, NS, "extLst")[0] || null); }
  if (!list(types, CT, "Override").some(n => n.getAttribute("PartName") === "/" + commentPath)) { const n = node(types, "Override", undefined, CT); n.setAttribute("PartName", "/" + commentPath); n.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"); types.documentElement.appendChild(n); }
  if (!list(types, CT, "Default").some(n => n.getAttribute("Extension") === "vml")) { const n = node(types, "Default", undefined, CT); n.setAttribute("Extension", "vml"); n.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.vmlDrawing"); types.documentElement.appendChild(n); }
  zip.file(commentPath, xml(comments)); zip.file(vmlPath, xml(vml)); zip.file(relPath, xml(rels));
}

module.exports = { renderSetReport, reportPeriod };

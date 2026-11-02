"use strict";
// The generic .xlsx path uses the same package-preserving approach as .xlsm.
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const path = require("node:path").posix;
const { ApiError } = require("./errors.cjs");
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const all = (root, name) => Array.from(root.getElementsByTagNameNS(NS, name));
const child = (root, name) => Array.from(root.childNodes).filter(n => n.nodeType === 1 && n.namespaceURI === NS && n.localName === name);
const column = address => [...address.match(/^[A-Z]+/)[0]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const rowNumber = address => Number(address.match(/\d+$/)[0]);
const invalid = () => new ApiError(422, "TEMPLATE_INVALID", "Excelテンプレートの構造を確認してください。");
function parse(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw invalid();
  return new DOMParser({ onError: level => { if (level !== "warning") throw invalid(); } }).parseFromString(text, "application/xml");
}
async function openXlsxSheet(bytes, name) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const read = async file => { if (!zip.file(file)) throw invalid(); return parse(await zip.file(file).async("string")); };
  const wb = await read("xl/workbook.xml"), rels = await read("xl/_rels/workbook.xml.rels");
  const s = all(wb, "sheet").find(n => n.getAttribute("name") === name);
  if (!s) throw new ApiError(422, "TEMPLATE_MAPPING_INVALID", "指定されたシートがテンプレートにありません。");
  const rel = Array.from(rels.getElementsByTagNameNS(PKG, "Relationship")).find(n => n.getAttribute("Id") === s.getAttributeNS(REL, "id"));
  if (!rel || rel.getAttribute("TargetMode") === "External" || !rel.getAttribute("Type").endsWith("/worksheet")) throw invalid();
  const target = rel.getAttribute("Target");
  if (!target || target.includes("\\") || /^[a-z]+:/i.test(target)) throw invalid();
  const file = target.startsWith("/") ? path.normalize(target.slice(1)) : path.normalize(path.join("xl", target));
  if (!file.startsWith("xl/")) throw invalid();
  const doc = await read(file), cells = new Map(all(doc, "c").map(n => [n.getAttribute("r"), n]));
  const data = all(doc, "sheetData")[0]; if (!data || cells.size !== all(doc, "c").length) throw invalid();
  const rows = new Map(all(doc, "row").map(n => [Number(n.getAttribute("r")), n]));
  const merges = all(doc, "mergeCell").map(n => n.getAttribute("ref").split(":"));
  const make = (tag, value) => { const n = doc.createElementNS(NS, tag); if (value !== undefined) n.appendChild(doc.createTextNode(String(value))); return n; };
  function set(address, value) {
    if (typeof value === "string" && (value.length > 32767 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value))) throw new ApiError(422, "EXPORT_DATA_INVALID", "Excelに出力できない文字があります。");
    let c = cells.get(address), r = rows.get(rowNumber(address));
    if (!r) { r = make("row"); r.setAttribute("r", rowNumber(address)); data.insertBefore(r, child(data, "row").find(n => Number(n.getAttribute("r")) > rowNumber(address)) || null); rows.set(rowNumber(address), r); }
    if (!c) { c = make("c"); c.setAttribute("r", address); r.insertBefore(c, child(r, "c").find(n => column(n.getAttribute("r")) > column(address)) || null); cells.set(address, c); }
    for (const n of [...child(c, "v"), ...child(c, "is")]) c.removeChild(n);
    c.removeAttribute("t");
    if (typeof value === "number") c.appendChild(make("v", value));
    else if (typeof value === "boolean") { c.setAttribute("t", "b"); c.appendChild(make("v", value ? 1 : 0)); }
    else { c.setAttribute("t", "inlineStr"); const is = make("is"), t = make("t", value ?? ""); t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); is.appendChild(t); c.appendChild(is); }
  }
  return {
    getCell(address) {
      const c = cells.get(address), merged = merges.find(([a, b = a]) => rowNumber(address) >= rowNumber(a) && rowNumber(address) <= rowNumber(b) && column(address) >= column(a) && column(address) <= column(b));
      return { formula: c && child(c, "f").length ? child(c, "f")[0].textContent || "shared-formula" : null,
        isMerged: Boolean(merged), master: { address: merged ? merged[0] : address }, set value(v) { set(address, v); } };
    },
    async save() {
      const serializer = new XMLSerializer();
      const dimension = all(doc, "dimension")[0];
      if (dimension) {
        const addresses = [...cells.keys()]; let col = Math.max(...addresses.map(column)), letters = "";
        while (col) { letters = String.fromCharCode(65 + (col - 1) % 26) + letters; col = Math.floor((col - 1) / 26); }
        dimension.setAttribute("ref", "A1:" + letters + Math.max(...addresses.map(rowNumber)));
      }
      zip.file(file, serializer.serializeToString(doc));
      let calc = all(wb, "calcPr")[0];
      if (!calc) { calc = wb.createElementNS(NS, "calcPr"); wb.documentElement.insertBefore(calc, all(wb, "extLst")[0] || null); }
      calc.setAttribute("fullCalcOnLoad", "1"); calc.setAttribute("forceFullCalc", "1");
      zip.file("xl/workbook.xml", serializer.serializeToString(wb));
      return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    }
  };
}
module.exports = { openXlsxSheet };

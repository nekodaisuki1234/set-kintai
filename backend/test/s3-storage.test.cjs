"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { createS3ExportStorage, createS3TemplateProvider } = require("../src/s3-storage.cjs");
const { exportFormat, TYPES } = require("../src/export-format.cjs");

const OWNER = { tenantId: "tenant-a", employeeId: "employee-a" };
const NOW = new Date("2026-10-28T11:00:00Z");
const commands = Object.fromEntries(["GetObject", "PutObject", "DeleteObject"].map(operation => [operation + "Command", class {
  constructor(input) { this.input = input; this.operation = operation; }
}]));
const code = (status, expected) => error => error.status === status && error.code === expected;

function fixture() {
  const objects = new Map(), calls = [], signCalls = [];
  const control = { failPut: null };
  const client = { async send({ operation, input }) {
    calls.push({ operation, input });
    if (operation === "PutObject") {
      if (control.failPut && input.Key.endsWith(control.failPut)) throw new Error("temporary upload failure");
      if (input.IfNoneMatch === "*" && objects.has(input.Key)) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      objects.set(input.Key, Buffer.from(input.Body)); return {};
    }
    if (operation === "DeleteObject") { objects.delete(input.Key); return {}; }
    if (operation === "GetObject") {
      if (!objects.has(input.Key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { Body: Readable.from([objects.get(input.Key)]), ContentLength: objects.get(input.Key).length };
    }
    throw new Error("unexpected operation");
  } };
  const storage = createS3ExportStorage({ client, bucket: "private-attendance", commands, now: () => NOW,
    signer: async request => { signCalls.push(request); return "https://signed.example/attendance?signature=temporary"; } });
  const provider = options => createS3TemplateProvider({ client, bucket: "private-attendance", commands,
    key: "templates/attendance.xlsx", mappingKey: "templates/attendance.mapping.json", ...options });
  return { storage, objects, calls, control, client, provider, signCalls };
}

test("exports and snapshots use private employee-derived immutable keys, with short-lived downloads", async () => {
  const f = fixture();
  const result = await f.storage.write({ identity: OWNER, id: "export-1", bytes: Buffer.from("xlsx"), snapshot: { revision: 5 } });
  assert.deepEqual(result, { key: "outputs/tenant-a/employee-a/export-1.xlsx", snapshotKey: "outputs/tenant-a/employee-a/export-1.snapshot.json" });
  for (const call of f.calls) { assert.equal(call.input.IfNoneMatch, "*"); assert.equal(call.input.ACL, undefined); }
  const download = await f.storage.sign({ ...result, id: "export-1", identity: OWNER });
  assert.equal(download.expiresAt, "2026-10-28T11:05:00.000Z");
  assert.equal(f.signCalls[0].expiresIn, 300); assert.equal(f.signCalls[0].command.input.Key, result.key);
  await assert.rejects(() => f.storage.sign({ ...result, id: "export-1", identity: { ...OWNER, employeeId: "other" } }), code(503, "invalid_export"));
  await assert.rejects(() => f.storage.write({ identity: OWNER, id: "../escape", bytes: Buffer.from("x"), snapshot: {} }), code(400, "invalid_export"));
});

test("a repeated output ID cannot overwrite or delete a previously accepted workbook", async () => {
  const f = fixture();
  const result = await f.storage.write({ identity: OWNER, id: "export-1", bytes: Buffer.from("first"), snapshot: { revision: 1 } });
  await assert.rejects(() => f.storage.write({ identity: OWNER, id: "export-1", bytes: Buffer.from("second"), snapshot: { revision: 2 } }), code(409, "export_exists"));
  assert.equal(f.objects.get(result.key).toString(), "first");
  assert.equal(JSON.parse(f.objects.get(result.snapshotKey)).revision, 1);
  assert.equal(f.calls.filter(call => call.operation === "DeleteObject").length, 0);
});

test("a partial upload removes only the object newly created by that attempt", async () => {
  const f = fixture(), prefix = "outputs/tenant-a/employee-a/export-1";
  f.objects.set(prefix + ".snapshot.json", Buffer.from("existing snapshot"));
  await assert.rejects(() => f.storage.write({ identity: OWNER, id: "export-1", bytes: Buffer.from("new"), snapshot: {} }), code(409, "export_exists"));
  assert.equal(f.objects.has(prefix + ".xlsx"), false);
  assert.equal(f.objects.get(prefix + ".snapshot.json").toString(), "existing snapshot");
  const failing = fixture(); failing.control.failPut = ".snapshot.json";
  await assert.rejects(() => failing.storage.write({ identity: OWNER, id: "export-2", bytes: Buffer.from("new"), snapshot: {} }), code(503, "storage_unavailable"));
  assert.equal(failing.objects.size, 0);
});

test("conflict cleanup accepts only this storage instance's successful write result", async () => {
  const f = fixture();
  const result = await f.storage.write({ identity: OWNER, id: "export-1", bytes: Buffer.from("xlsx"), snapshot: {} });
  assert.equal(Object.isFrozen(result), true);
  await assert.rejects(() => f.storage.remove({ ...result }), code(400, "invalid_export"));
  await f.storage.remove(result); assert.equal(f.objects.size, 0);
});

test("oversized outputs fail before any upload", async () => {
  const f = fixture();
  const storage = createS3ExportStorage({ client: f.client, bucket: "private", commands, maxWorkbookBytes: 2 });
  await assert.rejects(() => storage.write({ identity: OWNER, id: "x", bytes: Buffer.from("long"), snapshot: {} }), code(413, "export_too_large"));
  assert.equal(f.calls.length, 0);
});

test("xlsm downloads retain their MIME type, UTF-8 report filename and owner-bound immutable base hash", async () => {
  const f = fixture(), bytes = Buffer.from("macro-workbook"), format = exportFormat({ version: 2, layout: "set-report" }, { name: "テスト 利用者" }, { end: "2026-10-31" });
  assert.equal(format.fileName, "作業報告書(2026年10月)_テスト 利用者.xlsm");
  const result = await f.storage.write({ identity: OWNER, id: "macro-1", bytes, snapshot: { revision: 1 }, format });
  const entry = { ...result, identity: OWNER, id: "macro-1" };
  assert.equal(result.key, "outputs/tenant-a/employee-a/macro-1.xlsm");
  assert.equal(f.calls[0].input.ContentType, TYPES.xlsm);
  assert.match(f.calls[0].input.ContentDisposition, /filename\*=UTF-8''/);
  assert.ok(decodeURIComponent(f.calls[0].input.ContentDisposition).endsWith(format.fileName));
  assert.deepEqual(await f.storage.read(entry), bytes);
  await f.storage.sign(entry);
  assert.equal(f.signCalls[0].command.input.ResponseContentType, TYPES.xlsm);
  assert.equal(f.signCalls[0].command.input.ResponseContentDisposition, f.calls[0].input.ContentDisposition);
  await assert.rejects(f.storage.read({ ...entry, identity: { ...OWNER, employeeId: "other" } }), code(503, "invalid_export"));
  f.objects.set(result.key, Buffer.from("tampered"));
  await assert.rejects(f.storage.read(entry), code(503, "invalid_export"));
  await f.storage.remove(result); assert.equal(f.objects.size, 0);
});

test("download names cannot inject headers or paths", async () => {
  const f = fixture();
  for (const name of ["evil\r\nHeader.xlsm", "../escape.xlsm", "wrong.xlsx"]) {
    await assert.rejects(f.storage.write({ identity: OWNER, id: "x", bytes: Buffer.from("x"), snapshot: {}, format: { extension: "xlsm", contentType: TYPES.xlsm, fileName: name } }), code(422, "invalid_export_format"));
  }
  assert.equal(f.calls.length, 0);
});

function installTemplate(f, overrides = {}) {
  const bytes = Buffer.from("a workbook copy");
  const envelope = { id: "attendance", version: "v1", templateSha256: createHash("sha256").update(bytes).digest("hex"), mapping: { sheets: [] }, ...overrides };
  f.objects.set("templates/attendance.xlsx", bytes);
  f.objects.set("templates/attendance.mapping.json", Buffer.from(JSON.stringify(envelope)));
  return { bytes, envelope };
}

test("template loading returns the configured workbook only when its bytes match the mapping hash", async () => {
  const f = fixture(), { bytes, envelope } = installTemplate(f);
  const template = await f.provider().load();
  assert.deepEqual(template, { id: "attendance", version: "v1", bytes, mapping: envelope.mapping });
  f.objects.set("templates/attendance.xlsx", Buffer.from("changed template"));
  await assert.rejects(() => f.provider().load(), code(503, "invalid_template"));
});

test("a missing template is explicit and malformed or oversized templates fail closed", async () => {
  await assert.rejects(() => createS3TemplateProvider().load(), code(501, "template_not_configured"));
  const f = fixture(); await assert.rejects(() => f.provider().load(), code(501, "template_not_configured"));
  installTemplate(f, { templateSha256: "wrong" }); await assert.rejects(() => f.provider().load(), code(503, "invalid_template"));
  installTemplate(f); await assert.rejects(() => f.provider({ maxTemplateBytes: 2 }).load(), code(503, "invalid_template"));
  f.objects.set("templates/attendance.mapping.json", Buffer.from("{bad json"));
  await assert.rejects(() => f.provider().load(), code(503, "invalid_template"));
});

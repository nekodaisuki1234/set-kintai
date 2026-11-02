"use strict";
const {unknownDay}=require("../../tests/paper-calendar-fixture.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");
const { C, RULES_VERSION } = require("../src/core.cjs");
const { ApiError } = require("../src/errors.cjs");
const { createMemoryStore } = require("../src/memory-store.cjs");
const { createAttendanceService } = require("../src/service.cjs");

const NOW = { day: "2026-10-28", minutes: 1200, full: "20:00:00" };
const DAY = NOW.day;
const OWNER = { tenantId: "tenant-a", employeeId: "employee-a" };
const OTHER = { tenantId: "tenant-a", employeeId: "employee-b" };
const OTHER_TENANT = { tenantId: "tenant-b", employeeId: "employee-a" };
const plain = value => JSON.parse(JSON.stringify(value));
const allocation = hours => ({ P1: hours, P2: 0, P3: 0, P4: 0, SET: 0 });
const initial = () => plain(C.createState(NOW, { startDay: "2026-09-01", employee: { name: "利用者", department: "開発", id: "E-1" } }));
const work = (change = {}) => ({ ...plain(C.empty(initial())), start: "09:00", end: "18:00", note: "開発作業", allocation: allocation(8), ...change });
const comp = sourceDay => ({ ...plain(C.empty(initial())), leave: "comp", sourceDay });
const expected = (status, code) => error => error instanceof ApiError && error.status === status && error.code === code;

function fixture(records = {}, options = {}) {
  const store = createMemoryStore(), state = initial();
  state.records = plain(records);
  store.seed(OWNER, state, { now: NOW });
  const calls = { loads: 0, renders: 0, writes: [], removes: [], signs: [] };
  const templateProvider = { async load() { calls.loads++; return { id: "attendance", version: "v1", bytes: Buffer.from("template"), mapping: { sheet: "勤務表" } }; } };
  const renderer = { async render() { calls.renders++; return Buffer.from("rendered-workbook"); } };
  const exportStorage = {
    async write(request) {
      calls.writes.push(request);
      return { key: "exports/" + request.identity.tenantId + "/" + request.identity.employeeId + "/" + request.id + ".xlsx", snapshotKey: "snapshots/" + request.id + ".json" };
    },
    async remove(entry) { calls.removes.push(entry); },
    async sign(entry) { calls.signs.push(entry); return { url: "https://download.example/" + entry.id, expiresAt: "2026-10-28T11:05:00Z" }; }
  };
  let nextId = 0;
  const service = createAttendanceService({ store, templateProvider, renderer, exportStorage,
    clock: () => NOW, ids: () => "export-" + (++nextId), ...options });
  return { store, state, service, calls, renderer, exportStorage, templateProvider };
}

test("day reads are bounded and cannot cross employee or tenant partitions", async () => {
  const f = fixture({ [DAY]: work({ note: "自分の記録" }) });
  for (const [identity, note] of [[OTHER, "別社員"], [OTHER_TENANT, "別テナント"]]) {
    const state = initial(); state.records[DAY] = work({ note }); f.store.seed(identity, state, { now: NOW });
  }
  const range = { start: DAY, end: DAY };
  assert.equal((await f.service.readDays(OWNER, range)).records[DAY].note, "自分の記録");
  assert.equal((await f.service.readDays(OTHER, range)).records[DAY].note, "別社員");
  assert.equal((await f.service.readDays(OTHER_TENANT, range)).records[DAY].note, "別テナント");
  await assert.rejects(() => f.service.readDays({ tenantId: "new", employeeId: "new" }, range), expected(404, "profile_not_provisioned"));
  await assert.rejects(() => f.service.readDays(OWNER, { ...range, employeeId: "employee-b" }), expected(400, "invalid_request"));
  await assert.rejects(() => f.service.readDays(OWNER, { start: "2026-01-01", end: "2027-01-02" }), expected(400, "invalid_period"));
  await assert.rejects(() => f.service.readDays(OWNER, { start: "9999-12-31", end: "9999-12-31" }), expected(400, "invalid_period"));
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: "9999-12-31", end: "9999-12-31" }, purpose: "review" }), expected(400, "invalid_period"));
});

test("full-record saving is strict after clock-out, while unfinished and negative work remain saveable", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ allocation: allocation(7) }) }), expected(422, "invalid_record"));
  assert.equal(f.store.inspect(OWNER).revision, 0);
  const running = await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ end: "", allocation: allocation(1) }) });
  assert.equal(running.revision, 1); assert.deepEqual(running.warnings, []); assert.equal(running.absenceMinutes, 0);
  const negative = await f.service.putDay(OWNER, DAY, { expectedRevision: 1, record: work({ end: "09:30", allocation: allocation(0) }) });
  assert.equal(negative.revision, 2); assert.equal(C.worked(negative.record, DAY, NOW), -30); assert.equal(negative.absenceMinutes, 480);
  assert.match(negative.warnings.join(), /休憩時間を引いた/);
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 2, period: { start: DAY, end: DAY } }), expected(422, "validation_failed"));
  assert.equal(f.calls.loads, 0); assert.equal(f.calls.writes.length, 0);
});

test("client identity, clock, validation options and historical exception markers cannot be injected", async () => {
  const f = fixture();
  for (const field of ["employeeId", "tenantId", "now", "strictAllocation"]) {
    await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work(), [field]: "forged" }), expected(400, "invalid_request"));
  }
  await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ legacyProjectAllocation: { SET: 20, P5: 10 } }) }), expected(400, "invalid_request"));
  await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ allocation: { ...allocation(8), P5: 0 } }) }), expected(400, "invalid_request"));
  assert.equal(f.store.inspect(OWNER).revision, 0);
});

test("phases persist separately from notes through legacy full saves and time corrections, and explicit empty selection clears them", async () => {
  const f = fixture();
  const saved = await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ phases: ["design", "test"] }) });
  assert.deepEqual(saved.record.phases, ["design", "test"]);
  assert.equal(saved.record.note, "開発作業");
  const fetched = await f.service.readDays(OWNER, { start: DAY, end: DAY });
  assert.deepEqual(fetched.records[DAY].phases, ["design", "test"]);
  fetched.records[DAY].phases.push("meeting");
  assert.deepEqual(f.store.inspect(OWNER).records[DAY].phases, ["design", "test"]);
  const legacyRecord = { ...saved.record, note: "自由入力を修正" }; delete legacyRecord.phases;
  const updated = await f.service.putDay(OWNER, DAY, { expectedRevision: 1, record: legacyRecord });
  assert.deepEqual(updated.record.phases, ["design", "test"]);
  assert.equal(updated.record.note, "自由入力を修正");
  const timed = await f.service.updateDayTime(OWNER, DAY, { expectedRevision: 2, changes: { end: "18:30" } });
  assert.deepEqual(timed.record.phases, ["design", "test"]);
  assert.equal(timed.record.allocation.P1, 8.5);
  const cleared = await f.service.putDay(OWNER, DAY, { expectedRevision: 3, record: { ...timed.record, phases: [] } });
  assert.deepEqual(cleared.record.phases, []);
  const legacy = work(); delete legacy.phases;
  const oldClient = fixture();
  assert.deepEqual((await oldClient.service.putDay(OWNER, DAY, { expectedRevision: 0, record: legacy })).record.phases, []);
});

test("invalid phase selections cannot be saved or supplied through the narrow time route", async () => {
  const f = fixture({ [DAY]: work({ phases: ["design"] }) });
  for (const phases of [undefined, null, "test", ["unknown"], ["design", "design"], [1], ["design", null], Array(1)]) {
    await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ phases }) }), expected(422, "invalid_record"));
  }
  await assert.rejects(() => f.service.updateDayTime(OWNER, DAY, { expectedRevision: 0, changes: { phases: ["test"] } }), expected(400, "invalid_request"));
  assert.equal(f.store.inspect(OWNER).revision, 0);
  assert.deepEqual(f.store.inspect(OWNER).records[DAY].phases, ["design"]);
});

test("selected phases are included in the export snapshot but do not satisfy a missing work note", async () => {
  const f = fixture({ [DAY]: work({ note: "　 ", phases: ["test"] }) });
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } }), error =>
    expected(422, "validation_failed")(error) && error.details.errors.some(issue => issue.day === DAY && issue.messages.some(message => message.includes("作業内容"))));
  assert.equal(f.calls.loads, 0); assert.equal(f.calls.writes.length, 0);
  const saved = await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ note: "境界値を確認", phases: ["test"] }) });
  await f.service.createExport(OWNER, { expectedRevision: saved.revision, period: { start: DAY, end: DAY } });
  assert.deepEqual(f.calls.writes[0].snapshot.state.records[DAY].phases, ["test"]);
  assert.equal(f.calls.writes[0].snapshot.state.records[DAY].note, "境界値を確認");
});

test("time-only updates recalculate P1, preserve manual allocations and cannot edit allocation through that route", async () => {
  const f = fixture({ [DAY]: work({ allocation: { ...allocation(6), P2: 2 } }) });
  const saved = await f.service.updateDayTime(OWNER, DAY, { expectedRevision: 0, changes: { breakMinutes: 90 } });
  assert.equal(saved.record.allocation.P1, 5.5); assert.equal(saved.record.allocation.P2, 2); assert.equal(saved.absenceMinutes, 30);
  await assert.rejects(() => f.service.updateDayTime(OWNER, DAY, { expectedRevision: 1, changes: { allocation: allocation(1) } }), expected(400, "invalid_request"));
  const over = fixture({ [DAY]: work({ allocation: { ...allocation(0), P2: 8 } }) });
  const corrected = await over.service.updateDayTime(OWNER, DAY, { expectedRevision: 0, changes: { breakMinutes: 90 } });
  assert.equal(corrected.record.allocation.P1, 0); assert.equal(corrected.record.allocation.P2, 8); assert.match(corrected.warnings.join(), /工数合計/);
  await assert.rejects(() => over.service.createExport(OWNER, { expectedRevision: 1, period: { start: DAY, end: DAY } }), expected(422, "validation_failed"));
});

test("time-only routes validate raw values before recalculating allocations", async () => {
  const f = fixture({ [DAY]: work() });
  for (const changes of [{ start: 9 }, { end: {} }, { overnight: "true" }, { breakMinutes: "60" },
    { start: "25:00" }, { end: null }, { breakMinutes: -1 }, { breakMinutes: 1441 }]) {
    await assert.rejects(() => f.service.updateDayTime(OWNER, DAY, { expectedRevision: 0, changes }), expected(422, "invalid_record"));
  }
  assert.equal(f.store.inspect(OWNER).revision, 0);
  assert.deepEqual(f.store.inspect(OWNER).records[DAY].allocation, allocation(8));
});

test("only the existing server-owned legacy source may preserve a combined value above 24 hours", async () => {
  const archived = work({ start: "09:00", end: "16:00", overnight: true, allocation: { ...allocation(0), SET: 30 }, legacyProjectAllocation: { P5: 10, SET: 20 } });
  const f = fixture({ [DAY]: archived });
  const client = { ...archived, note: "作業内容だけ修正" }; delete client.legacyProjectAllocation;
  const saved = await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: client });
  assert.equal(saved.record.allocation.SET, 30); assert.deepEqual(saved.record.legacyProjectAllocation, { P5: 10, SET: 20 });
  const corrected = await f.service.putDay(OWNER, DAY, { expectedRevision: 1, record: { ...client, allocation: { ...allocation(10), SET: 20 } } });
  assert.equal(Object.hasOwn(corrected.record, "legacyProjectAllocation"), false);
  const fresh = fixture();
  await assert.rejects(() => fresh.service.putDay(OWNER, DAY, { expectedRevision: 0, record: client }), expected(422, "invalid_record"));
});

test("employee revision CAS prevents stale writes and simultaneous reuse of the same comp source", async () => {
  const source = "2026-10-24", f = fixture({ [source]: work() });
  const attempts = await Promise.allSettled([
    f.service.putDay(OWNER, "2026-10-26", { expectedRevision: 0, record: comp(source) }),
    f.service.putDay(OWNER, "2026-10-27", { expectedRevision: 0, record: comp(source) })
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(result => result.status === "rejected" && result.reason.status === 409).length, 1);
  assert.equal(Object.keys(f.store.inspect(OWNER).links).length, 1);
  await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work() }), expected(409, "conflict"));
  const day = f.store.inspect(OWNER).links[source];
  const otherDay = day === "2026-10-26" ? "2026-10-27" : "2026-10-26";
  await assert.rejects(() => f.service.putDay(OWNER, otherDay, { expectedRevision: 1, record: comp(source) }), expected(422, "invalid_comp_link"));
});

test("linked source records cannot be invalidated or deleted until their comp day is released", async () => {
  const source = "2026-09-26", claimant = "2026-10-26", f = fixture({ [source]: work(), [claimant]: comp(source) });
  const read = await f.service.readDays(OWNER, { start: claimant, end: claimant });
  assert.deepEqual(Object.keys(read.records), [claimant], "reference days are validation context, not part of the response");
  const exported = await f.service.createExport(OWNER, { expectedRevision: 0, period: { start: claimant, end: claimant } });
  assert.equal(exported.validation.ok, true);
  assert.ok(f.calls.writes[0].snapshot.state.records[source], "snapshot retains the source needed to reproduce validation");
  await assert.rejects(() => f.service.deleteDay(OWNER, source, { expectedRevision: 0 }), expected(422, "invalid_comp_link"));
  await assert.rejects(() => f.service.putDay(OWNER, source, { expectedRevision: 0, record: work({ end: "09:30", allocation: allocation(0) }) }), expected(422, "invalid_comp_link"));
  await f.service.deleteDay(OWNER, claimant, { expectedRevision: 0 });
  await f.service.deleteDay(OWNER, source, { expectedRevision: 1 });
  assert.deepEqual(f.store.inspect(OWNER).records, {}); assert.deepEqual(f.store.inspect(OWNER).links, {});
});

test("configuration updates preserve server-owned employee identity and attendance start date", async () => {
  const f = fixture();
  const settings = plain(f.state.settings), defaults = plain(f.state.defaults);
  settings.employee = { id: settings.employee.id, name: settings.employee.name, department: settings.employee.department };
  settings.projects[4].name = "SETの作業";
  const saved = await f.service.putConfig(OWNER, { expectedRevision: 0, settings, defaults });
  assert.equal(saved.revision, 1); assert.equal(saved.settings.projects[4].name, "SETの作業");
  await assert.rejects(() => f.service.putConfig(OWNER, { expectedRevision: 1, settings: { ...settings, employee: { ...settings.employee, name: "別人" } }, defaults }), expected(403, "profile_read_only"));
  await assert.rejects(() => f.service.putConfig(OWNER, { expectedRevision: 1, settings: { ...settings, attendanceStartDay: "2026-01-01" }, defaults }), expected(403, "profile_read_only"));
  await assert.rejects(() => f.service.putConfig(OWNER, { expectedRevision: 1, settings: { ...settings, administrator: true }, defaults }), expected(400, "invalid_request"));
});

test("personal default phases and common summary apply to new days while legacy clients preserve selections", async () => {
  const f = fixture({ [DAY]: work({ phases: ["maintenance"] }) });
  const other = initial(); f.store.seed(OTHER, other, { now: NOW });
  let saved = await f.service.putConfig(OWNER, { expectedRevision: 0, settings: f.state.settings,
    defaults: { ...f.state.defaults, note: "共通の作業概要", phases: ["design", "test"] } });
  assert.equal(saved.settings.workSummary, "共通の作業概要");
  assert.deepEqual(saved.defaults.phases, ["design", "test"]);
  assert.deepEqual(f.store.inspect(OWNER).records[DAY].phases, ["maintenance"]);
  assert.deepEqual(f.store.inspect(OTHER).defaults.phases, []);
  const legacyDefaults = { ...saved.defaults }; delete legacyDefaults.phases;
  saved = await f.service.putConfig(OWNER, { expectedRevision: 1,
    settings: { ...saved.settings, workSummary: "旧入力欄から変更" }, defaults: legacyDefaults });
  assert.deepEqual(saved.defaults.phases, ["design", "test"]); assert.equal(saved.defaults.note, "旧入力欄から変更");
  const input = work(); delete input.phases;
  const newDay = await f.service.putDay(OWNER, "2026-10-27", { expectedRevision: 2, record: input });
  assert.deepEqual(newDay.record.phases, ["design", "test"]);
  const oldDay = await f.service.putDay(OWNER, DAY, { expectedRevision: 3, record: input });
  assert.deepEqual(oldDay.record.phases, ["maintenance"]);
  const cleared = await f.service.putConfig(OWNER, { expectedRevision: 4, settings: saved.settings, defaults: { ...saved.defaults, phases: [] } });
  assert.deepEqual(cleared.defaults.phases, []);
});

test("invalid default phases never change configuration or records", async () => {
  const f = fixture();
  for (const phases of [undefined, null, "test", ["unknown"], ["test", "test"], Array(1)]) {
    await assert.rejects(() => f.service.putConfig(OWNER, { expectedRevision: 0, settings: f.state.settings,
      defaults: { ...f.state.defaults, phases } }), expected(422, "invalid_defaults"));
  }
  assert.equal(f.store.inspect(OWNER).revision, 0);
});

test("full-day leave clears clock times with zero work and project hours, while half-day work remains calculated", async () => {
  for (const leave of ["paid", "holiday", "special"]) {
    const f = fixture({ [DAY]: work() });
    const next = work({ leave, allocation: allocation(0) });
    const saved = await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: next });
    assert.equal(saved.record.start, ""); assert.equal(saved.record.end, ""); assert.equal(saved.record.overnight, false); assert.deepEqual(saved.warnings, []);
    assert.equal(C.worked(saved.record, DAY, NOW), 0); assert.equal(saved.absenceMinutes, 0);
    const result = await f.service.createExport(OWNER, { expectedRevision: 1, period: { start: DAY, end: DAY } });
    assert.equal(result.validation.ok, true);
    assert.equal(C.summary(f.calls.writes[0].snapshot.state, { start: DAY, end: DAY }, NOW).days, 0);
    await assert.rejects(() => f.service.putDay(OWNER, DAY, { expectedRevision: 1, record: work({ leave }) }), expected(422, "invalid_record"));
    const half = await f.service.putDay(OWNER, DAY, { expectedRevision: 1, record: work({ leave: "am", end: "14:00", allocation: allocation(4) }) });
    assert.equal(C.worked(half.record, DAY, NOW), 240); assert.equal(half.absenceMinutes, 0);
  }
});

test("checked Excel export repeats short-work, half-leave, blank-note and allocation validation", async () => {
  const records = [
    [work({ end: "14:00", allocation: allocation(4) }), false],
    [work({ end: "14:00", allocation: allocation(4), leave: "am" }), true],
    [work({ note: "　 \n " }), false],
    [work({ allocation: allocation(7) }), false],
    [work({ end: "17:00", allocation: allocation(7) }), true]
  ];
  for (const [record, permitted] of records) {
    const f = fixture({ [DAY]: record });
    const request = { expectedRevision: 0, period: { start: DAY, end: DAY } };
    if (permitted) assert.equal((await f.service.createExport(OWNER, request)).validation.ok, true);
    else {
      await assert.rejects(() => f.service.createExport(OWNER, request), expected(422, "validation_failed"));
      assert.equal(f.calls.writes.length, 0); assert.equal(f.store.inspect(OWNER).exports.length, 0);
    }
  }
  const saturday = "2026-10-24", f = fixture({ [saturday]: work({ end: "10:00", breakMinutes: 0, allocation: allocation(1) }) });
  assert.equal((await f.service.createExport(OWNER, { expectedRevision: 0, period: { start: saturday, end: saturday } })).validation.ok, true);
});

test("review export is explicitly marked and does not masquerade as submission", async () => {
  const f = fixture({ [DAY]: work({ note: "" }) });
  const result = await f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY }, purpose: "review" });
  assert.equal(result.purpose, "review"); assert.equal(result.validation.ok, false);
  assert.equal(Object.hasOwn(result, "submitted"), false); assert.equal(f.store.inspect(OWNER).revision, 0);
  assert.deepEqual(f.store.inspect(OWNER).submissions, {});
  assert.equal(f.calls.writes[0].snapshot.template.version, "v1"); assert.equal(f.calls.writes[0].snapshot.revision, 0);
  assert.equal(f.calls.writes[0].snapshot.rulesVersion, RULES_VERSION);
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY }, purpose: false }), expected(400, "invalid_purpose"));
});

test("missing actual template is an explicit setup error with no artifact or successful export history", async () => {
  const f = fixture({ [DAY]: work() }, { templateProvider: null });
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } }), expected(501, "template_not_configured"));
  assert.equal(f.calls.writes.length, 0); assert.equal(f.store.inspect(OWNER).exports.length, 0);
});

test("render failures do not upload; export revision races remove unreferenced objects", async () => {
  const f = fixture({ [DAY]: work() });
  f.renderer.render = async () => { throw new Error("bad template"); };
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } }), /bad template/);
  assert.equal(f.calls.writes.length, 0); assert.equal(f.store.inspect(OWNER).exports.length, 0);
  f.renderer.render = async () => {
    await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ end: "19:00", allocation: allocation(9) }) });
    return Buffer.from("rendered-before-conflict");
  };
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } }), expected(409, "conflict"));
  assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.removes.length, 1); assert.equal(f.calls.signs.length, 0);
  assert.equal(f.store.inspect(OWNER).exports.length, 0); assert.equal(f.store.inspect(OWNER).revision, 1);
});

test("accepted exports retain immutable source snapshots and owner-scoped downloads", async () => {
  const f = fixture({ [DAY]: work() });
  const result = await f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } });
  assert.equal(result.createdAt, "2026-10-28T11:00:00.000Z"); assert.equal(result.templateVersion, "v1");
  assert.equal(f.calls.writes[0].snapshot.state.records[DAY].allocation.P1, 8);
  assert.deepEqual(f.calls.signs[0].identity, OWNER);
  const otherState = initial(); f.store.seed(OTHER, otherState, { now: NOW });
  await assert.rejects(() => f.service.getExport(OTHER, result.exportId), expected(404, "export_not_found"));
  await f.service.putDay(OWNER, DAY, { expectedRevision: 0, record: work({ note: "出力後の修正" }) });
  assert.equal(f.calls.writes[0].snapshot.state.records[DAY].note, "開発作業");
  assert.equal((await f.service.getExport(OWNER, result.exportId)).revision, 0);
});

test("xlsm export uses an explicitly selected, same-owner saved workbook and snapshots only the current settings", async () => {
  const f = fixture({ [DAY]: work() });
  const map = { version: 2, layout: "set-report", fiscalYear: 2026, closingDay: 31 };
  f.templateProvider.load = async () => ({ id: "attendance", version: "v2", bytes: Buffer.from("blank-template"), mapping: map });
  const prior = { id: "prior", identity: OWNER, period: { start: "2026-09-01", end: "2026-09-30" }, templateId: "attendance", templateVersion: "v2", extension: "xlsm", sha256: "a".repeat(64) };
  await f.store.commitExport(OWNER, { expectedRevision: 0, entry: prior });
  let reads = 0;
  f.exportStorage.read = async entry => { reads++; assert.equal(entry.id, "prior"); return Buffer.from("prior-months-kept"); };
  f.renderer.render = async args => { assert.equal(args.templateBytes.toString(), "prior-months-kept"); assert.equal(args.state.settings.projects[0].name, "対象月の新PJ"); return Buffer.from("new-month"); };
  const settings = plain(f.state.settings); settings.projects[0].name = "対象月の新PJ";
  await f.service.putConfig(OWNER, { expectedRevision: 0, settings, defaults: plain(f.state.defaults) });
  const request = { expectedRevision: 1, period: { start: "2026-10-01", end: "2026-10-31" }, purpose: "review", baseExportId: "prior" };
  await f.service.createExport(OWNER, request);
  assert.equal(reads, 1); assert.deepEqual(f.calls.writes[0].snapshot.base, { exportId: "prior", sha256: "a".repeat(64) });
  assert.equal(f.calls.writes[0].format.fileName, "作業報告書(2026年10月)_利用者.xlsm");
  assert.deepEqual(await f.store.getExport(OWNER, "prior"), prior);
  await assert.rejects(f.service.createExport(OWNER, { ...request, baseExportId: "other-person" }), expected(404, "export_not_found"));
  assert.equal(reads, 1);
  await f.store.commitExport(OWNER, { expectedRevision: 1, entry: { ...prior, id: "old-template", templateVersion: "v1" } });
  await assert.rejects(f.service.createExport(OWNER, { ...request, baseExportId: "old-template" }), expected(422, "base_export_mismatch"));
  await assert.rejects(f.service.createExport(OWNER, { ...request, baseExportId: "../bad" }), expected(400, "invalid_export_id"));
  assert.equal(reads, 1);
});

test("a signing failure after export acceptance leaves the artifact available for retry", async () => {
  const f = fixture({ [DAY]: work() });
  f.exportStorage.sign = async () => { throw new Error("temporary signer failure"); };
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } }), error =>
    expected(503, "download_unavailable")(error) && error.details.exportId === "export-1");
  assert.equal(f.store.inspect(OWNER).exports.length, 1); assert.equal(f.calls.removes.length, 0);
  await assert.rejects(() => f.service.getExport(OWNER, "export-1"), error =>
    expected(503, "download_unavailable")(error) && error.details.exportId === "export-1");
  f.exportStorage.sign = async entry => ({ url: "https://download.example/" + entry.id, expiresAt: "later" });
  assert.equal((await f.service.getExport(OWNER, "export-1")).download.url, "https://download.example/export-1");
});

test("an ambiguous transaction timeout does not delete an artifact that may already be committed", async () => {
  const f = fixture({ [DAY]: work() }), original = f.store.commitExport;
  f.store.commitExport = async (...args) => { await original(...args); throw new Error("response timeout after commit"); };
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: DAY, end: DAY } }), error =>
    expected(503, "export_status_unknown")(error) && error.details.exportId === "export-1");
  assert.equal(f.store.inspect(OWNER).exports.length, 1); assert.equal(f.calls.removes.length, 0);
  assert.equal((await f.service.getExport(OWNER, "export-1")).download.url, "https://download.example/export-1");
});

test("unpublished holiday calendars block checked exports instead of inventing missing-day rules", async () => {
  const future = { day: unknownDay, minutes: 1200, full: "20:00:00" }, day = future.day;
  const f = fixture({ [day]: work() }, { clock: () => future });
  await assert.rejects(() => f.service.createExport(OWNER, { expectedRevision: 0, period: { start: day, end: day } }), expected(422, "validation_failed"));
  const reviewed = await f.service.createExport(OWNER, { expectedRevision: 0, period: { start: day, end: day }, purpose: "review" });
  assert.equal(reviewed.validation.ok, false); assert.match(JSON.stringify(reviewed.validation.errors), /祝日データ/);
});

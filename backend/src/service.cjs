"use strict";

const { randomUUID } = require("node:crypto");
const { C, RULES_VERSION } = require("./core.cjs");
const { ApiError } = require("./errors.cjs");
const { exportFormat } = require("./export-format.cjs");

const RECORD_FIELDS = ["start", "end", "overnight", "breakMinutes", "locationId", "note", "phases", "leave", "sourceDay", "allocation"];
const SETTINGS_FIELDS = ["attendanceStartDay", "employee", "minHours", "maxHours", "plannedHours", "plannedHoursByMonth", "workSummary", "projects", "places"];
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };

function object(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail(400, "invalid_request", "リクエストの項目を確認してください。");
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, "invalid_revision", "更新番号を指定してください。");
}

function periodValue(period) {
  object(period, ["start", "end"]);
  if (!C.validDay(period.start) || !C.validDay(period.end) || period.end === "9999-12-31" || period.start > period.end ||
      (+C.date(period.end) - +C.date(period.start)) / 86400000 >= 366) {
    fail(400, "invalid_period", "対象期間は正しい日付で366日以内を指定してください。");
  }
  return { start: period.start, end: period.end };
}

function ownedIdentity(identity) {
  if (!identity || typeof identity.tenantId !== "string" || !identity.tenantId ||
      typeof identity.employeeId !== "string" || !identity.employeeId) {
    fail(401, "unauthorized", "認証情報を確認してください。");
  }
}

function validateInputRecord(record) {
  object(record, RECORD_FIELDS, RECORD_FIELDS.filter(key => !["sourceDay", "phases"].includes(key)));
  object(record.allocation, [...C.PROJECTS]);
}

function contextState(context) {
  return { version: C.VERSION, revision: context.revision, mode: "local",
    defaults: context.defaults, settings: context.settings, records: context.records, submissions: {} };
}

function linkChanges(previous, next, day) {
  const before = previous?.leave === "comp" ? previous.sourceDay : null;
  const after = next?.leave === "comp" ? next.sourceDay : null;
  if (before === after) return [];
  return [
    ...(before ? [{ sourceDay: before, previousDay: day, nextDay: null }] : []),
    ...(after ? [{ sourceDay: after, previousDay: null, nextDay: day }] : [])
  ];
}

function createAttendanceService({ store, templateProvider, renderer, exportStorage,
  clock = () => C.clock(), ids = randomUUID } = {}) {
  if (!store || typeof store.readContext !== "function" || typeof store.commit !== "function") throw new TypeError("An attendance store is required");

  const serverNow = () => {
    const value = clock();
    const now = value instanceof Date ? C.clock(value) : value;
    if (!now || !C.validDay(now.day) || !Number.isInteger(now.minutes) || now.minutes < 0 || now.minutes > 1439) {
      fail(503, "clock_unavailable", "現在時刻を確認できません。");
    }
    return now;
  };

  async function read(identity, range, referenceDays = []) {
    ownedIdentity(identity);
    const context = await store.readContext(identity, { ...range, referenceDays });
    if (!context) fail(404, "profile_not_provisioned", "社員の利用設定が登録されていません。");
    if (!Number.isSafeInteger(context.revision) || context.revision < 0 || C.validateSettings(context.settings) ||
        !context.defaults || !context.records || Array.isArray(context.records)) {
      fail(503, "invalid_stored_data", "保存データを確認できません。管理者に連絡してください。");
    }
    const hydrated = C.hydrate(contextState(context), serverNow());
    if (!hydrated) fail(503, "invalid_stored_data", "保存データを確認できません。管理者に連絡してください。");
    return { ...context, records: hydrated.records };
  }

  const currentRevision = (context, expected) => {
    if (context.revision !== expected) fail(409, "conflict", "別の操作で記録が更新されています。再取得してください。");
  };

  async function persistDay(identity, day, expectedRevision, context, input, now, { strictAllocation }) {
    const previous = context.records[day], next = { ...input, allocation: { ...input.allocation } };
    // Older clients do not know this optional field. Only an explicit [] clears a selection.
    if (!Object.hasOwn(input, "phases")) next.phases = copy(previous ? previous.phases || [] : context.defaults.phases || []);
    // Historical import metadata is owned by the server, never supplied by the caller.
    if (previous && C.allocationMax(previous, "SET") > 24 && next.allocation.SET === previous.allocation.SET) {
      next.legacyProjectAllocation = copy(previous.legacyProjectAllocation);
    } else delete next.legacyProjectAllocation;
    const checked = C.validateRecord(next, day, now, context.settings, { strictAllocation });
    if (!checked.ok) fail(422, "invalid_record", checked.error, { day });
    if (checked.value.leave !== "comp") checked.value.sourceDay = "";
    const relation = C.validateRecordChange(contextState(context), day, checked.value, now);
    if (!relation.ok) fail(422, "invalid_comp_link", relation.error, { day });
    const nextRevision = await store.commit(identity, { expectedRevision,
      recordChanges: [{ day, record: checked.value }], linkChanges: linkChanges(previous, checked.value, day) });
    return { revision: nextRevision, day, record: copy(checked.value), warnings: [...checked.warnings],
      absenceMinutes: C.absenceMinutes(checked.value, day, now) };
  }

  async function readDays(identity, request) {
    const range = periodValue(request), now = serverNow(), context = await read(identity, range);
    const state = contextState(context);
    return { revision: context.revision, period: range, settings: copy(context.settings), defaults: copy(context.defaults),
      records: copy(Object.fromEntries(Object.entries(context.records).filter(([day]) => day >= range.start && day <= range.end))),
      summary: copy(C.summary(state, range, now)), missing: copy(C.missing(state, range, now)),
      calendarKnown: C.holidayKnown(range.start) && C.holidayKnown(range.end) };
  }

  async function putDay(identity, day, request) {
    object(request, ["expectedRevision", "record"]); revision(request.expectedRevision);
    if (!C.validDay(day)) fail(400, "invalid_day", "正しい日付を指定してください。");
    validateInputRecord(request.record);
    const now = serverNow(), input = request.record;
    const references = typeof input.sourceDay === "string" && C.validDay(input.sourceDay) ? [input.sourceDay] : [];
    const context = await read(identity, { start: day, end: day }, references);
    currentRevision(context, request.expectedRevision);
    return persistDay(identity, day, request.expectedRevision, context, input, now, { strictAllocation: true });
  }

  async function updateDayTime(identity, day, request) {
    object(request, ["expectedRevision", "changes"]); revision(request.expectedRevision);
    object(request.changes, ["start", "end", "overnight", "breakMinutes"], []);
    if (!Object.keys(request.changes).length) fail(400, "invalid_request", "変更する時刻または休憩を指定してください。");
    if (!C.validDay(day)) fail(400, "invalid_day", "正しい日付を指定してください。");
    const now = serverNow(), context = await read(identity, { start: day, end: day });
    currentRevision(context, request.expectedRevision);
    const candidate = { ...(context.records[day] || C.empty(contextState(context))), ...request.changes };
    const checked = C.validateRecord(candidate, day, now, context.settings);
    if (!checked.ok) fail(422, "invalid_record", checked.error, { day });
    const next = C.allocateToP1(checked.value, day, now);
    // The narrow time route preserves manual P2–SET and reports a mismatch rather than erasing it.
    return persistDay(identity, day, request.expectedRevision, context, next, now, { strictAllocation: false });
  }

  async function deleteDay(identity, day, request) {
    object(request, ["expectedRevision"]); revision(request.expectedRevision);
    if (!C.validDay(day)) fail(400, "invalid_day", "正しい日付を指定してください。");
    const now = serverNow(), context = await read(identity, { start: day, end: day });
    currentRevision(context, request.expectedRevision);
    const relation = C.validateRecordChange(contextState(context), day, null, now);
    if (!relation.ok) fail(422, "invalid_comp_link", relation.error, { day });
    const nextRevision = await store.commit(identity, { expectedRevision: request.expectedRevision,
      recordChanges: [{ day, record: null }], linkChanges: linkChanges(context.records[day], null, day) });
    return { revision: nextRevision, day };
  }

  async function putConfig(identity, request) {
    object(request, ["expectedRevision", "settings", "defaults"]); revision(request.expectedRevision);
    object(request.settings, SETTINGS_FIELDS);
    if (!Array.isArray(request.settings.projects) || !Array.isArray(request.settings.places)) fail(422, "invalid_settings", "プロジェクトと勤務場所を確認してください。");
    for (const project of request.settings.projects) object(project, ["id", "name", "description"]);
    for (const place of request.settings.places) object(place, ["id", "code", "name", "address"]);
    const now = serverNow(), context = await read(identity, { start: now.day, end: now.day });
    currentRevision(context, request.expectedRevision);
    const sameEmployee = request.settings?.employee &&
      Object.keys(request.settings.employee).length === Object.keys(context.settings.employee).length &&
      Object.keys(context.settings.employee).every(key => Object.hasOwn(request.settings.employee, key) &&
        request.settings.employee[key] === context.settings.employee[key]);
    if (!request.settings || !sameEmployee ||
        request.settings.attendanceStartDay !== context.settings.attendanceStartDay) {
      fail(403, "profile_read_only", "社員情報と利用開始日は管理者が設定します。");
    }
    const error = C.validateSettings(request.settings);
    if (error) fail(422, "invalid_settings", error);
    object(request.defaults, ["locationId", "note", "breakMinutes", "phases"], ["locationId", "note", "breakMinutes"]);
    const defaults = copy(request.defaults), settings = copy(request.settings);
    if (Object.hasOwn(request.defaults, "phases") && !C.validPhases(request.defaults.phases)) {
      fail(422, "invalid_defaults", "初期フェーズを表示されている項目から重複せず選んでください。");
    }
    if (!Object.hasOwn(request.defaults, "phases")) defaults.phases = copy(context.defaults.phases || []);
    if (!request.settings.places.some(place => place.id === defaults.locationId) ||
        typeof defaults.note !== "string" || defaults.note.length > 1000 ||
        !Number.isInteger(defaults.breakMinutes) || defaults.breakMinutes < 0 || defaults.breakMinutes > 1440) {
      fail(422, "invalid_defaults", "新しい日の初期値を確認してください。");
    }
    // The common summary is the new-day memo default. Prefer an explicitly edited memo;
    // older clients can still edit the former summary field without losing that behavior.
    if (defaults.note !== context.defaults.note) settings.workSummary = defaults.note;
    else if (settings.workSummary !== context.settings.workSummary) defaults.note = settings.workSummary;
    const nextRevision = await store.commit(identity, { expectedRevision: request.expectedRevision,
      settings, defaults, recordChanges: [], linkChanges: [] });
    return { revision: nextRevision, settings: copy(settings), defaults: copy(defaults) };
  }

  function validation(state, period, now) {
    const checked = copy(C.submissionCheck(state, period, now));
    const start = period.start < C.firstDay(state) ? C.firstDay(state) : period.start;
    const end = period.end > now.day ? now.day : period.end;
    if (start <= end && C.dates(start, end).some(day => C.workday(day) === null)) {
      checked.errors.push({ day: "", messages: ["対象期間の祝日データが未登録です。管理者に確認してください。"] });
      checked.ok = false;
    }
    return checked;
  }

  async function createExport(identity, request) {
    object(request, ["expectedRevision", "period", "purpose", "baseExportId"], ["expectedRevision", "period"]);
    revision(request.expectedRevision);
    if (Object.hasOwn(request, "baseExportId") && (typeof request.baseExportId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.baseExportId))) fail(400, "invalid_export_id", "引き継ぐ出力番号を確認してください。");
    const period = periodValue(request.period), purpose = request.purpose === undefined ? "checked" : request.purpose;
    if (!["checked", "review"].includes(purpose)) fail(400, "invalid_purpose", "Excel出力の目的を確認してください。");
    const now = serverNow(), context = await read(identity, period);
    currentRevision(context, request.expectedRevision);
    const state = contextState(context), checked = validation(state, period, now);
    if (purpose === "checked" && !checked.ok) fail(422, "validation_failed", "勤務表の入力を確認してください。", { errors: checked.errors });
    if (!templateProvider || typeof templateProvider.load !== "function" || !renderer || typeof renderer.render !== "function" ||
        !exportStorage || typeof exportStorage.write !== "function" || typeof exportStorage.sign !== "function") {
      fail(501, "template_not_configured", "Excelテンプレートの設定が必要です。");
    }
    const template = await templateProvider.load();
    if (!template || !template.id || !template.version || !template.bytes || !template.mapping) {
      fail(501, "template_not_configured", "Excelテンプレートの設定が必要です。");
    }
    let templateBytes = template.bytes, base = null;
    if (request.baseExportId) {
      if (template.mapping.version !== 2 || template.mapping.layout !== "set-report" || typeof exportStorage.read !== "function") fail(422, "base_export_unsupported", "このテンプレートでは過去の帳票を引き継げません。");
      const entry = await store.getExport(identity, request.baseExportId);
      if (!entry || entry.identity?.tenantId !== identity.tenantId || entry.identity?.employeeId !== identity.employeeId) fail(404, "export_not_found", "引き継ぐ帳票が見つかりません。");
      if (entry.templateId !== template.id || entry.templateVersion !== template.version || entry.extension !== "xlsm") fail(422, "base_export_mismatch", "同じ版のテンプレートから作成した本人の帳票を指定してください。");
      const { reportPeriod } = require("./set-report.cjs");
      reportPeriod(template.mapping, entry.period); reportPeriod(template.mapping, period);
      templateBytes = await exportStorage.read(entry);
      base = { exportId: entry.id, sha256: entry.sha256 };
    }
    const id = ids();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail(503, "export_id_unavailable", "Excelの出力番号を作成できません。");
    const instant = new Date(now.day + "T" + (now.full || C.time(now.minutes) + ":00") + "+09:00").toISOString();
    const format = exportFormat(template.mapping, C.employee(state), period);
    const snapshot = copy({ schemaVersion: 1, rulesVersion: RULES_VERSION || String(C.VERSION), identity, revision: context.revision,
      createdAt: instant, period, purpose, validation: checked,
      template: { id: template.id, version: template.version }, format, base, state });
    const bytes = await renderer.render({ templateBytes, mapping: template.mapping, state: copy(state), period, now });
    let stored, accepted = false;
    try {
      stored = await exportStorage.write({ identity, id, bytes, snapshot, format });
      const entry = { id, identity: copy(identity), revision: context.revision, createdAt: instant, period, purpose,
        templateId: template.id, templateVersion: template.version, validation: checked, ...stored };
      await store.commitExport(identity, { expectedRevision: request.expectedRevision, entry });
      accepted = true;
      const download = await exportStorage.sign(entry);
      return { exportId: id, revision: context.revision, createdAt: instant, period, purpose,
        templateVersion: template.version, validation: checked, download };
    } catch (error) {
      if (accepted) {
        fail(503, "download_unavailable", "Excelは保存しましたが、取得URLを発行できませんでした。再度取得してください。", { exportId: id });
      }
      // A network timeout can hide an accepted DynamoDB transaction. Never delete its
      // objects unless the store reports a definite revision/uniqueness conflict.
      if (stored && error?.status !== 409) {
        fail(503, "export_status_unknown", "Excel出力の保存結果を確認できません。出力番号で再確認してください。", { exportId: id });
      }
      if (stored && typeof exportStorage.remove === "function") {
        try { await exportStorage.remove(stored); } catch { /* Unreferenced private objects are never returned to callers. */ }
      }
      throw error;
    }
  }

  async function getExport(identity, id) {
    ownedIdentity(identity);
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail(400, "invalid_export_id", "Excelの出力番号を確認してください。");
    const entry = await store.getExport(identity, id);
    if (!entry) fail(404, "export_not_found", "Excel出力が見つかりません。");
    if (!exportStorage || typeof exportStorage.sign !== "function") fail(503, "export_storage_unavailable", "Excelを取得できません。");
    let download;
    try { download = await exportStorage.sign(entry); }
    catch { fail(503, "download_unavailable", "Excelの取得URLを発行できませんでした。再度取得してください。", { exportId: entry.id }); }
    return { exportId: entry.id, revision: entry.revision, createdAt: entry.createdAt,
      period: entry.period, purpose: entry.purpose, templateVersion: entry.templateVersion,
      validation: entry.validation, download };
  }

  return { readDays, putDay, updateDayTime, deleteDay, putConfig, createExport, getExport };
}

module.exports = { createAttendanceService };

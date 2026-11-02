"use strict";

const { createHash } = require("node:crypto");
const { ApiError } = require("./errors.cjs");
const { checkedFormat, disposition } = require("./export-format.cjs");

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const unavailable = () => new ApiError(503, "storage_unavailable", "Excelファイルを保存できません。時間をおいて再度お試しください。");
const templateMissing = () => new ApiError(501, "template_not_configured", "Excelテンプレートの設定が必要です。");
const templateInvalid = () => new ApiError(503, "invalid_template", "Excelテンプレートとセル設定を確認してください。");

function exportKeys(identity, id, extension = "xlsx") {
  if (!identity || !SAFE_ID.test(identity.tenantId || "") || !SAFE_ID.test(identity.employeeId || "") || !SAFE_ID.test(id || "")) {
    throw new ApiError(400, "invalid_export", "Excelの出力番号を確認してください。");
  }
  const prefix = "outputs/" + identity.tenantId + "/" + identity.employeeId + "/" + id;
  if (!["xlsx", "xlsm"].includes(extension)) throw new ApiError(400, "invalid_export", "出力形式を確認してください。");
  return { key: prefix + "." + extension, snapshotKey: prefix + ".snapshot.json" };
}

function createS3ExportStorage({ client, bucket, commands, signer, now = () => new Date(), expiresIn = 300,
  maxWorkbookBytes = 10 * 1024 * 1024, maxSnapshotBytes = 10 * 1024 * 1024 } = {}) {
  if (!client || typeof client.send !== "function" || typeof bucket !== "string" || !bucket) throw new TypeError("S3 client and bucket are required");
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 900) throw new TypeError("Download expiry must be between 1 and 900 seconds");
  const constructors = () => commands || require("@aws-sdk/client-s3");
  const command = (operation, input) => new (constructors()[operation + "Command"])(input);
  const send = (operation, input) => client.send(command(operation, input));
  const ownedResults = new WeakSet();

  async function write({ identity, id, bytes, snapshot, format }) {
    const file = checkedFormat(format);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError("Rendered Excel bytes are required");
    const workbook = Buffer.from(bytes), audit = Buffer.from(JSON.stringify(snapshot), "utf8");
    const keys = Object.freeze({ ...exportKeys(identity, id, file.extension), ...(format ? { ...file, sha256: createHash("sha256").update(workbook).digest("hex") } : {}) });
    if (!workbook.length || workbook.length > maxWorkbookBytes || audit.length > maxSnapshotBytes) throw new ApiError(413, "export_too_large", "Excelファイルの容量が大きすぎます。");
    let workbookWritten = false;
    try {
      await send("PutObject", { Bucket: bucket, Key: keys.key, Body: workbook, ContentType: file.contentType,
        ContentDisposition: disposition(file), CacheControl: "private, no-store", IfNoneMatch: "*" });
      workbookWritten = true;
      await send("PutObject", { Bucket: bucket, Key: keys.snapshotKey, Body: audit,
        ContentType: "application/json; charset=utf-8", CacheControl: "private, no-store", IfNoneMatch: "*" });
      ownedResults.add(keys);
      return keys;
    } catch (error) {
      // Only remove objects whose successful creation this invocation observed. A timeout or a
      // precondition failure may refer to an existing object and must never delete that object.
      if (workbookWritten) {
        try { await send("DeleteObject", { Bucket: bucket, Key: keys.key }); }
        catch { /* A remaining private, unreferenced artifact needs administrative reconciliation. */ }
      }
      if (error?.name === "PreconditionFailed" || error?.$metadata?.httpStatusCode === 412) {
        throw new ApiError(409, "export_exists", "同じ出力番号が使用済みです。もう一度出力してください。");
      }
      throw unavailable();
    }
  }

  async function remove(result) {
    const { key, snapshotKey } = result || {};
    // This is a cleanup port for write()'s own results, not an arbitrary object deletion API.
    if (!result || !ownedResults.has(result) || typeof key !== "string" || typeof snapshotKey !== "string" ||
        !/\.xls[xm]$/.test(key) || snapshotKey !== key.slice(0, -5) + ".snapshot.json") {
      throw new ApiError(400, "invalid_export", "削除するExcelファイルを確認してください。");
    }
    const results = await Promise.allSettled([key, snapshotKey].map(Key => send("DeleteObject", { Bucket: bucket, Key })));
    if (results.some(result => result.status === "rejected")) throw unavailable();
    ownedResults.delete(result);
  }

  async function sign(entry) {
    const file = checkedFormat(entry?.extension ? entry : undefined);
    const expected = exportKeys(entry?.identity, entry?.id, file.extension);
    if (entry.key !== expected.key || entry.snapshotKey !== expected.snapshotKey) throw new ApiError(503, "invalid_export", "出力ファイルの保存情報を確認してください。");
    const instant = now();
    if (!(instant instanceof Date) || !Number.isFinite(+instant)) throw unavailable();
    const request = command("GetObject", { Bucket: bucket, Key: expected.key,
      ResponseContentType: file.contentType, ResponseContentDisposition: disposition(file), ResponseCacheControl: "private, no-store" });
    const signRequest = signer || (({ client: s3, command: input, expiresIn: seconds }) =>
      require("@aws-sdk/s3-request-presigner").getSignedUrl(s3, input, { expiresIn: seconds }));
    const url = await signRequest({ client, command: request, expiresIn });
    if (typeof url !== "string" || !url.startsWith("https://")) throw unavailable();
    return { url, expiresAt: new Date(+instant + expiresIn * 1000).toISOString() };
  }

  async function read(entry) {
    const file = checkedFormat(entry?.extension ? entry : undefined), expected = exportKeys(entry?.identity, entry?.id, file.extension);
    if (entry.key !== expected.key || entry.snapshotKey !== expected.snapshotKey || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new ApiError(503, "invalid_export", "引き継ぐ帳票の保存情報を確認してください。");
    const result = await send("GetObject", { Bucket: bucket, Key: expected.key });
    if (result.ContentLength > maxWorkbookBytes) { result.Body?.destroy?.(); throw unavailable(); }
    const bytes = await bodyBytes(result.Body, maxWorkbookBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new ApiError(503, "invalid_export", "引き継ぐ帳票の内容が保存時と一致しません。");
    return bytes;
  }
  return { write, remove, sign, read };
}

async function bodyBytes(body, limit) {
  if (!body) throw templateInvalid();
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === "string") {
    const bytes = Buffer.from(body);
    if (bytes.length > limit) throw templateInvalid();
    return bytes;
  }
  if (body[Symbol.asyncIterator]) {
    const parts = []; let size = 0;
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > limit) { body.destroy?.(); throw templateInvalid(); }
      parts.push(bytes);
    }
    return Buffer.concat(parts);
  }
  if (typeof body.transformToByteArray === "function") return bodyBytes(await body.transformToByteArray(), limit);
  throw templateInvalid();
}

/** The hash in the mapping envelope binds its cell map to the exact template bytes. */
function createS3TemplateProvider({ client, bucket, key, mappingKey, commands,
  maxTemplateBytes = 10 * 1024 * 1024, maxMappingBytes = 1024 * 1024 } = {}) {
  const configured = Boolean(client && typeof client.send === "function" && bucket && key && mappingKey);
  const constructors = () => commands || require("@aws-sdk/client-s3");
  async function read(Key, limit) {
    try {
      const result = await client.send(new (constructors().GetObjectCommand)({ Bucket: bucket, Key }));
      if (result.ContentLength > limit) { result.Body?.destroy?.(); throw templateInvalid(); }
      return bodyBytes(result.Body, limit);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) throw templateMissing();
      throw new ApiError(503, "template_unavailable", "Excelテンプレートを取得できません。時間をおいて再度お試しください。");
    }
  }
  async function load() {
    if (!configured) throw templateMissing();
    const [bytes, mappingBytes] = await Promise.all([read(key, maxTemplateBytes), read(mappingKey, maxMappingBytes)]);
    let envelope;
    try { envelope = JSON.parse(mappingBytes.toString("utf8")); } catch { throw templateInvalid(); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        !SAFE_ID.test(envelope.id || "") || !SAFE_ID.test(envelope.version || "") ||
        !/^[a-f0-9]{64}$/.test(envelope.templateSha256 || "") ||
        !envelope.mapping || typeof envelope.mapping !== "object" || Array.isArray(envelope.mapping) ||
        createHash("sha256").update(bytes).digest("hex") !== envelope.templateSha256) throw templateInvalid();
    return { id: envelope.id, version: envelope.version, bytes, mapping: envelope.mapping };
  }
  return { load };
}

module.exports = { createS3ExportStorage, createS3TemplateProvider };

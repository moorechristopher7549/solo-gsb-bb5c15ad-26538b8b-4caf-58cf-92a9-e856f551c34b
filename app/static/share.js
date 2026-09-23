"use strict";

// ---------------------------------------------------------------------------
// 场景分享：带版本号的 UTF-8 Base64URL 状态编解码
//
// 分享链接形如：https://host/#v1=<Base64URL>
// 状态完全放在 URL 片段（fragment）中，浏览器不会把片段发送给服务端。
// 本文件不依赖 DOM，UMD 风格导出，浏览器与 Node 均可使用（见 tests/share_test.mjs）。
// ---------------------------------------------------------------------------

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ShareCodec = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const VERSION = 1;
  const HASH_PREFIX = `v${VERSION}:`;
  // 仅识别 vN: 前缀的片段，其它锚点（如 #section）原样忽略
  const HASH_RE = /^#(v[0-9]+):([\s\S]*)$/;

  // 与后端 DebugRequest 保持一致的约束
  const MIN_STEPS = 1;
  const MAX_STEPS = 500;
  const MAX_RULES_LEN = 100_000;
  const MAX_PATH_LEN = 2_000;

  // -------------------------------------------------------------------------
  // Base64URL（UTF-8）
  // -------------------------------------------------------------------------

  function bytesToBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlToBytes(encoded) {
    if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
      throw new Error("包含非 Base64URL 字符");
    }
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    let bin;
    try {
      bin = atob(b64 + pad);
    } catch (e) {
      throw new Error("Base64URL 解码失败");
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function encodePayload(payload) {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    return bytesToBase64Url(bytes);
  }

  function decodePayload(encoded) {
    const bytes = base64UrlToBytes(encoded);
    let json;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      throw new Error("载荷不是合法的 UTF-8 文本");
    }
    let data;
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw new Error("载荷不是合法的 JSON");
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // 字段校验：任何不合法都抛出 Error，调用方负责保留默认界面
  // -------------------------------------------------------------------------

  const KNOWN_KEYS = ["rules", "path", "max_steps", "follow_redirects"];

  function validateState(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("状态必须是 JSON 对象");
    }
    const keys = Object.keys(data);
    for (const key of KNOWN_KEYS) {
      if (!keys.includes(key)) throw new Error(`缺少字段：${key}`);
    }
    for (const key of keys) {
      if (!KNOWN_KEYS.includes(key)) throw new Error(`存在非法字段：${key}`);
    }

    const { rules, path, max_steps: maxSteps, follow_redirects: follow } = data;

    if (typeof rules !== "string") throw new Error("字段 rules 必须是字符串");
    if (rules.length > MAX_RULES_LEN) throw new Error("规则文本超出长度限制");

    if (typeof path !== "string") throw new Error("字段 path 必须是字符串");
    if (!path.startsWith("/")) throw new Error("字段 path 必须以 / 开头");
    if (path.length > MAX_PATH_LEN) throw new Error("请求路径超出长度限制");
    if (/[\s]/.test(path)) throw new Error("字段 path 不能包含空白字符");

    if (
      typeof maxSteps !== "number" ||
      !Number.isInteger(maxSteps) ||
      maxSteps < MIN_STEPS ||
      maxSteps > MAX_STEPS
    ) {
      throw new Error(`字段 max_steps 必须是 ${MIN_STEPS}–${MAX_STEPS} 之间的整数`);
    }

    if (typeof follow !== "boolean") {
      throw new Error("字段 follow_redirects 必须是布尔值");
    }

    return { rules, path, max_steps: maxSteps, follow_redirects: follow };
  }

  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------

  /** 把编辑状态编码为 #v1:<payload> 形式的片段（含开头 #）。 */
  function encodeStateHash(state) {
    const clean = validateState(state);
    return "#" + HASH_PREFIX + encodePayload(clean);
  }

  /**
   * 解析 location.hash：
   *  - { kind: "ok", state }       识别成功且校验通过
   *  - { kind: "ignored" }         非本功能的片段（空锚点或其它用途），保持静默
   *  - { kind: "unknownVersion" }  版本号不支持（例如 v2）
   *  - { kind: "corrupt", reason } 数据损坏 / 字段非法，界面应可见提示并保留默认
   */
  function decodeLocationHash(hash) {
    if (typeof hash !== "string" || hash === "" || hash === "#") {
      return { kind: "ignored" };
    }
    const m = HASH_RE.exec(hash);
    if (!m) return { kind: "ignored" };

    const versionToken = m[1];
    const payload = m[2];
    if (versionToken !== `v${VERSION}`) {
      return { kind: "unknownVersion", version: versionToken.slice(1) };
    }
    if (!payload) return { kind: "corrupt", reason: "分享载荷为空" };

    try {
      return { kind: "ok", state: validateState(decodePayload(payload)) };
    } catch (e) {
      return { kind: "corrupt", reason: e.message || "分享数据无法解析" };
    }
  }

  return {
    VERSION,
    HASH_PREFIX,
    encodeStateHash,
    decodeLocationHash,
    // 导出内部函数便于测试
    _validateState: validateState,
    _encodePayload: encodePayload,
    _decodePayload: decodePayload,
  };
});

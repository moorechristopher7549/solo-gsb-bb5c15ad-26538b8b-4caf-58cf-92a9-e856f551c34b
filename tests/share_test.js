// share.js 编解码的纯逻辑测试（Node 内置 test runner，无需第三方依赖）。
// 运行：node --test tests/

const test = require("node:test");
const assert = require("node:assert/strict");
const ShareCodec = require("../app/static/share.js");

const SAMPLE = {
  rules: "# 注释\nREWRITE ^/old/(.*)$ /new/$1 next\nREDIRECT ^/home$ / 301\n",
  path: "/old/42?q=1",
  max_steps: 100,
  follow_redirects: true,
};

test("状态往返：encode -> decode 完全一致（含 UTF-8 中文与查询串）", () => {
  const hash = ShareCodec.encodeStateHash(SAMPLE);
  assert.match(hash, /^#v1:[A-Za-z0-9_-]+$/);
  const result = ShareCodec.decodeLocationHash(hash);
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.state, SAMPLE);
});

test("片段中不含 +、/、= 等标准 Base64 字符", () => {
  const hash = ShareCodec.encodeStateHash(SAMPLE);
  assert.ok(!hash.slice(4).includes("+"));
  assert.ok(!hash.slice(4).includes("/"));
  assert.ok(!hash.slice(4).includes("="));
});

test("空锚点与非 vN 片段被静默忽略", () => {
  assert.equal(ShareCodec.decodeLocationHash("").kind, "ignored");
  assert.equal(ShareCodec.decodeLocationHash("#").kind, "ignored");
  assert.equal(ShareCodec.decodeLocationHash("#section-anchor").kind, "ignored");
  assert.equal(ShareCodec.decodeLocationHash("#/spa/route/x").kind, "ignored");
});

test("未知版本返回 unknownVersion 且不解析载荷", () => {
  const result = ShareCodec.decodeLocationHash("#v2:AAAA");
  assert.equal(result.kind, "unknownVersion");
  assert.equal(result.version, "2");
});

test("损坏的 Base64URL -> corrupt", () => {
  const result = ShareCodec.decodeLocationHash("#v1:@@@not-base64@@@");
  assert.equal(result.kind, "corrupt");
  assert.ok(result.reason);
});

test("Base64 正确但 JSON 损坏 -> corrupt", () => {
  const encoded = Buffer.from("{not json", "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const result = ShareCodec.decodeLocationHash(`#v1:${encoded}`);
  assert.equal(result.kind, "corrupt");
  assert.match(result.reason, /JSON/);
});

test("非法 UTF-8 字节 -> corrupt", () => {
  const encoded = Buffer.from([0xff, 0xfe, 0x00, 0x61])
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const result = ShareCodec.decodeLocationHash(`#v1:${encoded}`);
  assert.equal(result.kind, "corrupt");
});

test("载荷为空 -> corrupt", () => {
  assert.equal(ShareCodec.decodeLocationHash("#v1:").kind, "corrupt");
});

test("非对象 JSON -> corrupt", () => {
  const encoded = ShareCodec._encodePayload([1, 2, 3]);
  assert.equal(
    ShareCodec.decodeLocationHash(`#v1:${encoded}`).kind,
    "corrupt"
  );
});

test("缺少字段 -> corrupt", () => {
  const { rules, ...partial } = SAMPLE;
  const encoded = ShareCodec._encodePayload(partial);
  const result = ShareCodec.decodeLocationHash(`#v1:${encoded}`);
  assert.equal(result.kind, "corrupt");
  assert.match(result.reason, /rules/);
});

test("非法（多余）字段 -> corrupt", () => {
  const encoded = ShareCodec._encodePayload({ ...SAMPLE, injected: 1 });
  const result = ShareCodec.decodeLocationHash(`#v1:${encoded}`);
  assert.equal(result.kind, "corrupt");
  assert.match(result.reason, /非法字段/);
});

test("字段类型错误 -> corrupt", () => {
  const cases = [
    { ...SAMPLE, rules: 42 },
    { ...SAMPLE, path: null },
    { ...SAMPLE, max_steps: "100" },
    { ...SAMPLE, follow_redirects: "true" },
  ];
  for (const payload of cases) {
    const encoded = ShareCodec._encodePayload(payload);
    assert.equal(
      ShareCodec.decodeLocationHash(`#v1:${encoded}`).kind,
      "corrupt"
    );
  }
});

test("路径不以 / 开头 / 含空白 -> corrupt", () => {
  for (const badPath of ["users/42", "/path with-space", "/tab\there"]) {
    const encoded = ShareCodec._encodePayload({ ...SAMPLE, path: badPath });
    assert.equal(
      ShareCodec.decodeLocationHash(`#v1:${encoded}`).kind,
      "corrupt",
      badPath
    );
  }
});

test("步数越界或非整数 -> corrupt", () => {
  for (const badSteps of [0, -1, 501, 1000, 1.5, NaN, Infinity]) {
    const encoded = ShareCodec._encodePayload({ ...SAMPLE, max_steps: badSteps });
    assert.equal(
      ShareCodec.decodeLocationHash(`#v1:${encoded}`).kind,
      "corrupt",
      String(badSteps)
    );
  }
});

test("边界步数 1 与 500 合法", () => {
  for (const steps of [1, 500]) {
    const hash = ShareCodec.encodeStateHash({ ...SAMPLE, max_steps: steps });
    assert.equal(ShareCodec.decodeLocationHash(hash).state.max_steps, steps);
  }
});

test("超大规则文本 -> corrupt", () => {
  const encoded = ShareCodec._encodePayload({
    ...SAMPLE,
    rules: "x".repeat(100_001),
  });
  assert.equal(
    ShareCodec.decodeLocationHash(`#v1:${encoded}`).kind,
    "corrupt"
  );
});

test("空规则 + 根路径的最小状态可往返", () => {
  const minimal = {
    rules: "",
    path: "/",
    max_steps: 100,
    follow_redirects: false,
  };
  const hash = ShareCodec.encodeStateHash(minimal);
  assert.deepEqual(ShareCodec.decodeLocationHash(hash).state, minimal);
});

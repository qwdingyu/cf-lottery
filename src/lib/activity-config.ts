/**
 * 轻量活动配置规则源。
 *
 * 这个文件是 survey/vote 等低成本玩法的唯一后端规则入口：
 * - 发布前预检用它判断配置是否足够上线。
 * - 公开参与提交用它校验 payload，并返回清洗后的 JSON。
 *
 * 约束来自 Cloudflare Workers Free + Turso Free：
 * - 不做复杂表单引擎，不新增玩法专表。
 * - 限制 JSON 体积、字段数、选项数，避免 Worker 解析大对象和 Turso 写入大 payload。
 * - 所有 id 走白名单，投票统计才能按配置选项稳定聚合。
 */

export type ActivityKindWithConfig = "survey" | "vote";

export type SurveyFieldType = "text" | "email" | "phone" | "textarea" | "select" | "radio" | "checkbox";

export type SurveyFieldConfig = {
  id: string;
  label: string;
  type: SurveyFieldType;
  required: boolean;
  maxLength: number;
  options: Array<{ id: string; label: string }>;
};

export type SurveyActivityConfigV1 = {
  version: 1;
  kind: "survey";
  fields: SurveyFieldConfig[];
};

export type VoteActivityConfigV1 = {
  version: 1;
  kind: "vote";
  selection: "single";
  options: Array<{ id: string; label: string; description: string; imageUrl: string }>;
};

export type ActivityConfigV1 = SurveyActivityConfigV1 | VoteActivityConfigV1;

export type ActivityConfigValidationIssue = {
  code: string;
  message: string;
};

export type ActivityConfigValidationResult = {
  ok: boolean;
  config?: ActivityConfigV1;
  issues: ActivityConfigValidationIssue[];
};

export type ActivityOperationalConfig = {
  /** 单活动每 IP 每分钟参与/发码上限；不配置时使用平台全局 rate_limit_join_per_minute。 */
  joinIpLimitPerMinute?: number;
  /** 单活动每身份每分钟参与上限；不配置时使用平台全局 rate_limit_join_per_minute。 */
  joinIdentityLimitPerMinute?: number;
  /** 单活动每邮箱每分钟验证码上限；不配置时使用平台全局 rate_limit_access_code。 */
  accessCodeIdentityLimitPerMinute?: number;
  /** 到开奖前 N 分钟停止新增参与；仅 drawAt 有值的定时活动生效。 */
  lockJoinBeforeDrawMinutes?: number;
};

export type SubmissionValidationResult = {
  ok: boolean;
  payload?: Record<string, unknown>;
  message?: string;
};

const MAX_CONFIG_BYTES = 12 * 1024;
const MAX_SUBMISSION_BYTES = 8 * 1024;
const MAX_SURVEY_FIELDS = 20;
const MAX_FIELD_OPTIONS = 20;
const MAX_VOTE_OPTIONS = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_TYPES = new Set<SurveyFieldType>(["text", "email", "phone", "textarea", "select", "radio", "checkbox"]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function issue(code: string, message: string): ActivityConfigValidationIssue {
  return { code, message };
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const text = String(raw || "").trim();
  if (!text || text === "{}") return null;
  if (byteLength(text) > MAX_CONFIG_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function textValue(value: unknown, max: number): string {
  return String(value || "").trim().slice(0, max);
}

function isSafePublicUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.hostname !== "localhost"
      && url.hostname !== "127.0.0.1"
      && url.href.length <= 2000;
  } catch {
    return false;
  }
}

function normalizeOptionList(raw: unknown, max: number): Array<{ id: string; label: string }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: Array<{ id: string; label: string }> = [];
  for (const item of raw.slice(0, max)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = textValue(record.id, 64);
    const label = textValue(record.label ?? record.name, 80);
    if (!ID_RE.test(id) || !label || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label });
  }
  return options;
}

function validateSurveyConfig(raw: Record<string, unknown> | null): ActivityConfigValidationResult {
  const issues: ActivityConfigValidationIssue[] = [];
  if (!raw) return { ok: false, issues: [issue("survey.config.missing", "问卷必须配置至少 1 个字段")] };

  const fieldsRaw = Array.isArray(raw.fields) ? raw.fields : [];
  if (fieldsRaw.length < 1) issues.push(issue("survey.fields.min", "问卷必须配置至少 1 个字段"));
  if (fieldsRaw.length > MAX_SURVEY_FIELDS) issues.push(issue("survey.fields.max", `问卷字段最多 ${MAX_SURVEY_FIELDS} 个`));

  const seen = new Set<string>();
  const fields: SurveyFieldConfig[] = [];
  for (const item of fieldsRaw.slice(0, MAX_SURVEY_FIELDS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(issue("survey.field.invalid", "存在无效的问卷字段配置"));
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = textValue(record.id, 64);
    const label = textValue(record.label, 80);
    const type = textValue(record.type, 20) as SurveyFieldType;
    const maxLength = Math.min(Math.max(Number(record.maxLength || (type === "textarea" ? 1000 : 120)), 1), type === "textarea" ? 2000 : 500);
    const options = normalizeOptionList(record.options, MAX_FIELD_OPTIONS);

    if (!ID_RE.test(id)) issues.push(issue("survey.field.id.invalid", "问卷字段 ID 只能包含字母、数字、下划线和短横线"));
    if (seen.has(id)) issues.push(issue("survey.field.id.duplicate", "问卷字段 ID 不能重复"));
    if (!label) issues.push(issue("survey.field.label.required", "问卷字段名称不能为空"));
    if (!FIELD_TYPES.has(type)) issues.push(issue("survey.field.type.invalid", "存在不支持的问卷字段类型"));
    if (["select", "radio", "checkbox"].includes(type) && options.length < 1) {
      issues.push(issue("survey.field.options.required", "选择类问卷字段必须配置选项"));
    }

    if (ID_RE.test(id) && !seen.has(id) && label && FIELD_TYPES.has(type)) {
      seen.add(id);
      fields.push({ id, label, type, required: Boolean(record.required), maxLength, options });
    }
  }

  return { ok: issues.length === 0, config: { version: 1, kind: "survey", fields }, issues };
}

function validateVoteConfig(raw: Record<string, unknown> | null): ActivityConfigValidationResult {
  const issues: ActivityConfigValidationIssue[] = [];
  if (!raw) return { ok: false, issues: [issue("vote.options.missing", "投票必须配置至少 2 个选项")] };

  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  if (optionsRaw.length < 2) issues.push(issue("vote.options.min", "投票至少需要 2 个选项"));
  if (optionsRaw.length > MAX_VOTE_OPTIONS) issues.push(issue("vote.options.max", `投票选项最多 ${MAX_VOTE_OPTIONS} 个`));

  const seen = new Set<string>();
  const options: VoteActivityConfigV1["options"] = [];
  for (const item of optionsRaw.slice(0, MAX_VOTE_OPTIONS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(issue("vote.option.invalid", "存在无效的投票选项配置"));
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = textValue(record.id, 64);
    const label = textValue(record.label ?? record.name, 80);
    const description = textValue(record.description, 300);
    const imageUrl = textValue(record.imageUrl, 2000);
    if (!ID_RE.test(id)) issues.push(issue("vote.option.id.invalid", "投票选项 ID 只能包含字母、数字、下划线和短横线"));
    if (seen.has(id)) issues.push(issue("vote.option.id.duplicate", "投票选项 ID 不能重复"));
    if (!label) issues.push(issue("vote.option.label.required", "投票选项名称不能为空"));
    if (!isSafePublicUrl(imageUrl)) issues.push(issue("vote.option.image_url.invalid", "投票选项图片只支持安全的 http/https 地址"));
    if (ID_RE.test(id) && !seen.has(id) && label && isSafePublicUrl(imageUrl)) {
      seen.add(id);
      options.push({ id, label, description, imageUrl });
    }
  }

  return { ok: issues.length === 0, config: { version: 1, kind: "vote", selection: "single", options }, issues };
}

function validateOperationalConfig(raw: Record<string, unknown> | null): ActivityConfigValidationIssue[] {
  if (!raw?.operational) return [];
  if (typeof raw.operational !== "object" || Array.isArray(raw.operational)) {
    return [issue("activity.operational.invalid", "活动级运营参数必须是对象")];
  }
  const operational = raw.operational as Record<string, unknown>;
  const specs: Array<{ key: keyof ActivityOperationalConfig; min: number; max: number; label: string }> = [
    { key: "joinIpLimitPerMinute", min: 1, max: 1000, label: "每 IP 每分钟参与上限" },
    { key: "joinIdentityLimitPerMinute", min: 1, max: 1000, label: "每身份每分钟参与上限" },
    { key: "accessCodeIdentityLimitPerMinute", min: 1, max: 1000, label: "每邮箱每分钟验证码上限" },
    { key: "lockJoinBeforeDrawMinutes", min: 0, max: 10080, label: "开奖前停止参与分钟数" },
  ];
  const issues: ActivityConfigValidationIssue[] = [];
  for (const spec of specs) {
    const rawValue = operational[spec.key];
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < spec.min || parsed > spec.max) {
      issues.push(issue(
        `activity.operational.${spec.key}.invalid`,
        `${spec.label} 必须是 ${spec.min} 到 ${spec.max} 之间的整数`,
      ));
    }
  }
  return issues;
}

export function validateActivityConfigForPublish(activityKind: string, rawConfig: unknown): ActivityConfigValidationResult {
  const rawText = typeof rawConfig === "string" ? rawConfig : JSON.stringify(rawConfig || {});
  if (byteLength(rawText) > MAX_CONFIG_BYTES) {
    return { ok: false, issues: [issue(`${activityKind}.config.too_large`, "活动配置过大，请减少字段或选项")] };
  }
  const raw = parseJsonObject(rawConfig);
  const operationalIssues = validateOperationalConfig(raw);
  if (activityKind !== "survey" && activityKind !== "vote") {
    return { ok: operationalIssues.length === 0, issues: operationalIssues };
  }
  const result = activityKind === "survey" ? validateSurveyConfig(raw) : validateVoteConfig(raw);
  return {
    ...result,
    ok: result.ok && operationalIssues.length === 0,
    issues: [...result.issues, ...operationalIssues],
  };
}

export function parseActivityConfig(rawConfig: unknown): ActivityConfigV1 | null {
  const raw = parseJsonObject(rawConfig);
  if (!raw) return null;
  const kind = raw.kind === "survey" ? "survey" : raw.kind === "vote" ? "vote" : "";
  if (!kind) return null;
  const result = validateActivityConfigForPublish(kind, raw);
  return result.ok && result.config ? result.config : null;
}

function optionalBoundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const n = Math.trunc(parsed);
  if (n < min || n > max) return undefined;
  return n;
}

/**
 * 解析活动级运营参数。
 *
 * 这些字段不是玩法配置的一部分，而是公开入口的运行时门禁：
 * - 不影响 survey/vote 的结构化玩法校验；
 * - 非法值 fail-soft 忽略，发布前校验/后台 UI 可再做更强提示；
 * - 所有范围都有硬上限，避免运营误填导致限流失效或无限大窗口。
 */
export function parseActivityOperationalConfig(rawConfig: unknown): ActivityOperationalConfig {
  const raw = parseJsonObject(rawConfig);
  const operational = raw?.operational && typeof raw.operational === "object" && !Array.isArray(raw.operational)
    ? raw.operational as Record<string, unknown>
    : {};
  return {
    joinIpLimitPerMinute: optionalBoundedInteger(operational.joinIpLimitPerMinute, 1, 1000),
    joinIdentityLimitPerMinute: optionalBoundedInteger(operational.joinIdentityLimitPerMinute, 1, 1000),
    accessCodeIdentityLimitPerMinute: optionalBoundedInteger(operational.accessCodeIdentityLimitPerMinute, 1, 1000),
    lockJoinBeforeDrawMinutes: optionalBoundedInteger(operational.lockJoinBeforeDrawMinutes, 0, 10080),
  };
}

function validateEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validateSubmissionPayload(activityKind: string, rawConfig: unknown, payload: unknown): SubmissionValidationResult {
  if (activityKind !== "survey" && activityKind !== "vote") {
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ok: true, payload: payload as Record<string, unknown> }
      : { ok: true, payload: undefined };
  }

  const configResult = validateActivityConfigForPublish(activityKind, rawConfig);
  if (!configResult.ok || !configResult.config) return { ok: false, message: "活动提交配置无效，请联系活动主办方" };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, message: "请填写活动提交内容" };

  const payloadText = JSON.stringify(payload);
  if (byteLength(payloadText) > MAX_SUBMISSION_BYTES) return { ok: false, message: "提交内容过大，请减少文字后重试" };

  if (configResult.config.kind === "vote") {
    const optionId = String((payload as Record<string, unknown>).optionId || "").trim();
    if (!optionId) return { ok: false, message: "请选择一个投票选项" };
    if (!configResult.config.options.some((option) => option.id === optionId)) return { ok: false, message: "投票选项无效" };
    return { ok: true, payload: { kind: "vote", optionId } };
  }

  const fieldsPayload = (payload as Record<string, unknown>).fields;
  if (!fieldsPayload || typeof fieldsPayload !== "object" || Array.isArray(fieldsPayload)) {
    return { ok: false, message: "请填写问卷内容" };
  }
  const rawFields = fieldsPayload as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const field of configResult.config.fields) {
    const value = rawFields[field.id];
    const isEmpty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (field.required && isEmpty) return { ok: false, message: `请填写：${field.label}` };
    if (isEmpty) continue;

    if (field.type === "checkbox") {
      const values = Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
      const allowed = new Set(field.options.map((option) => option.id));
      if (values.some((item) => !allowed.has(item))) return { ok: false, message: `${field.label} 包含无效选项` };
      sanitized[field.id] = values.slice(0, MAX_FIELD_OPTIONS);
      continue;
    }

    const text = String(value).trim();
    if (text.length > field.maxLength) return { ok: false, message: `${field.label} 超过长度限制` };
    if (field.type === "email" && !validateEmail(text)) return { ok: false, message: `${field.label} 邮箱格式无效` };
    if (["select", "radio"].includes(field.type) && !field.options.some((option) => option.id === text)) {
      return { ok: false, message: `${field.label} 包含无效选项` };
    }
    sanitized[field.id] = text;
  }

  return { ok: true, payload: { kind: "survey", fields: sanitized } };
}

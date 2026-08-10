/**
 * Telegram 平台适配器。
 *
 * 实现 PlatformAdapter 接口，使用 Telegram Bot API sendMessage 出站。
 * 支持：
 * - 超长消息自动分片（每段 ≤ 4000 字符，优先按段落/换行/空格分割）
 * - 指数退避重试（429 / 5xx 错误，1s 2s 4s 最大 3 次）
 * - 响应中提取 message_id
 */
import type { PlatformAdapter, PlatformMessage } from "./types";

export type TelegramAdapterEnv = {
  botToken: string;
};

/** Telegram 消息长度上限（官方 4096，保留 96 字符余量用于 HTML 标签等） */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 基础退避延迟（毫秒） */
const BASE_BACKOFF_MS = 1000;

/**
 * 单次 Telegram Bot API 请求的超时上限（毫秒）。
 *
 * 为什么必须设置超时：Telegram 出站现在由 platform_deliveries 异步投递，
 * 但维护任务仍会逐条等待 Bot API 结果；若第三方 API 长时间不返回，会拖住整轮维护任务，
 * 导致后续开奖通知、私聊卡密和重试队列延迟。8s 超时把单条投递失败有界化，
 * 失败后进入 delivery 重试状态机，而不是把整轮 maintenance 卡死。
 */
const TELEGRAM_API_TIMEOUT_MS = 8000;

/**
 * 构建 Telegram Bot API 的完整 URL。
 * 例如：https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage
 */
function buildTelegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

/**
 * 将超长文本拆分为多段，确保每段不超过 TELEGRAM_MAX_MESSAGE_LENGTH 字符。
 *
 * 分割优先级：
 * 1. 段落边界（双换行 \n\n）
 * 2. 换行边界（单换行 \n）
 * 3. 空格边界
 * 4. 强制截断（字符边界，兜底）
 */
function splitLongMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // 1. 按段落边界（双换行）分割——优先保留语义完整的段落
    let splitAt = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitAt > TELEGRAM_MAX_MESSAGE_LENGTH * 0.3) {
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt + 2);
      continue;
    }

    // 2. 按换行边界分割
    splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitAt > TELEGRAM_MAX_MESSAGE_LENGTH * 0.3) {
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt + 1);
      continue;
    }

    // 3. 按空格边界分割
    splitAt = remaining.lastIndexOf(" ", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitAt > TELEGRAM_MAX_MESSAGE_LENGTH * 0.3) {
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt + 1);
      continue;
    }

    // 4. 兜底：强制截断
    chunks.push(remaining.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH));
    remaining = remaining.slice(TELEGRAM_MAX_MESSAGE_LENGTH);
  }

  return chunks;
}

/**
 * 从 Telegram API 响应中提取 message_id。
 * 成功响应格式：{ ok: true, result: { message_id: 123, ... } }
 */
function extractMessageId(response: Record<string, unknown>): string {
  try {
    const result = response.result as Record<string, unknown> | undefined;
    if (result && typeof result.message_id !== "undefined") {
      return String(result.message_id);
    }
  } catch {
    // 忽略解析错误，兜底使用随机 ID
  }
  return crypto.randomUUID();
}

/**
 * 带指数退避的 Telegram Bot API 调用。
 *
 * 重试策略：
 * - 429（Too Many Requests）：根据 Retry-After 头或指数退避等待
 * - 5xx（服务器错误）：指数退避重试
 * - 其他错误：直接抛出，不重试
 */
async function callTelegramApi(
  apiUrl: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 每轮请求都挂一个新的 AbortSignal 超时器（AbortSignal.timeout 在
      // Cloudflare Workers / Node 18+ / 现代浏览器均可用）。
      // 超时后 fetch reject（AbortError），落入下方 catch 的网络错误分支，
      // 按 MAX_RETRIES 退避重试，全部失败后抛出——保证第三方 API 故障总是有界收敛。
      const res = await fetcher(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      });

      // 尝试解析 JSON 响应，失败时使用原始文本
      let data: Record<string, unknown>;
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        const text = await res.text().catch(() => "");
        throw new Error(`Telegram API 返回非 JSON: HTTP ${res.status} ${text.slice(0, 200)}`);
      }

      if (!res.ok) {
        const errorCode = Number(data.error_code || res.status);
        const description = String(data.description || "");

        // 429 或 5xx：可重试错误
        if (errorCode === 429 || errorCode >= 500) {
          lastError = new Error(`Telegram API 错误 ${errorCode}: ${description}`);

          // 优先使用 Retry-After 头，其次使用响应中的 retry_after 字段，最后用指数退避
          const retryAfterHeader = res.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader
            ? Number(retryAfterHeader)
            : (data.parameters as Record<string, unknown> | undefined)?.retry_after as number | undefined;

          const delayMs = retryAfterSeconds && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000 + 500
            : Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), 8000);

          if (attempt < MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
        }

        throw new Error(`Telegram API 错误 ${errorCode}: ${description}`);
      }

      // 成功响应但 ok 字段为 false（理论上不会发生，但防御性处理）
      if (data.ok === false) {
        throw new Error(`Telegram API 错误: ${JSON.stringify(data)}`);
      }

      return data;
    } catch (err) {
      // 网络错误等非 HTTP 错误：判断是否可重试
      if (err instanceof Error) {
        // 已格式化的 API 错误直接抛出（已在上面处理）
        if (err.message.startsWith("Telegram API 错误")) {
          // 如果是可重试错误且还有重试次数，继续；否则抛出
          const isRetryable = err.message.includes("429") || /5\d{2}/.test(err.message.slice(0, 20));
          if (isRetryable && attempt < MAX_RETRIES) {
            lastError = err;
            const delayMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), 8000);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw err;
        }
        // 网络错误（fetch 失败）：重试
        if (attempt < MAX_RETRIES) {
          lastError = err;
          const delayMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), 8000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      }
      throw err;
    }
  }

  throw lastError || new Error("Telegram API 调用失败");
}

export function createTelegramAdapter(
  env: TelegramAdapterEnv,
  fetcher: typeof fetch = fetch,
): PlatformAdapter {
  const botToken = env.botToken;

  return {
    platform: "telegram" as const,

    async send(message: PlatformMessage): Promise<{ messageId: string; response?: unknown }> {
      // 验证：Telegram 适配器当前只支持 text 类型
      if (message.type !== "text" || !message.text) {
        throw new Error(`Telegram 适配器暂不支持 ${message.type} 类型消息`);
      }

      const chatId = message.targetId;

      // 将超长消息拆分为多个 chunk，依次发送
      const chunks = splitLongMessage(message.text);
      let lastResult: { messageId: string; response?: unknown } = {
        messageId: crypto.randomUUID(),
      };

      for (const chunk of chunks) {
        const apiUrl = buildTelegramApiUrl(botToken, "sendMessage");
        const data = await callTelegramApi(apiUrl, {
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }, fetcher);

        lastResult = {
          messageId: extractMessageId(data),
          response: data,
        };
      }

      // 返回最后一段的 message_id（分片场景下仅代表最后一段）
      return lastResult;
    },

    async sendBatch(messages: PlatformMessage[]) {
      const results: Array<{ messageId: string; response?: unknown }> = [];
      for (const msg of messages) {
        results.push(await this.send(msg));
      }
      return results;
    },
  };
}

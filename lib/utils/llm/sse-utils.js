/**
 * 通用 SSE 解析器（参考 XRK-AGT）
 * - 以 \n\n 分隔事件，兼容多行 data:，统一 \r\n -> \n
 * - 支持 getReader 或 Symbol.asyncIterator 消费 body
 * - 上游返回 application/json 整段 JSON 时，收尾 yield 一次 { data } 供解析 message.content
 */

export async function* iterateSSE(resp, options = {}) {
  const { stopOnDone = true } = options || {};
  if (!resp?.body) return;

  const decoder = new TextDecoder('utf-8');
  const pushBuffer = (buffer, chunk) => {
    const str = typeof chunk === 'string' ? chunk : (chunk?.length ? decoder.decode(chunk) : '');
    return buffer + (str ? str.replace(/\r\n/g, '\n') : '');
  };

  let buffer = '';
  const readChunks = async function* () {
    if (typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    } else if (typeof resp.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of resp.body) yield chunk;
    }
  };

  for await (const chunk of readChunks()) {
    buffer = pushBuffer(buffer, chunk);
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = rawEvent.split('\n').map(l => l.trim()).filter(Boolean);
      const dataParts = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
      if (!dataParts.length) continue;
      const data = dataParts.join('\n');
      if (stopOnDone && data === '[DONE]') return;
      yield { event: null, data, rawEvent };
    }
  }

  const raw = buffer.trim();
  if (raw && (raw[0] === '{' || raw[0] === '[')) {
    const firstLine = raw.split('\n')[0].trim();
    if (!firstLine.startsWith('data:')) yield { event: null, data: raw };
  }
}

/** 从单条 data 解析出 content（SSE delta 或整段 JSON 的 message）；若为上游错误 JSON 则抛出 */
function parseOpenAIChatContent(data) {
  try {
    const json = typeof data === 'string' ? JSON.parse(data) : data;
    const content = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? null;
    if (typeof content === 'string' && content) return content;
    // 上游返回非 OpenAI 成功结构：识别常见错误格式并抛出，便于 HTTP 层返回给前端
    const msg = json?.msg ?? json?.message ?? json?.error?.message ?? json?.error?.msg;
    const status = json?.status ?? json?.code ?? json?.error?.code;
    if (msg && typeof msg === 'string') {
      throw new Error(status != null ? `[${status}] ${msg}` : msg);
    }
    if (json?.body == null && (json?.status != null || json?.code != null)) {
      throw new Error(json?.msg || json?.message || `上游返回错误: status=${json?.status ?? json?.code}`);
    }
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

/** 消费 OpenAI Chat Completions 流式响应，对每条 content 调用 onDelta（供所有 OpenAI 系工厂复用） */
export async function consumeOpenAIChatStream(resp, onDelta) {
  if (typeof onDelta !== 'function') return;
  for await (const { data } of iterateSSE(resp)) {
    const content = parseOpenAIChatContent(data);
    if (typeof content === 'string' && content) onDelta(content);
  }
}

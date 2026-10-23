export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  visionModel: string;
}

let currentConfig: AIConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  chatModel: 'gpt-4o-mini',
  visionModel: 'gpt-4o',
};

export function setAIConfig(config: AIConfig) {
  currentConfig = { ...config };
}

export function getAIConfig(): AIConfig {
  return { ...currentConfig };
}

// ============ SSE Stream Parser ============

async function parseSSEStream(
  response: Response,
  onChunk: (text: string) => void
): Promise<string> {
  if (!response.body) {
    throw new Error('AI 服务返回空响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6);
        if (payload === '[DONE]') return fullText;

        try {
          const json = JSON.parse(payload);
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            onChunk(content);
          }
        } catch {
          // Skip unparseable SSE lines
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return fullText;
    throw new Error(`流式读取中断: ${err instanceof Error ? err.message : '请稍后重试'}`);
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

// ============ Vision API (Image Analysis) ============

export interface VisionTextContent { type: 'text'; text: string }
export interface VisionImageContent { type: 'image_url'; image_url: { url: string } }
export type VisionContent = VisionTextContent | VisionImageContent;
export interface VisionMessage {
  role: string;
  content: string | VisionContent[];
}

export async function requestVisionStream(
  params: { text: string; imageUrl: string } | { messages: VisionMessage[] },
  onChunk: (text: string) => void,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const { signal } = options ?? {};

  if (!currentConfig.apiKey) {
    throw new Error('请先在设置中配置 API Key');
  }

  let messages: VisionMessage[];
  if ('messages' in params) {
    messages = params.messages;
  } else {
    messages = [{
      role: 'user',
      content: [
        { type: 'text', text: params.text },
        { type: 'image_url', image_url: { url: params.imageUrl } },
      ],
    }];
  }

  const response = await fetch(
    `${currentConfig.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: currentConfig.visionModel,
        messages,
        stream: true,
      }),
      signal,
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`AI 视觉服务请求失败 (${response.status}): ${errorText || '请检查 API 配置'}`);
  }

  return parseSSEStream(response, onChunk);
}

// ============ Chat API (Text Analysis) ============

export async function requestLLMStream(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const { signal } = options ?? {};

  if (!currentConfig.apiKey) {
    throw new Error('请先在设置中配置 API Key');
  }

  const response = await fetch(
    `${currentConfig.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: currentConfig.chatModel,
        messages,
        stream: true,
      }),
      signal,
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`AI 服务请求失败 (${response.status}): ${errorText || '请检查 API 配置'}`);
  }

  return parseSSEStream(response, onChunk);
}

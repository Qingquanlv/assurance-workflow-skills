// src/eval/judge/llm_client.ts — Generic HTTP client for LLM judge
//
// Supports any Anthropic-compatible endpoint via EVAL_JUDGE_API_URL
// Optional EVAL_JUDGE_API_KEY for authorization header

import * as https from 'https';
import * as http from 'http';

interface LLMClientOptions {
  apiUrl: string;
  apiKey?: string;
}

interface LLMRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
}

interface LLMResponse {
  content: string;
}

export async function callLLM(
  request: LLMRequest,
  opts: LLMClientOptions
): Promise<LLMResponse> {
  const { apiUrl, apiKey } = opts;

  // Parse URL to get host, path, protocol
  const url = new URL(apiUrl);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const requestBody = JSON.stringify(request);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `LLM API returned status ${res.statusCode}: ${data.slice(0, 500)}`
              )
            );
            return;
          }

          try {
            const parsed = JSON.parse(data);
            // Handle Anthropic-style response where content is an array
            if (Array.isArray(parsed.content) && parsed.content.length > 0) {
              const firstContent = parsed.content[0];
              if (firstContent.type === 'text') {
                resolve({ content: firstContent.text });
                return;
              }
            }
            // Handle simple response format
            if (typeof parsed.content === 'string') {
              resolve({ content: parsed.content });
              return;
            }
            reject(new Error('Unsupported response format from LLM API'));
          } catch (err) {
            reject(new Error(`Failed to parse LLM response: ${(err as Error).message}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`LLM API request failed: ${err.message}`));
    });

    req.write(requestBody);
    req.end();
  });
}

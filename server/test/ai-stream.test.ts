import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiError, chatStream } from '../src/services/ai';

/**
 * AI 流的两条硬约束：
 * 1. 分帧要能容忍 CRLF 与「最后一帧没有空行」——很多网关就是这么收尾的；
 * 2. 超时必须覆盖 body 读取阶段，否则「先回 200 再挂起」会让调用方永远等下去。
 */

interface MockOptions {
  /** 分块写出的 SSE 文本，按顺序 flush。 */
  chunks: string[];
  /** 写完 headers 后直接挂起不复用连接，用来验证读 body 阶段的超时。 */
  hang?: boolean;
}

async function withMockServer(options: MockOptions, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (options.hang) {
      // 故意不写 body、不结束响应：模拟上游把响应头吐完就卡住。
      return;
    }
    for (const chunk of options.chunks) res.write(chunk);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
}

const cfg = (apiBaseUrl: string) => ({ apiBaseUrl, apiKey: 'sk-test', model: 'mock' });

test('CRLF 分帧的 SSE 也能逐段解析', async () => {
  await withMockServer({ chunks: [delta('你好'), delta('，世界')] }, async (baseUrl) => {
    const collected: string[] = [];
    for await (const piece of chatStream(cfg(baseUrl), [{ role: 'user', content: 'hi' }])) {
      collected.push(piece);
    }
    assert.deepEqual(collected, ['你好', '，世界']);
  });
});

test('最后一帧缺少空行结尾时也要吐出来', async () => {
  const tail = `data: ${JSON.stringify({ choices: [{ delta: { content: '结尾' } }] })}`;
  await withMockServer({ chunks: [delta('开头'), tail] }, async (baseUrl) => {
    const collected: string[] = [];
    for await (const piece of chatStream(cfg(baseUrl), [{ role: 'user', content: 'hi' }])) {
      collected.push(piece);
    }
    assert.deepEqual(collected, ['开头', '结尾']);
  });
});

test('流式响应的 body 卡住时按超时失败，而不是永远等下去', async () => {
  await withMockServer({ chunks: [], hang: true }, async (baseUrl) => {
    const started = Date.now();
    await assert.rejects(
      async () => {
        for await (const _ of chatStream(cfg(baseUrl), [{ role: 'user', content: 'hi' }], {
          timeoutMs: 300,
        })) {
          // 不该产出任何内容
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof AiError);
        assert.match(err.message, /超时/);
        return true;
      },
    );
    // 超时预算 300ms，允许一点调度抖动，但不该出现「等到进程结束」的情况。
    assert.ok(Date.now() - started < 5_000);
  });
});

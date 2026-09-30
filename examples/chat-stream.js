import { connection, sse } from './client.js';

const request = await connection();
const response = await request('/v1/chat/completions', {
  model: 'default', stream: true,
  messages: [{ role: 'user', content: process.env.ACP2API_PROMPT || '请用三句话介绍 ACP。' }],
});
try {
  for await (const chunk of sse(response)) process.stdout.write(chunk.choices?.[0]?.delta.content || '');
  process.stdout.write('\n');
} finally {
  await request(`/v1/sessions/${response.headers.get('x-acp-session-id')}`, undefined, 'DELETE').catch(() => {});
}

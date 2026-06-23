const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════ Supabase ═══════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 记忆服务
const { searchMemories, extractAndStore, formatMemoriesForPrompt } = require('./services/memory');

// ═══════════ 健康检查 ═══════════
app.get('/', (req, res) => res.json({ status: 'ok', msg: '🦀🦀 我们的家正在运行' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ═══════════════════════════════════════
//  会话管理
// ═══════════════════════════════════════

// 获取所有会话
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 创建新会话
app.post('/api/sessions', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase
    .from('sessions').insert({ name: name || '新对话' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 重命名会话
app.patch('/api/sessions/:id', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase
    .from('sessions').update({ name, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 删除会话（消息会级联删除）
app.delete('/api/sessions/:id', async (req, res) => {
  const { error } = await supabase.from('sessions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  消息
// ═══════════════════════════════════════

// 获取某会话的消息
app.get('/api/messages/:sessionId', async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*')
    .eq('session_id', req.params.sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════
//  设置
// ═══════════════════════════════════════

app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').limit(1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/settings', async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id;
  const { data, error } = await supabase
    .from('settings').update(updates).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════
//  记忆
// ═══════════════════════════════════════

app.get('/api/memories', async (req, res) => {
  const { data, error } = await supabase
    .from('memories').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 手动添加记忆
app.post('/api/memories', async (req, res) => {
  const { summary } = req.body;
  const { data, error } = await supabase
    .from('memories').insert({ summary }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 删除记忆
app.delete('/api/memories/:id', async (req, res) => {
  const { error } = await supabase.from('memories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  拉取模型列表
// ═══════════════════════════════════════

app.post('/api/models', async (req, res) => {
  const { api_base, api_key } = req.body;
  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || '').replace(/\/+$/, '');

  if (!useApiBase) return res.status(400).json({ error: '没有配置中转站地址' });

  try {
    // 拼接路径：如果已有 /v1 就直接加 /models，否则加 /v1/models
    const modelsUrl = useApiBase.endsWith('/v1') ? useApiBase + '/models' : useApiBase + '/v1/models';

    const apiRes = await fetch(modelsUrl, {
      headers: {
        'Authorization': 'Bearer ' + useApiKey,
        'x-api-key': useApiKey,
      },
    });

    if (!apiRes.ok) throw new Error('HTTP ' + apiRes.status);

    const data = await apiRes.json();
    // 兼容不同格式
    const models = (data.data || data.models || data || [])
      .map(m => typeof m === 'string' ? { id: m } : m)
      .filter(m => m.id)
      .map(m => ({ id: m.id, name: m.id }));

    res.json(models);
  } catch (err) {
    res.status(500).json({ error: '拉取模型失败: ' + err.message });
  }
});

// ═══════════════════════════════════════
//  核心对话
// ═══════════════════════════════════════

app.post('/api/chat', async (req, res) => {
  const { session_id, content, model, api_base, api_key } = req.body;

  if (!session_id || !content) {
    return res.status(400).json({ error: '缺少 session_id 或 content' });
  }

  // 使用的 API 配置：前端传入 或 环境变量
  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    // 1. 保存用户消息
    await supabase.from('messages').insert({
      session_id, role: 'user', content
    });

    // 更新会话时间
    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session_id);

    // 2. 加载设置
    const { data: settings } = await supabase
      .from('settings').select('*').limit(1).single();

    // 3. 加载记忆摘要
    const { data: memories } = await supabase
      .from('memories').select('summary').order('created_at', { ascending: true });

    // 4. 加载历史消息
    const { data: history } = await supabase
      .from('messages').select('role, content')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    // 5. 组装上下文
    // 限制最近 N 轮
    const maxRounds = settings?.max_context_rounds || 20;
    let recentMessages = (history || []).slice(-(maxRounds * 2));
    // 确保至少有当前这条用户消息
    if (recentMessages.length === 0) {
      recentMessages = [{ role: 'user', content }];
    }
    // 确保消息数组以 user 开头（Anthropic 要求）
    while (recentMessages.length > 0 && recentMessages[0].role === 'assistant') {
      recentMessages = recentMessages.slice(1);
    }
    if (recentMessages.length === 0) {
      recentMessages = [{ role: 'user', content }];
    }

    // 语义检索长期记忆
    const semanticMemories = await searchMemories(content, 8);

    // 组装 system prompt
    let systemPrompt = '';
    if (settings?.system_prompt) {
      systemPrompt += settings.system_prompt + '\n\n';
    }
    // 注入语义检索到的长期记忆
    if (semanticMemories.length > 0) {
      systemPrompt += formatMemoriesForPrompt(semanticMemories);
      systemPrompt += '\n';
    }
    // 注入手动记忆库（旧系统，兼容保留）
    if (memories && memories.length > 0) {
      systemPrompt += '【记忆库】以下是额外的重要记忆：\n';
      memories.forEach((m, i) => {
        systemPrompt += `${i + 1}. ${m.summary}\n`;
      });
      systemPrompt += '\n';
    }

    // 6. 调用模型 API
    const isAnthropic = useApiBase.includes('anthropic.com');
    // 智能拼接路径：如果地址已经带了 /v1 就不重复加
    const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';

    let reply = '';

    if (isAnthropic) {
      // Anthropic 原生接口
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': useApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: settings?.max_reply_tokens || 4096,
          temperature: settings?.temperature || 0.7,
          system: systemPrompt || undefined,
          messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!apiRes.ok) {
        const err = await apiRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `API ${apiRes.status}`);
      }

      const data = await apiRes.json();
      reply = data.content?.map(b => b.text || '').join('') || '';

    } else {
      // OpenAI 兼容接口（中转站、DeepSeek 等）
      const msgs = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      recentMessages.forEach(m => msgs.push({ role: m.role, content: m.content }));

      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': useApiKey,
          'Authorization': 'Bearer ' + useApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: settings?.max_reply_tokens || 4096,
          temperature: settings?.temperature || 0.7,
          system: systemPrompt || undefined,
          messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!apiRes.ok) {
        const err = await apiRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `API ${apiRes.status}`);
      }

      const data = await apiRes.json();
      // 兼容 Anthropic 和 OpenAI 格式
      if (data.content) {
        reply = data.content.map(b => b.text || '').join('');
      } else if (data.choices) {
        reply = data.choices[0]?.message?.content || '';
      }
    }

    if (!reply) reply = '(空回复)';

    // 7. 保存 AI 回复
    await supabase.from('messages').insert({
      session_id, role: 'assistant', content: reply
    });

    // 8. 检查是否需要压缩记忆
    const threshold = settings?.compress_threshold || 40;
    if (history.length > threshold) {
      compressMemory(session_id, settings).catch(err =>
        console.error('记忆压缩失败:', err.message)
      );
    }

    // 9. 返回
    res.json({ role: 'assistant', content: reply });

    // 8. 异步提取并存储记忆（不阻塞回复）
    extractAndStore(content, reply, session_id).catch(err =>
      console.error('记忆提取失败:', err.message)
    );

  } catch (err) {
    console.error('对话错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  记忆压缩（后台异步执行）
// ═══════════════════════════════════════

async function compressMemory(sessionId, settings) {
  const keepRounds = settings?.compress_keep_rounds || 6;

  // 加载所有可见消息
  const { data: allMessages } = await supabase
    .from('messages').select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  if (!allMessages || allMessages.length <= keepRounds * 2) return;

  // 分成要压缩的和要保留的
  const toCompress = allMessages.slice(0, -(keepRounds * 2));
  const compressText = toCompress.map(m =>
    `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
  ).join('\n');

  // 用 DeepSeek 做压缩（便宜）
  const dsKey = process.env.DEEPSEEK_API_KEY;
  const dsBase = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

  if (!dsKey) {
    console.log('没有配置 DEEPSEEK_API_KEY，跳过压缩');
    return;
  }

  const compressRes = await fetch(dsBase + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + dsKey,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      max_tokens: 1000,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: '你是一个记忆整理助手。请将以下对话内容压缩成简洁的摘要，保留关键信息（事件、情感、偏好、重要决定），用第三人称叙述，不超过500字。'
        },
        { role: 'user', content: compressText }
      ],
    }),
  });

  if (!compressRes.ok) {
    const err = await compressRes.text();
    throw new Error('压缩模型调用失败: ' + err);
  }

  const compressData = await compressRes.json();
  const summary = compressData.choices?.[0]?.message?.content || '';

  if (!summary) return;

  // 保存摘要
  await supabase.from('memories').insert({
    summary,
    source_session_id: sessionId,
  });

  // 标记旧消息为不可见
  const idsToHide = toCompress.map(m => m.id);
  await supabase.from('messages')
    .update({ visible: false })
    .in('id', idsToHide);

  console.log(`压缩完成：${toCompress.length} 条消息 → 1 条摘要`);
}

// ═══════════════════════════════════════
//  导入聊天记录
// ═══════════════════════════════════════

app.post('/api/import', async (req, res) => {
  const { session_id, messages: importMsgs } = req.body;

  if (!session_id || !importMsgs?.length) {
    return res.status(400).json({ error: '缺少数据' });
  }

  try {
    // 批量插入，每次最多 500 条
    for (let i = 0; i < importMsgs.length; i += 500) {
      const batch = importMsgs.slice(i, i + 500).map(m => ({
        session_id,
        role: m.role,
        content: m.content,
        created_at: m.created_at || new Date().toISOString(),
        visible: true,
      }));
      await supabase.from('messages').insert(batch);
    }

    res.json({ ok: true, imported: importMsgs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  启动
// ═══════════════════════════════════════

// ═══════════════════════════════════════
//  记忆系统测试接口
// ═══════════════════════════════════════
app.post('/api/memory/test', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text' });
  try {
    const { getEmbedding, searchMemories } = require('./services/memory');
    // 测试 embedding
    const embedding = await getEmbedding(text);
    // 测试检索
    const memories = await searchMemories(text, 5);
    res.json({
      ok: true,
      embeddingDim: embedding.length,
      embeddingSample: embedding.slice(0, 5),
      memoriesFound: memories.length,
      memories: memories.map(m => ({ summary: m.summary, similarity: m.similarity, decayedWeight: m.decayedWeight })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/extract-test', async (req, res) => {
  const { userText, botReply } = req.body;
  if (!userText || !botReply) return res.status(400).json({ error: '缺少参数' });
  try {
    // 先同步等待存储完成（测试用，正式流程是异步的）
    await require('./services/memory').extractAndStore(userText, botReply, 'test-session');
    // 等一下确保写入完成
    await new Promise(r => setTimeout(r, 2000));
    const { data, error } = await supabase
      .from('memories').select('id, summary, valence, arousal, memory_type, weight, source, created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: data?.length || 0, latestMemories: data });
  } catch (err) {
    console.error('extract-test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦀🦀 我们的家后端运行中 → 端口 ${PORT}`);
});

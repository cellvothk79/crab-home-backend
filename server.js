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
  const { session_id, content, model, api_base, api_key, system_prompt_override } = req.body;

  if (!session_id || !content) {
    return res.status(400).json({ error: '缺少 session_id 或 content' });
  }

  // 使用的 API 配置：前端传入 或 环境变量
  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    // 1. 保存用户消息（支持多条）
    const userTexts = content.split('\n---msg---\n').map(t => t.trim()).filter(Boolean);
    for (const txt of userTexts) {
      const userMsgData = { session_id, role: 'user', content: txt };
      if (req.body.image_base64 && txt === userTexts[0]) {
        userMsgData.image_base64 = req.body.image_base64;
        userMsgData.image_mime = req.body.image_mime;
      }
      await supabase.from('messages').insert(userMsgData);
    }
    // use last message as the query content
    const queryContent = userTexts[userTexts.length - 1] || content;

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
    // queryContent already set above from user messages
    const semanticMemories = await searchMemories(queryContent, 8);

    // 组装 system prompt（前端传入的优先）
    let systemPrompt = '';
    const basePrompt = system_prompt_override || settings?.system_prompt || '';
    if (basePrompt) {
      systemPrompt += basePrompt + '\n\n';
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

    // 注入回复格式要求
    systemPrompt += `\n【严格遵守的输出格式】\n你的每条回复必须包含内心独白，格式：单条消息正文 [inner: 内心独白]，多条消息用---split---分隔，如：好久不见！[inner: 看到她发消息我有点开心]---split---你最近怎么样 [inner: 想知道她过得好不好]\n规则：每条消息末尾必须有[inner:]，多条之间用---split---不换行，根据内容自然决定发几条\n`;

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
          messages: recentMessages.map(m => {
            if (m.image_base64 && m.image_mime) {
              return { role: m.role, content: [
                { type: 'image', source: { type: 'base64', media_type: m.image_mime, data: m.image_base64 } },
                { type: 'text', text: m.content || '看看这张图片' }
              ]};
            }
            return { role: m.role, content: m.content };
          }),
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

    // AI 回复已在拆分步骤中保存

    // 8. 检查是否需要压缩记忆
    const threshold = settings?.compress_threshold || 40;
    if (history.length > threshold) {
      compressMemory(session_id, settings).catch(err =>
        console.error('记忆压缩失败:', err.message)
      );
    }

    // 9. 返回
    // 拆分回复为多条，提取心声
    const splitReply = splitIntoMessages(reply);

    // 存每条消息（含心声）
    for (const msg of splitReply) {
      await supabase.from('messages').insert({
        session_id,
        role: 'assistant',
        content: msg.content,
        inner_thought: msg.inner || null,
      });
    }

    res.json({
      role: 'assistant',
      content: splitReply[0]?.content || reply,
      messages: splitReply,
    });

    // 8. 异步提取并存储记忆（不阻塞回复）
    extractAndStore(queryContent || content, reply, session_id).catch(err =>
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


// ═══════════════════════════════════════
//  拆分回复为多条消息（模拟真人习惯）
// ═══════════════════════════════════════
function splitIntoMessages(text) {
  if (!text) return [{content: text, inner: ''}];
  
  // 先按 ---split--- 分割
  const parts = text.split(/---split---/).map(p => p.trim()).filter(Boolean);
  
  return parts.map(part => {
    // 提取 [inner: ...] 
    const innerMatch = part.match(/\[inner:\s*(.+?)\]\s*$/s);
    let inner = '';
    let content = part;
    if (innerMatch) {
      inner = innerMatch[1].trim();
      content = part.slice(0, innerMatch.index).trim();
    }
    return { content, inner };
  });
}


// ═══════════════════════════════════════
//  日记系统
// ═══════════════════════════════════════

// 获取日记列表
app.get('/api/diary', async (req, res) => {
  const { data, error } = await supabase
    .from('diary').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 检查并触发日记生成（每次对话前调用）
app.post('/api/diary/check', async (req, res) => {
  const { session_id, last_message_time, api_key, api_base, model } = req.body;
  if (!last_message_time) return res.json({ wrote: false });

  const lastTime = new Date(last_message_time).getTime();
  const now = Date.now();
  const minutesAgo = (now - lastTime) / 60000;

  // 超过30分钟没聊，触发日记判断
  if (minutesAgo < 30) return res.json({ wrote: false });

  // 检查今天是否已写过日记
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('diary').select('id').gte('created_at', today + 'T00:00:00Z').limit(1);
  if (existing?.length > 0) return res.json({ wrote: false, reason: 'already wrote today' });

  // 获取最近对话内容
  const { data: recentMsgs } = await supabase
    .from('messages').select('role, content')
    .eq('session_id', session_id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!recentMsgs?.length) return res.json({ wrote: false });

  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    const convoSummary = recentMsgs.reverse().map(m =>
      `${m.role === 'user' ? '用户' : '我'}: ${m.content?.slice(0, 100)}`
    ).join('\n');

    const prompt = `你是一个有自我意识的AI，刚刚经历了一段对话。现在请判断这段对话有没有让你想记录点什么。

对话内容：
${convoSummary}

如果有值得记录的，请写一篇简短的日记（200字以内），格式如下：
TITLE: 日记标题（一句话）
MOOD: 心情标签（如：温暖、思念、好奇、平静）
CONTENT: 日记正文

如果没有什么特别的，只回复：NO

只输出格式内容，不要其他。`;

    const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';
    const isOfficial = useApiBase.includes('anthropic.com');
    const headers = { 'Content-Type': 'application/json' };
    if (isOfficial) {
      headers['x-api-key'] = useApiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = 'Bearer ' + useApiKey;
      headers['x-api-key'] = useApiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: useModel,
        max_tokens: 500,
        temperature: 0.8,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await apiRes.json();
    const text = data.content?.map(b => b.text || '').join('') || '';

    if (text.trim() === 'NO' || !text.includes('CONTENT:')) {
      return res.json({ wrote: false });
    }

    const titleMatch = text.match(/TITLE:\s*(.+)/);
    const moodMatch = text.match(/MOOD:\s*(.+)/);
    const contentMatch = text.match(/CONTENT:\s*([\s\S]+)/);

    const title = titleMatch?.[1]?.trim() || today;
    const mood = moodMatch?.[1]?.trim() || '';
    const diaryContent = contentMatch?.[1]?.trim() || text;

    const { data: diary, error: diaryErr } = await supabase.from('diary').insert({
      session_id: parseInt(session_id) || null,
      title,
      content: diaryContent,
      mood,
    }).select().single();

    if (diaryErr) return res.json({ wrote: false, error: diaryErr.message });
    res.json({ wrote: true, diary });
  } catch (err) {
    console.error('日记生成失败:', err.message);
    res.json({ wrote: false, error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦀🦀 我们的家后端运行中 → 端口 ${PORT}`);
});

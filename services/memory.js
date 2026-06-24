const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

// ═══════════════════════════════════════
//  生成 embedding 向量（走 OpenAI 官方）
// ═══════════════════════════════════════
async function getEmbedding(text) {
  if (!OPENAI_API_KEY) throw new Error('未配置 OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000), // 防止超长
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error('Embedding 失败: ' + (e.error?.message || res.status));
  }
  const data = await res.json();
  return data.data[0].embedding; // float[]
}

// ═══════════════════════════════════════
//  计算衰减后的权重
// ═══════════════════════════════════════
function calcDecayedWeight(memory) {
  if (memory.memory_type === 'core') return 999;

  const now = Date.now();
  const created = new Date(memory.created_at).getTime();
  const lastAccessed = new Date(memory.last_accessed || memory.created_at).getTime();

  const daysSinceCreated = (now - created) / (1000 * 60 * 60 * 24);
  const daysSinceAccessed = (now - lastAccessed) / (1000 * 60 * 60 * 24);

  const arousal = memory.arousal || 0.5;
  const baseWeight = memory.weight || 1.0;

  // 遗忘曲线：高唤醒度衰减更慢
  const decayRate = 0.05 * (1 - arousal * 0.6);
  const timeDecay = Math.exp(-decayRate * daysSinceAccessed);

  // 被访问越多、越近越权重越高
  const accessBonus = 1 + arousal * 0.8;

  return baseWeight * timeDecay * accessBonus;
}

// ═══════════════════════════════════════
//  语义检索：用用户消息找相关记忆
// ═══════════════════════════════════════
async function searchMemories(userText, limit = 8) {
  if (!OPENAI_API_KEY) return [];

  try {
    const embedding = await getEmbedding(userText);

    // 调用 Supabase 的向量检索函数
    const { data, error } = await supabase.rpc('search_memories', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: limit * 2, // 多取一些，后面按衰减权重再排
    });

    if (error) {
      console.error('记忆检索失败:', error.message);
      return [];
    }

    if (!data || data.length === 0) return [];

    // 按衰减权重重排，取前 limit 条
    const ranked = data
      .map(m => ({
        ...m,
        decayedWeight: calcDecayedWeight(m) * (m.similarity || 0.5),
      }))
      .sort((a, b) => b.decayedWeight - a.decayedWeight)
      .slice(0, limit);

    // 更新 last_accessed（异步，不阻塞）
    const ids = ranked.map(m => m.id);
    supabase.from('memories')
      .update({ last_accessed: new Date().toISOString() })
      .in('id', ids)
      .then(() => {})
      .catch(() => {});

    return ranked;
  } catch (err) {
    console.error('searchMemories 错误:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════
//  提取并存储记忆（每轮对话后异步调用）
// ═══════════════════════════════════════
async function extractAndStore(userText, botReply, sessionId) {
  const apiKey = DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY || '';
  if (!apiKey || !OPENAI_API_KEY) return;

  const isDeepSeek = !!DEEPSEEK_API_KEY;
  const apiBase = isDeepSeek ? DEEPSEEK_API_BASE :
    (process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = isDeepSeek ? 'deepseek-chat' : (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6');

  const prompt = `你是一个记忆提取助手。分析下面这段对话，提取值得长期记住的信息。

对话内容：
用户：${userText}
AI：${botReply}

请以 JSON 数组格式返回记忆条目，每条包含：
- summary: 记忆内容（用叙事带情境的方式写，20-40字，第一人称描述AI视角，如"她提到想吃豆芽拌饭时语气很馋，这是她反复说起的食物，应该是真的很喜欢"，不要写成标签式的"用户喜欢XX"）
- valence: 情感效价 -1到1（负面到正面）
- arousal: 唤醒度 0到1（平静到激动）
- memory_type: "core"（重要的身份信息/深层偏好/关系认知）或 "episodic"（普通事件/日常细节）
- category: "daily"（日常生活/情感/偏好/习惯）或 "work"（工作/项目/技术）或 "event"（具体事件/约定/计划）
- tags: 标签数组，如 ["食物", "偏好"]

如果这段对话没有值得记忆的信息（比如只是打招呼、闲聊、简单问答），返回空数组 []。
只返回 JSON，不要其他内容。`;

  try {
    let reply = '';

    if (isDeepSeek) {
      const res = await fetch(apiBase + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      reply = data.choices?.[0]?.message?.content || '[]';
    } else {
      const apiUrl = apiBase.endsWith('/v1') ? apiBase + '/messages' : apiBase + '/v1/messages';
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      reply = data.content?.map(b => b.text || '').join('') || '[]';
    }

    // 解析 JSON
    const clean = reply.replace(/```json|```/g, '').trim();
    let items = [];
    try {
      const parsed = JSON.parse(clean);
      items = Array.isArray(parsed) ? parsed : (parsed.memories || parsed.items || []);
    } catch (e) {
      console.log('记忆提取解析失败:', clean.slice(0, 100));
      return;
    }

    if (!items.length) return;

    // 为每条记忆生成 embedding，去重比对后存入数据库
    for (const item of items) {
      if (!item.summary) continue;
      try {
        const embedding = await getEmbedding(item.summary);

        // ── 去重：搜索相似度 > 0.85 的已有记忆 ──
        const { data: similar } = await supabase.rpc('search_memories', {
          query_embedding: embedding,
          match_threshold: 0.70,
          match_count: 1,
        });

        if (similar && similar.length > 0) {
          // 已有相似记忆，更新而不是新建
          const existing = similar[0];
          const merged = existing.summary + '；' + item.summary;
          const mergedEmbedding = await getEmbedding(merged.slice(0, 200));
          await supabase.from('memories').update({
            summary: merged.slice(0, 200),
            embedding: mergedEmbedding,
            valence: ((existing.valence || 0) + (item.valence || 0)) / 2,
            arousal: Math.max(existing.arousal || 0.5, item.arousal || 0.5),
            last_accessed: new Date().toISOString(),
            weight: Math.min((existing.weight || 1) + 0.2, 3.0), // 被强化，权重增加
          }).eq('id', existing.id);
          console.log('记忆强化:', existing.summary.slice(0, 30));
          continue;
        }

        // ── 新记忆，直接写入 ──
        const insertData = {
          summary: item.summary,
          valence: Math.max(-1, Math.min(1, item.valence || 0)),
          arousal: Math.max(0, Math.min(1, item.arousal || 0.5)),
          memory_type: item.memory_type === 'core' ? 'core' : 'episodic',
          category: ['daily', 'work', 'event'].includes(item.category) ? item.category : 'daily',
          weight: 1.0,
          last_accessed: new Date().toISOString(),
          embedding,
          source: 'chat',
          tags: Array.isArray(item.tags) ? item.tags : [],
        };
        const sessionIdNum = parseInt(sessionId);
        if (!isNaN(sessionIdNum)) insertData.source_session_id = sessionIdNum;

        const { error: insertErr } = await supabase.from('memories').insert(insertData);
        if (insertErr) {
          console.error('记忆写入失败:', insertErr.message, insertErr.details);
        } else {
          console.log('记忆存储:', item.summary.slice(0, 30));
        }
      } catch (e) {
        console.error('记忆存储失败:', e.message);
      }
    }
  } catch (err) {
    console.error('extractAndStore 错误:', err.message);
  }
}

// ═══════════════════════════════════════
//  把检索到的记忆格式化成 system prompt 片段
// ═══════════════════════════════════════
function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  const lines = memories.map((m, i) => {
    const emotion = m.valence > 0.3 ? '😊' : m.valence < -0.3 ? '😔' : '😐';
    return `${i + 1}. ${m.summary} ${emotion}`;
  });
  return '【长期记忆】以下是关于用户的重要记忆，请自然地记住这些，不要刻意提及"记忆"这个词：\n' + lines.join('\n') + '\n';
}

module.exports = { searchMemories, extractAndStore, formatMemoriesForPrompt, getEmbedding };

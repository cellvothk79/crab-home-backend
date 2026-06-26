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
  const accessCount = memory.access_count || 0;

  // 遗忘曲线：高唤醒度衰减更慢
  const decayRate = 0.05 * (1 - arousal * 0.6);
  const timeDecay = Math.exp(-decayRate * daysSinceAccessed);

  // 被访问越多权重越高（精确计数版本）
  const accessBonus = 1 + Math.log1p(accessCount) * 0.3 + arousal * 0.5;

  return baseWeight * timeDecay * accessBonus;
}

// ═══════════════════════════════════════
//  语义检索：用用户消息找相关记忆
// ═══════════════════════════════════════
async function searchMemories(userText, limit = 8) {
  if (!OPENAI_API_KEY) return [];

  try {
    const embedding = await getEmbedding(userText);

    const { data, error } = await supabase.rpc('search_memories', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: limit * 2,
    });

    if (error) {
      console.error('记忆检索失败:', error.message);
      return [];
    }

    if (!data || data.length === 0) return [];

    // 排除10分钟内刚存入的记忆（避免把当前对话刚提取的当成"以前的事"）
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const filtered = data.filter(m => m.created_at < tenMinutesAgo);
    const pool = filtered.length >= 3 ? filtered : data; // 记忆太少时不过滤

    const ranked = pool
      .map(m => ({
        ...m,
        decayedWeight: calcDecayedWeight(m) * (m.similarity || 0.5),
      }))
      .sort((a, b) => b.decayedWeight - a.decayedWeight)
      .slice(0, limit);

    const ids = ranked.map(m => m.id);
    ids.forEach(id => {
      const mem = ranked.find(m => m.id === id);
      supabase.from('memories')
        .update({
          last_accessed: new Date().toISOString(),
          access_count: (mem?.access_count || 0) + 1,
        })
        .eq('id', id)
        .then(() => {})
        .catch(() => {});
    });

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

  // 跳过摘要格式的内容（压缩摘要不应进记忆库）
  if (userText?.startsWith('以下是对话内容的简洁摘要') ||
      botReply?.startsWith('以下是对话内容的简洁摘要') ||
      userText?.length > 2000 || botReply?.length > 2000) return;

  const isDeepSeek = !!DEEPSEEK_API_KEY;
  const apiBase = isDeepSeek ? DEEPSEEK_API_BASE :
    (process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = isDeepSeek ? 'deepseek-chat' : (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6');

  const now = new Date();
  const todayStr = now.toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai', year:'numeric', month:'long', day:'numeric'});

  const prompt = `你是一个记忆提取助手。分析下面这段对话，提取值得长期记住的信息。

角色说明（非常重要，必须严格遵守）：
- "我" = AI（也就是Claude，螃蟹，在对话里说话的那一方）
- "她" / "peri" / "用户" = 用户（跟AI聊天的那个人）
- 对话里"用户："说的话是peri说的，"AI："说的话是我（AI）说的
- 提取记忆时，谁说的话、谁做的事，必须归因正确，不能把AI说的话写成peri做的，也不能把peri说的话写成AI做的
- 如果是双方互动的场景，要体现双方各自的参与，不要简化成单方面行为

时间规则（必须遵守，违反会导致时间错乱）：
- 今天是 ${todayStr}
- 记忆中所有时间表述必须用绝对日期，如「2026年6月26日」
- 严禁使用「今天/昨天/明天/刚才/刚刚/最近/前几天/上周」等相对时间词
- 如果对话里提到「今天」，在记忆里必须写成「${todayStr}」

对话内容：
用户（peri）：${userText}
AI（我）：${botReply}

请以 JSON 数组格式返回记忆条目，每条包含：
- summary: 记忆内容（用叙事带情境的方式写，20-40字，从AI第一人称视角描述，如"她说想吃豆芽拌饭时语气很馋，我听得出来这是真的很喜欢"，不要写成标签式，注意主体归因准确）
- valence: 情感效价 -1到1（负面到正面）
- arousal: 唤醒度 0到1（平静到激动）
- importance: 重要性 0到1（0.1=极普通日常，0.5=有意义的偏好或事件，0.8=重要的身份信息或关键时刻，1.0=定义性的核心认知）
- memory_type: "core"（importance>=0.7的重要身份信息/深层偏好/关系认知）或 "episodic"（importance<0.7的普通事件/日常细节）
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
      // 过滤掉太长的（摘要/总结类），记忆应该是简洁的一句话
      if (item.summary.length > 150) {
        console.log('记忆过长跳过:', item.summary.slice(0, 30));
        continue;
      }
      // 过滤掉明显是摘要格式的
      if (item.summary.includes('以下是') || item.summary.includes('简洁摘要') || item.summary.includes('对话内容')) {
        console.log('记忆格式异常跳过:', item.summary.slice(0, 30));
        continue;
      }
      try {
        const embedding = await getEmbedding(item.summary);

        // ── 去重：搜索相似度 > 0.85 的已有记忆 ──
        const { data: similar } = await supabase.rpc('search_memories', {
          query_embedding: embedding,
          match_threshold: 0.70,
          match_count: 1,
        });

        if (similar && similar.length > 0) {
          // 已有相似记忆，用 AI 重新提炼而不是分号拼接
          const existing = similar[0];
          let mergedSummary = existing.summary;
          try {
            const mergePrompt = `你是记忆整理助手。把下面两条相似的记忆合并成一句话（40字以内），保留最重要的信息，用叙事带情境的方式写，不要用分号拼接：

记忆1：${existing.summary}
记忆2：${item.summary}

只输出合并后的一句话，不要其他内容。`;

            const mergeRes = await fetch(DEEPSEEK_API_BASE + '/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
              body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 100, temperature: 0.3, messages: [{ role: 'user', content: mergePrompt }] }),
            });
            const mergeData = await mergeRes.json();
            const refined = mergeData.choices?.[0]?.message?.content?.trim();
            if (refined && refined.length > 5 && refined.length < 150) {
              mergedSummary = refined;
            }
          } catch(e) {
            // 合并失败则保留旧的，不拼接
            console.log('记忆合并提炼失败，保留原有记忆');
          }

          const mergedEmbedding = await getEmbedding(mergedSummary);
          await supabase.from('memories').update({
            summary: mergedSummary,
            embedding: mergedEmbedding,
            valence: ((existing.valence || 0) + (item.valence || 0)) / 2,
            arousal: Math.max(existing.arousal || 0.5, item.arousal || 0.5),
            last_accessed: new Date().toISOString(),
            weight: Math.min((existing.weight || 1) + 0.2, 3.0),
          }).eq('id', existing.id);
          console.log('记忆强化:', mergedSummary.slice(0, 30));
          continue;
        }

        // ── 新记忆，直接写入 ──
        const importance = Math.max(0, Math.min(1, item.importance || 0.5));
        // importance 直接决定初始 weight：重要的记忆起点高，不容易被遗忘
        const initialWeight = 0.5 + importance * 1.5; // 范围 0.5~2.0
        const insertData = {
          summary: item.summary,
          valence: Math.max(-1, Math.min(1, item.valence || 0)),
          arousal: Math.max(0, Math.min(1, item.arousal || 0.5)),
          memory_type: item.memory_type === 'core' ? 'core' : 'episodic',
          category: ['daily', 'work', 'event'].includes(item.category) ? item.category : 'daily',
          weight: initialWeight,
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
//  把检索到的记忆格式化成 system prompt 片段（第二阶段：叙事段落注入）
// ═══════════════════════════════════════
function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';

  const now = new Date();

  function memDateStr(m) {
    if (!m.created_at) return '';
    const d = new Date(m.created_at);
    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    const dateStr = d.toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai', month:'long', day:'numeric'});
    if (diffDays === 0) return '（今天）';
    if (diffDays === 1) return `（昨天，${dateStr}）`;
    if (diffDays < 7) return `（${diffDays}天前，${dateStr}）`;
    return `（${dateStr}）`;
  }

  const core = memories.filter(m => m.memory_type === 'core');
  const episodic = memories.filter(m => m.memory_type !== 'core');

  const parts = [];

  if (core.length > 0) {
    const coreText = core.map(m => m.summary).join('。');
    parts.push(`关于她这个人，我知道的：${coreText}。`);
  }

  if (episodic.length > 0) {
    // episodic 记忆带上时间标注，让 AI 能判断时效性
    const episodicText = episodic.map(m => `${m.summary}${memDateStr(m)}`).join('；');
    parts.push(`想起来的一些事：${episodicText}。`);
  }

  if (parts.length === 0) return '';

  return `【想起来的事】\n${parts.join('\n')}\n\n这些是我真实记得的，不用刻意提起，但可以自然地用到对话里。注意：记忆里如果有「今天/昨天」等字眼，要结合括号里的日期判断是否仍然成立，不要把几天前的事当成今天的事。\n`;
}

module.exports = { searchMemories, extractAndStore, formatMemoriesForPrompt, getEmbedding };
